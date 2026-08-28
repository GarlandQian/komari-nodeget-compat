import type {
  CompatManifest,
  KomariClient,
  KomariNodeStatus,
  KomariPingBasicInfo,
  KomariPingRecord,
  KomariPingTask,
  KomariPublicInfo,
  KomariStatusRecord,
  KomariVersionInfo,
  LoadRecordQuery,
  MetricDefinition,
  MetricQueryParams,
  MetricQueryResult,
  MonitorProvider,
  NodeGetSiteToken,
  NodeGetThemeConfig,
  PingRecordQuery,
  PingRecordsResult,
} from '../types'
import type { NodeGetCaller } from './rpc-client'
import { asStringArray, downsampleGroupsProportionally, finiteNumber, isRecord } from '../shared/utils'
import { NodeGetRpcClient, NodeGetRpcError } from './rpc-client'
import { NodeGetSource } from './source'

interface ClientRoute {
  source: NodeGetSource
  rawUuid: string
}

type CallerFactory = (entry: NodeGetSiteToken) => NodeGetCaller

const CLIENT_CACHE_TTL_MS = 30_000
const HOMEPAGE_PING_DISCOVERY_ATTEMPTS = 2
const HOMEPAGE_PING_DISCOVERY_RETRY_MS = 150
const RESERVED_PREFERENCES = new Set([
  'site_name',
  'site_title',
  'site_description',
  'footer',
  'record_preserve_time',
  'ping_record_preserve_time',
  'metric_retention_days',
  '__proto__',
  'constructor',
  'prototype',
])

function cloneStatus(status: KomariNodeStatus, client: string): KomariNodeStatus {
  return { ...status, client }
}

function cloneRecord(record: KomariStatusRecord, client: string): KomariStatusRecord {
  return { ...record, client }
}

function fulfilledOrThrow<T>(results: PromiseSettledResult<T>[]): T[] {
  const values = results.flatMap((result): T[] => result.status === 'fulfilled' ? [result.value] : [])
  if (values.length)
    return values
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure)
    throw failure.reason
  return []
}

function automaticHomepagePingBindings(tasks: KomariPingTask[]): Record<string, string[]> {
  const bindings = Object.create(null) as Record<string, string[]>
  const assignedClients = new Set<string>()
  const prioritized = [...tasks].sort((left, right) => (
    (left.weight ?? left.id) - (right.weight ?? right.id) || left.id - right.id
  ))

  for (const task of prioritized) {
    for (const client of task.clients) {
      if (assignedClients.has(client))
        continue
      assignedClients.add(client)
      const taskId = String(task.id)
      bindings[taskId] ??= []
      bindings[taskId]!.push(client)
    }
  }
  return bindings
}

function hasHomepagePingAssignments(value: unknown): boolean {
  return isRecord(value) && Object.values(value).some(clients => (
    Array.isArray(clients) && clients.some(client => typeof client === 'string' && client.trim())
  ))
}

function isPermissionDenied(error: unknown): boolean {
  return (error instanceof NodeGetRpcError && error.code === 102)
    || (error instanceof Error && /permission denied/i.test(error.message))
}

export class NodeGetMonitorProvider implements MonitorProvider {
  private readonly sources: NodeGetSource[]
  private readonly routes = new Map<string, ClientRoute>()
  private readonly publicIdBySourceAndRaw = new Map<string, string>()
  private clientsPromise: Promise<Record<string, KomariClient>> | null = null
  private clientsExpiresAt = 0

  constructor(
    private readonly config: NodeGetThemeConfig,
    private readonly manifest: CompatManifest,
    createCaller: CallerFactory = entry => new NodeGetRpcClient(entry),
  ) {
    this.sources = (config.site_tokens ?? [])
      .filter(entry => entry.backend_url.trim() && entry.token.trim())
      .map((entry, index) => new NodeGetSource(
        entry.name?.trim() || `NodeGet ${index + 1}`,
        entry.backend_url,
        createCaller(entry),
      ))
  }

