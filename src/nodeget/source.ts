import type {
  KomariClient,
  KomariNodeStatus,
  KomariPingBasicInfo,
  KomariPingRecord,
  KomariPingTask,
  KomariStatusRecord,
  LoadRecordQuery,
  MetricDefinition,
  MetricPoint,
  MetricQueryParams,
  MetricQueryResult,
  MetricSeries,
  PingRecordQuery,
  PingRecordsResult,
} from '../types'
import type { NodeGetCaller } from './rpc-client'
import {
  downsampleEvenly,
  finiteNumber,
  firstFiniteValue,
  isRecord,
  parseJsonValue,
  sourceKey,
  stablePositiveId,
  timestampMs,
} from '../shared/utils'

const DYNAMIC_FIELDS = [
  'cpu_usage',
  'gpu_usage',
  'used_swap',
  'total_swap',
  'used_memory',
  'total_memory',
  'load_one',
  'load_five',
  'load_fifteen',
  'uptime',
  'process_count',
  'total_space',
  'available_space',
  'tcp_connections',
  'udp_connections',
  'total_received',
  'total_transmitted',
  'transmit_speed',
  'receive_speed',
] as const

const GIBIBYTE_BYTES = 1024 ** 3
const TRAFFIC_EXTENSION_BILLING_MODES = new Set(['quota', 'payg'])
const TRAFFIC_EXTENSION_PERIODS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'never'])
const TRAFFIC_LIMIT_TYPES = new Set(['sum', 'max', 'min', 'up', 'down'])

const METADATA_KEYS = [
  'metadata_name',
  'metadata_region',
  'metadata_provider',
  'metadata_city',
  'metadata_country',
  'metadata_asn',
  'metadata_public_remark',
  'metadata_price',
  'metadata_price_unit',
  'metadata_price_cycle',
  'metadata_expire_time',
  'metadata_tags',
  'metadata_hidden',
  'metadata_order',
  'metadata_group',
  'metadata_traffic_limit',
  'metadata_traffic_limit_type',
  'metadata_billing_mode',
  'metadata_traffic_period',
] as const

const METRIC_DEFINITIONS: MetricDefinition[] = [
  metricDefinition('cpu.usage', 'CPU usage', 'gauge', 'percent'),
  metricDefinition('gpu.usage', 'GPU usage', 'gauge', 'percent'),
  metricDefinition('load.average', 'Load average', 'gauge', 'load'),
  metricDefinition('memory.used', 'Memory used', 'gauge', 'bytes'),
  metricDefinition('memory.total', 'Memory total', 'gauge', 'bytes'),
  metricDefinition('swap.used', 'Swap used', 'gauge', 'bytes'),
  metricDefinition('swap.total', 'Swap total', 'gauge', 'bytes'),
  metricDefinition('disk.used', 'Disk used', 'gauge', 'bytes'),
  metricDefinition('disk.total', 'Disk total', 'gauge', 'bytes'),
  metricDefinition('net.in.rate', 'Network receive rate', 'gauge', 'bytes_per_second'),
  metricDefinition('net.out.rate', 'Network transmit rate', 'gauge', 'bytes_per_second'),
  metricDefinition('net.total.down', 'Total received traffic', 'counter', 'bytes'),
  metricDefinition('net.total.up', 'Total transmitted traffic', 'counter', 'bytes'),
  metricDefinition('traffic.down', 'Total received traffic', 'counter', 'bytes'),
  metricDefinition('traffic.up', 'Total transmitted traffic', 'counter', 'bytes'),
  metricDefinition('process.count', 'Process count', 'gauge', 'count'),
  metricDefinition('connections.tcp', 'TCP connections', 'gauge', 'count'),
  metricDefinition('connections.udp', 'UDP connections', 'gauge', 'count'),
  metricDefinition('ping.latency_ms', 'Ping latency', 'gauge', 'ms'),
  metricDefinition('ping.loss', 'Ping packet loss', 'gauge', 'ratio'),
]

interface TaskRow {
  uuid: string
  timestamp: number
  type: string
  name: string
  taskId: number
  value: number
}

interface RawTaskRow {
  row: Record<string, unknown>
  requestedType: string
}

