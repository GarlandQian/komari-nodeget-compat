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
import { asStringArray, finiteNumber } from '../shared/utils'
import { NodeGetRpcClient } from './rpc-client'
import { NodeGetSource } from './source'

interface ClientRoute {
  source: NodeGetSource
  rawUuid: string
}

type CallerFactory = (entry: NodeGetSiteToken) => NodeGetCaller

function cloneStatus(status: KomariNodeStatus, client: string): KomariNodeStatus {
  return { ...status, client }
}

function cloneRecord(record: KomariStatusRecord, client: string): KomariStatusRecord {
  return { ...record, client }
}

export class NodeGetMonitorProvider implements MonitorProvider {
  private readonly sources: NodeGetSource[]
  private readonly routes = new Map<string, ClientRoute>()
  private readonly publicIdBySourceAndRaw = new Map<string, string>()
  private clientsPromise: Promise<Record<string, KomariClient>> | null = null

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
    const preferences = this.config.user_preferences ?? {}
    const themeSettings = { ...this.manifest.themeSettingsDefaults }
    for (const key of this.manifest.themeSettingKeys) {
      if (!(key in preferences))
        continue
      themeSettings[key] = this.manifest.themeSettingArrayKeys.includes(key)
        ? asStringArray(preferences[key])
        : preferences[key]
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
      sitename: String(preferences.site_name ?? preferences.site_title ?? this.manifest.source.name),
      theme: this.manifest.source.short,
      theme_settings: themeSettings,
    }
  }

  async getVersion(): Promise<KomariVersionInfo> {
    return { version: '1.3.0-nodeget', hash: 'komari-nodeget-compat' }
  }

  async getClients(): Promise<Record<string, KomariClient>> {
    this.requireSources()
    if (!this.clientsPromise)
      this.clientsPromise = this.loadClients().catch((error) => {
        this.clientsPromise = null
        throw error
      })
    return this.clientsPromise
  }

  async getLatestStatuses(uuids?: string[]): Promise<Record<string, KomariNodeStatus>> {
    await this.ensureRoutes()
    const routes = uuids?.length
      ? uuids.map(uuid => [uuid, this.routeFor(uuid)] as const)
      : [...this.routes.entries()]
    const grouped = this.groupRoutes(routes)
    const statuses: Record<string, KomariNodeStatus> = {}

    await Promise.all([...grouped.entries()].map(async ([source, selected]) => {
      const sourceStatuses = await source.getLatestStatuses(selected.map(item => item.route.rawUuid))
      for (const item of selected) {
        const status = sourceStatuses[item.route.rawUuid]
        if (status)
          statuses[item.publicUuid] = cloneStatus(status, item.publicUuid)
      }
    }))
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
    await Promise.all(this.sources.map(async (source) => {
      const sourceRecords = await source.getLoadRecords(query)
      if (Array.isArray(sourceRecords))
        return
      for (const [rawUuid, records] of Object.entries(sourceRecords)) {
        const publicUuid = this.publicId(source, rawUuid)
        if (publicUuid)
          output[publicUuid] = records.map(record => cloneRecord(record, publicUuid))
      }
    }))
    return output
  }

  async getPingRecords(query: PingRecordQuery): Promise<PingRecordsResult> {
    await this.ensureRoutes()
    if (query.uuid) {
      const route = this.routeFor(query.uuid)
      const result = await route.source.getPingRecords({ ...query, uuid: route.rawUuid })
      return this.remapPingResult(route.source, result)
    }

    const results = await Promise.all(this.sources.map(source => source.getPingRecords(query)
      .then(result => this.remapPingResult(source, result))))
    const records = results.flatMap(result => result.records)
      .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
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
    const taskLists = await Promise.all(this.sources.map(async source => (await source.getPingTasks())
      .map(task => this.remapTask(source, task))))
    return taskLists.flat().sort((left, right) => left.id - right.id)
  }

  async listMetricDefinitions(): Promise<MetricDefinition[]> {
    this.requireSources()
    return this.sources[0]!.listMetricDefinitions()
  }

  async queryMetrics(params: MetricQueryParams): Promise<MetricQueryResult> {
    await this.ensureRoutes()
    const requestedIds = params.entity_ids?.length
      ? params.entity_ids
      : params.entity_id
        ? [params.entity_id]
        : [...this.routes.keys()]
    const routes = requestedIds.map(uuid => [uuid, this.routeFor(uuid)] as const)
    const grouped = this.groupRoutes(routes)
    const results = await Promise.all([...grouped.entries()].map(async ([source, selected]) => {
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
    }))

    const series = results.flatMap(result => result.series)
    const starts = results.map(result => Date.parse(result.start)).filter(Number.isFinite)
    const ends = results.map(result => Date.parse(result.end)).filter(Number.isFinite)
    return {
      start: new Date(starts.length ? Math.min(...starts) : Date.now()).toISOString(),
      end: new Date(ends.length ? Math.max(...ends) : Date.now()).toISOString(),
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
    if (!this.routes.size)
      await this.getClients()
  }

  private async loadClients(): Promise<Record<string, KomariClient>> {
    const sourceClients = await Promise.all(this.sources.map(async source => ({
      source,
      clients: await source.getClients(),
    })))
    const occurrences = new Map<string, number>()
    for (const { clients } of sourceClients) {
      for (const rawUuid of Object.keys(clients))
        occurrences.set(rawUuid, (occurrences.get(rawUuid) ?? 0) + 1)
    }

    this.routes.clear()
    this.publicIdBySourceAndRaw.clear()
    const result: Record<string, KomariClient> = {}
    for (const { source, clients } of sourceClients) {
      for (const [rawUuid, client] of Object.entries(clients)) {
        if (client.hidden)
          continue
        const publicUuid = occurrences.get(rawUuid) === 1 ? rawUuid : `${source.key}-${rawUuid}`
        this.routes.set(publicUuid, { source, rawUuid })
        this.publicIdBySourceAndRaw.set(this.sourceRawKey(source, rawUuid), publicUuid)
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