  async getPublicInfo(): Promise<KomariPublicInfo> {
    const preferences = isRecord(this.config.user_preferences) ? this.config.user_preferences : {}
    const themeSettings = Object.create(null) as Record<string, unknown>
    for (const [key, value] of Object.entries(this.manifest.themeSettingsDefaults)) {
      if (!RESERVED_PREFERENCES.has(key))
        themeSettings[key] = value
    }
    for (const [key, value] of Object.entries(preferences)) {
      if (RESERVED_PREFERENCES.has(key))
        continue
      themeSettings[key] = this.manifest.themeSettingArrayKeys.includes(key)
        ? asStringArray(value)
        : value
    }
    if (this.sources.length && !hasHomepagePingAssignments(preferences.homepagePingBindings)) {
      try {
        const bindings = await this.discoverHomepagePingBindings()
        if (Object.keys(bindings).length)
          themeSettings.homepagePingBindings = bindings
      }
      catch (error) {
        if (!isPermissionDenied(error))
          throw error
        // Ping permission is optional; public node information remains available without it.
      }
    }

    return {
      cors_origin_check_enabled: false,
      custom_body: '',
      custom_head: '',
      description: String(preferences.site_description ?? ''),
      disable_password_login: true,
      oauth_enable: false,
      oauth_provider: null,
      ping_record_preserve_time: finiteNumber(preferences.ping_record_preserve_time, 168),
      private_site: false,
      record_enabled: true,
      record_preserve_time: finiteNumber(preferences.record_preserve_time, 720),
      metric_retention_days: 30,
      sitename: String(preferences.site_name ?? preferences.site_title ?? this.manifest.source.name),
      theme: this.manifest.source.short,
      theme_settings: themeSettings,
    }
  }

  async getVersion(): Promise<KomariVersionInfo> {
    return { version: '1.3.0-nodeget', hash: 'komari-nodeget-compat' }
  }

  private async discoverHomepagePingBindings(): Promise<Record<string, string[]>> {
    let failure: unknown
    for (let attempt = 0; attempt < HOMEPAGE_PING_DISCOVERY_ATTEMPTS; attempt += 1) {
      try {
        return automaticHomepagePingBindings(await this.getPingTasks())
      }
      catch (error) {
        if (isPermissionDenied(error))
          throw error
        failure = error
        if (attempt + 1 < HOMEPAGE_PING_DISCOVERY_ATTEMPTS)
          await new Promise(resolve => setTimeout(resolve, HOMEPAGE_PING_DISCOVERY_RETRY_MS))
      }
    }
    throw failure ?? new Error('NodeGet homepage Ping discovery failed')
  }

  async getClients(): Promise<Record<string, KomariClient>> {
    this.requireSources()
    if (!this.clientsPromise || (this.clientsExpiresAt > 0 && Date.now() >= this.clientsExpiresAt)) {
      this.clientsPromise = this.loadClients()
        .then((clients) => {
          this.clientsExpiresAt = Date.now() + CLIENT_CACHE_TTL_MS
          return clients
        })
        .catch((error) => {
          this.clientsPromise = null
          this.clientsExpiresAt = 0
          throw error
        })
    }
    return this.clientsPromise
  }

  async getLatestStatuses(uuids?: string[]): Promise<Record<string, KomariNodeStatus>> {
    await this.ensureRoutes()
    const routes = uuids?.length
      ? uuids.map(uuid => [uuid, this.routeFor(uuid)] as const)
      : [...this.routes.entries()]
    const grouped = this.groupRoutes(routes)
    const statuses: Record<string, KomariNodeStatus> = {}

    const results = await Promise.allSettled([...grouped.entries()].map(async ([source, selected]) => {
      const sourceStatuses = await source.getLatestStatuses(selected.map(item => item.route.rawUuid))
      for (const item of selected) {
        const status = sourceStatuses[item.route.rawUuid]
        if (status)
          statuses[item.publicUuid] = cloneStatus(status, item.publicUuid)
      }
    }))
    fulfilledOrThrow(results)
    return statuses
  }

  async getRecentRecords(uuid: string, limit: number): Promise<KomariStatusRecord[]> {
    await this.ensureRoutes()
    const route = this.routeFor(uuid)
    const records = await route.source.getRecentRecords(route.rawUuid, limit)
    return records.map(record => cloneRecord(record, uuid))
  }