function groupBy<T, K>(values: Iterable<T>, keyFor: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const value of values) {
    const key = keyFor(value)
    const group = groups.get(key) ?? []
    group.push(value)
    groups.set(key, group)
  }
  return groups
}

function metricDefinition(
  name: string,
  description: string,
  type: 'gauge' | 'counter',
  unit: string,
): MetricDefinition {
  return { name, description, type, unit, retention_days: 30 }
}

function unwrapData(value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current) || !('data' in current))
      break
    current = current.data
  }
  return current
}

function arrayPayload(value: unknown): unknown[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped))
    return unwrapped
  if (isRecord(unwrapped)) {
    for (const key of ['rows', 'values', 'items', 'result']) {
      if (Array.isArray(unwrapped[key]))
        return unwrapped[key]
    }
  }
  return []
}

function mapPayload(value: unknown): Record<string, Record<string, unknown>> {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) {
    const result: Record<string, Record<string, unknown>> = {}
    for (const item of unwrapped) {
      if (!isRecord(item))
        continue
      const uuid = stringValue(item.uuid)
      if (uuid)
        result[uuid] = item
    }
    return result
  }

  if (!isRecord(unwrapped))
    return {}

  const result: Record<string, Record<string, unknown>> = {}
  for (const [key, item] of Object.entries(unwrapped)) {
    if (isRecord(item))
      result[key] = item
  }
  return result
}

function stringValue(value: unknown, fallback = ''): string {
  if (value == null)
    return fallback
  if (typeof value === 'string')
    return value.trim() || fallback
  return String(value)
}

function booleanValue(value: unknown, fallback = false): boolean {
  const parsed = parseJsonValue(value, value)
  if (typeof parsed === 'boolean')
    return parsed
  if (typeof parsed === 'number')
    return parsed !== 0
  if (typeof parsed === 'string') {
    if (/^(true|1|yes|on)$/i.test(parsed))
      return true
    if (/^(false|0|no|off|)$/i.test(parsed))
      return false
  }
  return fallback
}

function nestedRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue<Record<string, unknown>>(value, {})
  return isRecord(parsed) ? parsed : {}
}

function cpuBrand(cpu: Record<string, unknown>): string {
  const direct = stringValue(cpu.brand)
  if (direct)
    return direct
  const perCore = cpu.per_core
  if (Array.isArray(perCore) && isRecord(perCore[0]))
    return stringValue(perCore[0].brand, '-')
  return '-'
}

function tagsValue(value: unknown): string {
  const parsed = parseJsonValue<unknown>(value, '')
  if (Array.isArray(parsed))
    return parsed.map(String).map(item => item.trim()).filter(Boolean).join(';')
  return stringValue(parsed).replaceAll(',', ';')
}

function trafficLimitMetadata(kv: Record<string, unknown>): {
  limit: number
  type: KomariClient['traffic_limit_type']
} {
  const rawLimit = Math.max(0, finiteNumber(parseJsonValue(kv.metadata_traffic_limit, 0)))
  const billingMode = stringValue(parseJsonValue(kv.metadata_billing_mode, '')).toLowerCase()
  const period = stringValue(parseJsonValue(kv.metadata_traffic_period, '')).toLowerCase()
  const extensionConfigured = TRAFFIC_EXTENSION_PERIODS.has(period)
    && (TRAFFIC_EXTENSION_BILLING_MODES.has(billingMode) || rawLimit > 0)

  if (extensionConfigured) {
    if (billingMode === 'payg')
      return { limit: 0, type: 'sum' }
    const bytes = Math.round(rawLimit * GIBIBYTE_BYTES)
    return {
      limit: Math.min(bytes, Number.MAX_SAFE_INTEGER),
      type: 'sum',
    }
  }

  const rawType = stringValue(parseJsonValue(kv.metadata_traffic_limit_type, 'sum')).toLowerCase()
  return {
    limit: rawLimit,
    type: TRAFFIC_LIMIT_TYPES.has(rawType)
      ? rawType as KomariClient['traffic_limit_type']
      : 'sum',
  }
}

function recordFromStatus(status: KomariNodeStatus): KomariStatusRecord {
  const { online: _online, updated_at: _updatedAt, ...record } = status
  return record
}

function metricValue(record: KomariStatusRecord, metricKey: string): number | null {
  switch (metricKey) {
    case 'cpu.usage': return record.cpu
    case 'gpu.usage': return record.gpu
    case 'load.average': return record.load
    case 'memory.used': return record.ram
    case 'memory.total': return record.ram_total
    case 'swap.used': return record.swap
    case 'swap.total': return record.swap_total
    case 'disk.used': return record.disk
    case 'disk.total': return record.disk_total
    case 'net.in.rate': return record.net_in
    case 'net.out.rate': return record.net_out
    case 'net.total.down':
    case 'traffic.down': return record.net_total_down
    case 'net.total.up':
    case 'traffic.up': return record.net_total_up
    case 'process.count': return record.process
    case 'connections.tcp': return record.connections
    case 'connections.udp': return record.connections_udp
    default: return null
  }
}

function queryRange(
  query: { start?: string, end?: string, hours?: number },
): { start: number, end: number } {
  const endCandidate = query.end ? Date.parse(query.end) : Date.now()
  const end = Number.isFinite(endCandidate) ? endCandidate : Date.now()
  const startCandidate = query.start ? Date.parse(query.start) : end - Math.max(1, query.hours ?? 1) * 3_600_000
  const start = Number.isFinite(startCandidate) ? startCandidate : end - 3_600_000
  return start <= end ? { start, end } : { start: end, end: start }
}

export class NodeGetSource {
  readonly key: string
  readonly name: string
  private clientCache: Record<string, KomariClient> = {}
  private statusCache: Record<string, KomariNodeStatus> = {}
  private pingTaskCache: { expiresAt: number, tasks: KomariPingTask[] } | null = null

  constructor(
    name: string,
    backendUrl: string,
    private readonly rpc: NodeGetCaller,
  ) {
    this.name = name || 'NodeGet'
    this.key = sourceKey(this.name, backendUrl)
  }

  async getClients(): Promise<Record<string, KomariClient>> {
    const uuids = await this.listAgentUuids()
    const namespaceKeys = uuids.flatMap(uuid => METADATA_KEYS.map(key => ({ namespace: uuid, key })))

    const [staticPayload, kvPayload] = await Promise.all([
      this.rpc.call<unknown>('agent_static_data_multi_last_query', {
        uuids,
        fields: ['cpu', 'system'],
      }).catch(() => ({})),
      namespaceKeys.length
        ? this.rpc.call<unknown>('kv_get_multi_value', { namespace_key: namespaceKeys }).catch(() => [])
        : Promise.resolve([]),
    ])

    const statics = mapPayload(staticPayload)
    const kvByNamespace: Record<string, Record<string, unknown>> = {}
    for (const row of arrayPayload(kvPayload)) {
      if (!isRecord(row))
        continue
      const namespace = stringValue(row.namespace)
      const key = stringValue(row.key)
      if (!namespace || !key)
        continue
      kvByNamespace[namespace] ??= {}
      kvByNamespace[namespace]![key] = row.value
    }

    const clients: Record<string, KomariClient> = {}
    for (const uuid of uuids) {
      const kv = kvByNamespace[uuid] ?? {}
      const staticData = statics[uuid] ?? {}
      const system = nestedRecord(staticData.system ?? staticData.system_data)
      const cpu = nestedRecord(staticData.cpu ?? staticData.cpu_data)
      const perCore = Array.isArray(cpu.per_core) ? cpu.per_core : []
      const city = stringValue(parseJsonValue(kv.metadata_city, ''))
      const region = stringValue(parseJsonValue(kv.metadata_region, city), city)
      const provider = stringValue(parseJsonValue(kv.metadata_provider, ''))
      const expireTime = stringValue(parseJsonValue(kv.metadata_expire_time, ''))
      const physicalCores = finiteNumber(cpu.physical_cores)
      const traffic = trafficLimitMetadata(kv)

      clients[uuid] = {
        uuid,
        name: stringValue(parseJsonValue(kv.metadata_name, ''), uuid.slice(0, 8)),
        cpu_name: cpuBrand(cpu),
        virtualization: stringValue(system.virtualization),
        arch: stringValue(system.system_arch ?? system.arch),
        cpu_cores: finiteNumber(cpu.logical_cores ?? perCore.length ?? cpu.physical_cores, 1) || 1,
        ...(physicalCores > 0 ? { cpu_physical_cores: physicalCores } : {}),
        os: stringValue(system.system_os_long_version ?? system.system_name ?? system.system_os_version, '-'),
        kernel_version: stringValue(system.system_kernel ?? system.system_kernel_version),
        gpu_name: '',
        ipv4: '',
        ipv6: '',
        region,
        provider,
        city,
        country: stringValue(parseJsonValue(kv.metadata_country, '')),
        asn: stringValue(parseJsonValue(kv.metadata_asn, '')),
        remark: '',
        public_remark: stringValue(parseJsonValue(kv.metadata_public_remark, '')),
        mem_total: 0,
        swap_total: 0,
        disk_total: 0,
        weight: finiteNumber(parseJsonValue(kv.metadata_order, 0)),
        price: finiteNumber(parseJsonValue(kv.metadata_price, 0)),
        billing_cycle: finiteNumber(parseJsonValue(kv.metadata_price_cycle, 30), 30) || 30,
        auto_renewal: false,
        currency: stringValue(parseJsonValue(kv.metadata_price_unit, 'CNY'), 'CNY'),
        expired_at: expireTime || null,
        group: stringValue(parseJsonValue(kv.metadata_group, region), region || this.name),
        tags: tagsValue(kv.metadata_tags),
        hidden: booleanValue(kv.metadata_hidden),
        traffic_limit: traffic.limit,
        traffic_limit_type: traffic.type,
        created_at: '',
        updated_at: '',
      }
    }

    this.clientCache = clients
    const statuses = await this.getLatestStatuses(uuids).catch(() => ({}))
    for (const [uuid, status] of Object.entries(statuses)) {
      const client = clients[uuid]
      if (!client)
        continue
      client.mem_total = status.ram_total
      client.swap_total = status.swap_total
      client.disk_total = status.disk_total
      client.updated_at = status.updated_at
    }
    return clients
  }