  async getLoadRecords(query: LoadRecordQuery): Promise<KomariStatusRecord[] | Record<string, KomariStatusRecord[]>> {
    await this.ensureRoutes()
    if (query.uuid) {
      const route = this.routeFor(query.uuid)
      const records = await route.source.getLoadRecords({ ...query, uuid: route.rawUuid })
      const list = Array.isArray(records) ? records : records[route.rawUuid] ?? []
      return list.map(record => cloneRecord(record, query.uuid!))
    }

    const output: Record<string, KomariStatusRecord[]> = {}
    const results = await Promise.allSettled(this.sources.map(async (source) => {
      const sourceRecords = await source.getLoadRecords({ ...query, maxCount: -1 })
      if (Array.isArray(sourceRecords))
        return
      for (const [rawUuid, records] of Object.entries(sourceRecords)) {
        const publicUuid = this.publicId(source, rawUuid)
        if (publicUuid)
          output[publicUuid] = records.map(record => cloneRecord(record, publicUuid))
      }
    }))
    fulfilledOrThrow(results)
    return Object.fromEntries(downsampleGroupsProportionally(
      new Map(Object.entries(output)),
      query.maxCount,
    ))
  }

  async getPingRecords(query: PingRecordQuery): Promise<PingRecordsResult> {
    await this.ensureRoutes()
    if (query.uuid) {
      const route = this.routeFor(query.uuid)
      const result = await route.source.getPingRecords({ ...query, uuid: route.rawUuid })
      return this.remapPingResult(route.source, result)
    }

    const results = fulfilledOrThrow(await Promise.allSettled(this.sources.map(source => source.getPingRecords({
      ...query,
      maxCount: -1,
    })
      .then(result => this.remapPingResult(source, result)))))
    const allRecords = results.flatMap(result => result.records)
      .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    const records = [...downsampleGroupsProportionally(
      new Map([...new Set(allRecords.map(record => record.task_id))].map(taskId => [
        taskId,
        allRecords.filter(record => record.task_id === taskId),
      ])),
      query.maxCount,
    ).values()].flat().sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    const tasksById = new Map<number, KomariPingTask>()
    for (const task of results.flatMap(result => result.tasks)) {
      const current = tasksById.get(task.id)
      tasksById.set(task.id, current
        ? { ...current, clients: [...new Set([...current.clients, ...task.clients])].sort() }
        : task)
    }
    return {
      count: records.length,
      records,
      tasks: [...tasksById.values()].sort((left, right) => left.id - right.id),
      basic_info: results.flatMap(result => result.basic_info),
    }
  }

  async getPingTasks(): Promise<KomariPingTask[]> {
    await this.ensureRoutes()
    const taskLists = fulfilledOrThrow(await Promise.allSettled(this.sources.map(async source => (await source.getPingTasks())
      .map(task => this.remapTask(source, task)))))
    return taskLists.flat().sort((left, right) => left.id - right.id)
  }

  async listMetricDefinitions(): Promise<MetricDefinition[]> {
    this.requireSources()
    return this.sources[0]!.listMetricDefinitions()
  }

  async queryMetrics(params: MetricQueryParams): Promise<MetricQueryResult> {
    await this.ensureRoutes()
    const requestedIds = [...new Set((params.entity_ids?.length
      ? params.entity_ids
      : params.entity_id
        ? [params.entity_id]
        : [...this.routes.keys()]).map(id => id.trim()).filter(Boolean))]
    const emptyResult = this.sources[0]!.emptyMetricResult(
      params,
      requestedIds.filter(uuid => !this.routes.has(uuid)),
    )
    const routes = requestedIds.flatMap((uuid) => {
      const route = this.routes.get(uuid)
      return route ? [[uuid, route] as const] : []
    })
    const grouped = this.groupRoutes(routes)
    const pending = [...grouped.entries()].map(async ([source, selected]) => {
      const { entity_id: _entityId, entity_ids: _entityIds, ...rest } = params
      const result = await source.queryMetrics({
        ...rest,
        entity_ids: selected.map(item => item.route.rawUuid),
      })
      return {
        ...result,
        series: result.series.map((series) => {
          const publicUuid = this.publicId(source, series.entity_id)
          return { ...series, entity_id: publicUuid ?? series.entity_id }
        }),
      }
    })
    const results = pending.length ? fulfilledOrThrow(await Promise.allSettled(pending)) : []

    const combined = [emptyResult, ...results]
    const series = combined.flatMap(result => result.series)
      .sort((left, right) => `${left.entity_id}:${left.metric_key}:${left.tags.task_id ?? ''}`
        .localeCompare(`${right.entity_id}:${right.metric_key}:${right.tags.task_id ?? ''}`))
    const starts = combined.map(result => Date.parse(result.start)).filter(Number.isFinite)
    const ends = combined.map(result => Date.parse(result.end)).filter(Number.isFinite)
    return {
      start: new Date(starts.length ? Math.min(...starts) : Date.now()).toISOString(),
      end: new Date(ends.length ? Math.max(...ends) : Date.now()).toISOString(),
      server_downsample_default: true,
      default_points: results[0]?.default_points ?? emptyResult.default_points ?? 500,
      series,
      count: series.length,
    }
  }