  async getLatestStatuses(uuids?: string[]): Promise<Record<string, KomariNodeStatus>> {
    const ids = uuids?.length
      ? uuids
      : Object.keys(this.clientCache).length
        ? Object.keys(this.clientCache)
        : await this.listAgentUuids()

    if (!ids.length)
      return {}

    const payload = await this.rpc.call<unknown>('agent_dynamic_summary_multi_last_query', {
      uuids: ids,
      fields: DYNAMIC_FIELDS,
    })
    const dynamic = mapPayload(payload)
    const now = Date.now()
    const statuses: Record<string, KomariNodeStatus> = {}
    for (const uuid of ids)
      statuses[uuid] = this.toStatus(uuid, dynamic[uuid] ?? {}, now)
    this.statusCache = { ...this.statusCache, ...statuses }
    return statuses
  }

  async getRecentRecords(uuid: string, limit: number): Promise<KomariStatusRecord[]> {
    const end = Date.now()
    return this.queryHistoricalSummary(uuid, end - 3_600_000, end, Math.min(Math.max(limit, 1), 1_000))
  }

  async getLoadRecords(query: LoadRecordQuery): Promise<KomariStatusRecord[] | Record<string, KomariStatusRecord[]>> {
    const { start, end } = queryRange(query)
    const ids = query.uuid
      ? [query.uuid]
      : Object.keys(this.clientCache).length
        ? Object.keys(this.clientCache)
        : await this.listAgentUuids()
    const entries = await Promise.all(ids.map(async uuid => [
      uuid,
      await this.queryHistoricalSummary(uuid, start, end, query.maxCount),
    ] as const))
    const records = Object.fromEntries(entries)
    return query.uuid ? records[query.uuid] ?? [] : records
  }

  async getPingRecords(query: PingRecordQuery): Promise<PingRecordsResult> {
    const { start, end } = queryRange(query)
    const taskRows = await this.queryTaskRows(query.uuid, start, end)
    const filteredRows = query.taskId
      ? taskRows.filter(row => row.taskId === query.taskId)
      : taskRows
    const fullRecords: KomariPingRecord[] = filteredRows.map(row => ({
      client: row.uuid,
      task_id: row.taskId,
      time: new Date(row.timestamp).toISOString(),
      value: row.value,
    }))
    const records = downsampleEvenly(fullRecords, query.maxCount)
    const tasks = this.tasksFromRows(filteredRows)
    const basicInfo = this.pingBasicInfo(fullRecords)
    return { count: records.length, records, tasks, basic_info: basicInfo }
  }

  async getPingTasks(): Promise<KomariPingTask[]> {
    if (this.pingTaskCache && this.pingTaskCache.expiresAt > Date.now())
      return this.pingTaskCache.tasks
    const end = Date.now()
    const rows = await this.queryTaskRows(undefined, end - 24 * 3_600_000, end)
    const tasks = this.tasksFromRows(rows)
    this.pingTaskCache = { expiresAt: Date.now() + 60_000, tasks }
    return tasks
  }

  listMetricDefinitions(): MetricDefinition[] {
    return METRIC_DEFINITIONS.map(definition => ({ ...definition }))
  }

  async queryMetrics(params: MetricQueryParams): Promise<MetricQueryResult> {
    const metricKeys = this.metricKeys(params)
    const { start, end } = queryRange({
      ...(params.start || params.start_time ? { start: params.start ?? params.start_time } : {}),
      ...(params.end || params.end_time ? { end: params.end ?? params.end_time } : {}),
      ...(params.hours !== undefined ? { hours: params.hours } : {}),
    })
    const maxPoints = Math.max(1, params.max_points ?? params.downsample_points ?? 500)
    const entityIds = params.entity_ids?.length
      ? params.entity_ids
      : params.entity_id
        ? [params.entity_id]
        : Object.keys(this.clientCache).length
          ? Object.keys(this.clientCache)
          : await this.listAgentUuids()

    const series: MetricSeries[] = []
    const loadMetricKeys = metricKeys.filter(key => !key.startsWith('ping.'))
    if (loadMetricKeys.length) {
      await Promise.all(entityIds.map(async (uuid) => {
        const records = await this.queryHistoricalSummary(uuid, start, end, maxPoints)
        for (const metricKey of loadMetricKeys) {
          const definition = METRIC_DEFINITIONS.find(item => item.name === metricKey)
          if (!definition)
            continue
          const points: MetricPoint[] = records.map(record => ({
            time: record.time,
            value: metricValue(record, metricKey),
          }))
          series.push({
            metric_key: metricKey,
            entity_id: uuid,
            type: definition.type,
            unit: definition.unit,
            downsampled: records.length >= maxPoints,
            count: points.length,
            points,
            tags: {},
          })
        }
      }))
    }

    const pingMetricKeys = metricKeys.filter(key => key.startsWith('ping.'))
    if (pingMetricKeys.length) {
      await Promise.all(entityIds.map(async (uuid) => {
        const rows = await this.queryTaskRows(uuid, start, end)
        const byTask = groupBy(rows, row => `${row.taskId}\u0000${row.name}`)
        for (const taskRows of byTask.values()) {
          const first = taskRows[0]
          if (!first)
            continue
          const sampled = downsampleEvenly(taskRows, maxPoints)
          const tags = { task_id: String(first.taskId), task_name: first.name, task_type: first.type }
          if (pingMetricKeys.includes('ping.latency_ms')) {
            const points = sampled.map(row => ({
              time: new Date(row.timestamp).toISOString(),
              value: row.value >= 0 ? row.value : null,
              count: 1,
            }))
            series.push({
              metric_key: 'ping.latency_ms', entity_id: uuid, type: 'gauge', unit: 'ms',
              downsampled: taskRows.length > sampled.length, count: points.length, points, tags,
            })
          }
          if (pingMetricKeys.includes('ping.loss')) {
            const points = sampled.map(row => ({
              time: new Date(row.timestamp).toISOString(),
              value: row.value < 0 ? 1 : 0,
              count: 1,
            }))
            series.push({
              metric_key: 'ping.loss', entity_id: uuid, type: 'gauge', unit: 'ratio',
              downsampled: taskRows.length > sampled.length, count: points.length, points, tags,
            })
          }
        }
      }))
    }

    series.sort((left, right) => `${left.entity_id}:${left.metric_key}:${left.tags.task_id ?? ''}`
      .localeCompare(`${right.entity_id}:${right.metric_key}:${right.tags.task_id ?? ''}`))
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      series,
      count: series.length,
    }
  }

  close(): void {
    this.rpc.close()
  }

  private async listAgentUuids(): Promise<string[]> {
    let payload: unknown
    try {
      payload = await this.rpc.call<unknown>('agent-uuid_list_all')
    }
    catch {
      payload = await this.rpc.call<unknown>('nodeget-server_list_all_agent_uuid')
    }

    const unwrapped = unwrapData(payload)
    const values = Array.isArray(unwrapped)
      ? unwrapped
      : isRecord(unwrapped) && Array.isArray(unwrapped.uuids)
        ? unwrapped.uuids
        : []
    return [...new Set(values.map(item => isRecord(item) ? stringValue(item.uuid) : stringValue(item)).filter(Boolean))]
      .sort()
  }

  private toStatus(uuid: string, dynamic: Record<string, unknown>, now: number): KomariNodeStatus {
    const timestamp = timestampMs(dynamic.timestamp ?? dynamic.storage_time)
    const ramTotal = firstFiniteValue(dynamic, ['total_memory'])
    const swapTotal = firstFiniteValue(dynamic, ['total_swap'])
    const diskTotal = firstFiniteValue(dynamic, ['total_space'])
    const diskUsed = Math.max(0, diskTotal - firstFiniteValue(dynamic, ['available_space']))
    const time = new Date(timestamp || 0).toISOString()

    return {
      client: uuid,
      time,
      cpu: firstFiniteValue(dynamic, ['cpu_usage']),
      gpu: firstFiniteValue(dynamic, ['gpu_usage']),
      ram: firstFiniteValue(dynamic, ['used_memory']),
      ram_total: ramTotal,
      swap: firstFiniteValue(dynamic, ['used_swap']),
      swap_total: swapTotal,
      load: firstFiniteValue(dynamic, ['load_one']),
      load5: firstFiniteValue(dynamic, ['load_five']),
      load15: firstFiniteValue(dynamic, ['load_fifteen']),
      temp: firstFiniteValue(dynamic, ['temperature', 'system_temperature']),
      disk: diskUsed,
      disk_total: diskTotal,
      net_in: firstFiniteValue(dynamic, ['receive_speed']),
      net_out: firstFiniteValue(dynamic, ['transmit_speed']),
      net_total_up: firstFiniteValue(dynamic, ['total_transmitted']),
      net_total_down: firstFiniteValue(dynamic, ['total_received']),
      traffic_up: firstFiniteValue(dynamic, ['total_transmitted']),
      traffic_down: firstFiniteValue(dynamic, ['total_received']),
      process: firstFiniteValue(dynamic, ['process_count']),
      connections: firstFiniteValue(dynamic, ['tcp_connections']),
      connections_udp: firstFiniteValue(dynamic, ['udp_connections']),
      online: timestamp > 0 && now - timestamp < 30_000,
      uptime: firstFiniteValue(dynamic, ['uptime']),
      updated_at: time,
    }
  }

  private async queryHistoricalSummary(
    uuid: string,
    start: number,
    end: number,
    maxCount: number,
  ): Promise<KomariStatusRecord[]> {
    const windows: Array<{ from: number, to: number }> = []
    const windowMs = 2 * 3_600_000
    for (let from = start; from < end; from += windowMs)
      windows.push({ from, to: Math.min(end, from + windowMs) })

    const rows: Record<string, unknown>[] = []
    for (let index = 0; index < windows.length; index += 4) {
      const batch = windows.slice(index, index + 4).map(({ from, to }) => this.rpc.call<unknown>(
        'agent_query_dynamic_summary',
        {
          query: {
            condition: [{ uuid }, { timestamp_from: from }, { timestamp_to: to }, { limit: 10_000 }],
            fields: DYNAMIC_FIELDS,
          },
        },
      ).catch(() => []))
      for (const response of await Promise.all(batch)) {
        for (const row of arrayPayload(response)) {
          if (isRecord(row))
            rows.push(row)
        }
      }
    }

    const unique = new Map<number, Record<string, unknown>>()
    for (const row of rows) {
      const timestamp = timestampMs(row.timestamp ?? row.storage_time)
      if (timestamp >= start && timestamp <= end)
        unique.set(timestamp, row)
    }
    const records = [...unique.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, row]) => recordFromStatus(this.toStatus(uuid, row, Number.MAX_SAFE_INTEGER)))
    return downsampleEvenly(records, maxCount)
  }

  private async queryTaskRows(uuid: string | undefined, start: number, end: number): Promise<TaskRow[]> {
    const windows: Array<{ from: number, to: number }> = []
    const windowMs = 3_600_000
    for (let from = start; from < end; from += windowMs)
      windows.push({ from, to: Math.min(end, from + windowMs) })

    const rawRows: RawTaskRow[] = []
    for (let index = 0; index < windows.length; index += 4) {
      const batch = windows.slice(index, index + 4).flatMap(({ from, to }) => ['ping', 'tcp_ping'].map((type) => {
        const condition: Record<string, unknown>[] = []
        if (uuid)
          condition.push({ uuid })
        condition.push({ type }, { timestamp_from: from }, { timestamp_to: to }, { limit: 10_000 })
        return this.rpc.call<unknown>('task_query', { task_data_query: { condition } })
          .then(response => ({ requestedType: type, response }))
          .catch(() => ({ requestedType: type, response: [] }))
      }))

      for (const { requestedType, response } of await Promise.all(batch)) {
        for (const row of arrayPayload(response)) {
          if (isRecord(row))
            rawRows.push({ row, requestedType })
        }
      }
    }

    const unique = new Map<string, TaskRow>()
    for (const { row, requestedType } of rawRows) {
      const result = isRecord(row.task_event_result) ? row.task_event_result : {}
      const valueCandidate = typeof result.ping === 'number' ? result.ping : result.tcp_ping
      const failed = row.success === false
      if ((typeof valueCandidate !== 'number' || !Number.isFinite(valueCandidate)) && !failed)
        continue
      const rowUuid = stringValue(row.uuid, uuid)
      if (!rowUuid)
        continue
      const timestamp = timestampMs(row.timestamp ?? row.storage_time)
      if (!timestamp || timestamp < start || timestamp > end)
        continue
      const type = typeof result.tcp_ping === 'number'
        ? 'tcp_ping'
        : typeof result.ping === 'number'
          ? 'ping'
          : requestedType
      const name = stringValue(row.cron_source ?? row.task_name, type)
      const taskId = stablePositiveId(`${this.key}\u0000${type}\u0000${name}`)
      unique.set(`${rowUuid}\u0000${taskId}\u0000${timestamp}`, {
        uuid: rowUuid,
        timestamp,
        type,
        name,
        taskId,
        value: typeof valueCandidate === 'number' && Number.isFinite(valueCandidate) ? valueCandidate : -1,
      })
    }

    return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp)
  }

  private tasksFromRows(rows: TaskRow[]): KomariPingTask[] {
    const grouped = groupBy(rows, row => row.taskId)
    return [...grouped.entries()].map(([id, taskRows]) => {
      const first = taskRows[0]!
      const values = taskRows.map(row => row.value)
      const valid = values.filter(value => value >= 0)
      const loss = values.length ? (values.length - valid.length) / values.length * 100 : 0
      return {
        id,
        name: first.name,
        clients: [...new Set(taskRows.map(row => row.uuid))].sort(),
        default_on: true,
        type: first.type,
        interval: 20,
        loss,
        ...(valid.length
          ? {
              min: Math.min(...valid),
              max: Math.max(...valid),
              avg: valid.reduce((sum, value) => sum + value, 0) / valid.length,
            }
          : {}),
        total: values.length,
      }
    }).sort((left, right) => left.id - right.id)
  }

  private pingBasicInfo(records: KomariPingRecord[]): KomariPingBasicInfo[] {
    const grouped = groupBy(records, record => record.client)
    return [...grouped.entries()].map(([client, clientRecords]) => {
      const valid = clientRecords.map(record => record.value).filter(value => value >= 0)
      return {
        client,
        loss: clientRecords.length ? (clientRecords.length - valid.length) / clientRecords.length * 100 : 0,
        min: valid.length ? Math.min(...valid) : 0,
        max: valid.length ? Math.max(...valid) : 0,
      }
    })
  }

  private metricKeys(params: MetricQueryParams): string[] {
    const requested = params.metric_keys
      ?? params.metrics
      ?? (params.metric_key ? [params.metric_key] : [])
    const supported = new Set(METRIC_DEFINITIONS.map(definition => definition.name))
    return [...new Set(requested)].filter(key => supported.has(key))
  }
}