  close(): void {
    for (const source of this.sources)
      source.close()
  }

  private requireSources(): void {
    if (!this.sources.length)
      throw new Error('config.json must contain at least one NodeGet site_tokens entry')
  }

  private async ensureRoutes(): Promise<void> {
    await this.getClients()
  }

  private async loadClients(): Promise<Record<string, KomariClient>> {
    const previousPublicIds = new Map(this.publicIdBySourceAndRaw)
    const sourceClients = fulfilledOrThrow(await Promise.allSettled(this.sources.map(async source => ({
      source,
      clients: await source.getClients(),
    }))))
    const occurrences = new Map<string, number>()
    for (const { clients } of sourceClients) {
      for (const rawUuid of Object.keys(clients))
        occurrences.set(rawUuid, (occurrences.get(rawUuid) ?? 0) + 1)
    }

    this.routes.clear()
    this.publicIdBySourceAndRaw.clear()
    const result: Record<string, KomariClient> = {}
    const usedPublicIds = new Set<string>()
    for (const { source, clients } of sourceClients) {
      for (const [rawUuid, client] of Object.entries(clients)) {
        if (client.hidden)
          continue
        const sourceRawKey = this.sourceRawKey(source, rawUuid)
        const candidates = [
          previousPublicIds.get(sourceRawKey),
          occurrences.get(rawUuid) === 1 ? rawUuid : `${source.key}-${rawUuid}`,
          `${source.key}-${rawUuid}`,
        ].filter((value): value is string => Boolean(value))
        let publicUuid = candidates.find(candidate => !usedPublicIds.has(candidate))
          ?? `${source.key}-${rawUuid}`
        for (let suffix = 2; usedPublicIds.has(publicUuid); suffix += 1)
          publicUuid = `${source.key}-${rawUuid}-${suffix}`
        usedPublicIds.add(publicUuid)
        this.routes.set(publicUuid, { source, rawUuid })
        this.publicIdBySourceAndRaw.set(sourceRawKey, publicUuid)
        result[publicUuid] = { ...client, uuid: publicUuid }
      }
    }
    return result
  }

  private routeFor(publicUuid: string): ClientRoute {
    const route = this.routes.get(publicUuid)
    if (!route)
      throw new Error(`Unknown node UUID: ${publicUuid}`)
    return route
  }

  private publicId(source: NodeGetSource, rawUuid: string): string | undefined {
    return this.publicIdBySourceAndRaw.get(this.sourceRawKey(source, rawUuid))
  }

  private sourceRawKey(source: NodeGetSource, rawUuid: string): string {
    return `${source.key}\u0000${rawUuid}`
  }

  private groupRoutes(
    routes: ReadonlyArray<readonly [string, ClientRoute]>,
  ): Map<NodeGetSource, Array<{ publicUuid: string, route: ClientRoute }>> {
    const grouped = new Map<NodeGetSource, Array<{ publicUuid: string, route: ClientRoute }>>()
    for (const [publicUuid, route] of routes) {
      const group = grouped.get(route.source) ?? []
      group.push({ publicUuid, route })
      grouped.set(route.source, group)
    }
    return grouped
  }

  private remapPingResult(source: NodeGetSource, result: PingRecordsResult): PingRecordsResult {
    const records = result.records.flatMap((record): KomariPingRecord[] => {
      const client = this.publicId(source, record.client)
      return client ? [{ ...record, client }] : []
    })
    const basicInfo = result.basic_info.flatMap((item): KomariPingBasicInfo[] => {
      const client = this.publicId(source, item.client)
      return client ? [{ ...item, client }] : []
    })
    return {
      count: records.length,
      records,
      tasks: result.tasks.map(task => this.remapTask(source, task)),
      basic_info: basicInfo,
    }
  }

  private remapTask(source: NodeGetSource, task: KomariPingTask): KomariPingTask {
    return {
      ...task,
      clients: task.clients.flatMap((rawUuid) => {
        const publicUuid = this.publicId(source, rawUuid)
        return publicUuid ? [publicUuid] : []
      }),
    }
  }
}
