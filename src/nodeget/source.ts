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
import { rankPingTasks } from './ping-task-order'
import {
  downsampleEvenly,
  downsampleGroupsProportionally,
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
const DEFAULT_METRIC_POINTS = 500
const MAX_METRIC_POINTS = 20_000
const MAX_HISTORY_RANGE_MS = 30 * 24 * 3_600_000
const TRAFFIC_PREDECESSOR_LOOKBACK_MS = 2 * 3_600_000
const TRAFFIC_EXTENSION_BILLING_MODES = new Set(['quota', 'payg'])
const TRAFFIC_EXTENSION_PERIODS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'never'])
const TRAFFIC_PERIOD_CACHE_TTL_MS = 60_000
const TRAFFIC_PERIOD_RETRY_MS = 15_000
const PING_TASK_DISCOVERY_WINDOW_MS = 3_600_000
const PING_TASK_FALLBACK_WINDOW_MS = 24 * 3_600_000
const TRAFFIC_LIMIT_TYPES = new Set(['sum', 'max', 'min', 'up', 'down'])
const METRIC_AGGREGATIONS = new Set([
  'avg',
  'min',
  'max',
  'sum',
  'count',
  'p50',
  'p95',
  'p99',
  'first',
  'last',
  'rate',
  'stddev',
])

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
  'metadata_traffic_period_start',
  'metadata_traffic_period_base',
  'metadata_traffic_used',
] as const

const TRAFFIC_PERIOD_METADATA_KEYS = [
  'metadata_billing_mode',
  'metadata_traffic_limit',
  'metadata_traffic_period',
  'metadata_traffic_period_start',
  'metadata_traffic_period_base',
  'metadata_traffic_used',
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
  metricDefinition('traffic.down', 'Traffic download delta', 'gauge', 'bytes'),
  metricDefinition('traffic.up', 'Traffic upload delta', 'gauge', 'bytes'),
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

interface RawTrafficState {
  down: number
  timestamp: number
  up: number
  uptime: number
}

interface TrafficPeriodState {
  base: number
  enabled: boolean
  start: number
  used: number
}

type MetricAggregation = 'avg' | 'min' | 'max' | 'sum' | 'count' | 'p50' | 'p95' | 'p99'
  | 'first' | 'last' | 'rate' | 'stddev'

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

function kvPayloadByNamespace(value: unknown): Record<string, Record<string, unknown>> {
  const byNamespace: Record<string, Record<string, unknown>> = {}
  for (const row of arrayPayload(value)) {
    if (!isRecord(row))
      continue
    const namespace = stringValue(row.namespace)
    const key = stringValue(row.key)
    if (!namespace || !key)
      continue
    byNamespace[namespace] ??= {}
    byNamespace[namespace]![key] = row.value
  }
  return byNamespace
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
    && TRAFFIC_EXTENSION_BILLING_MODES.has(billingMode)

  if (extensionConfigured) {
    if (billingMode === 'payg' || period === 'never')
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

function trafficPeriodMetadata(kv: Record<string, unknown>): TrafficPeriodState {
  const billingMode = stringValue(parseJsonValue(kv.metadata_billing_mode, '')).toLowerCase()
  const period = stringValue(parseJsonValue(kv.metadata_traffic_period, '')).toLowerCase()
  const rawLimit = finiteNumber(parseJsonValue(kv.metadata_traffic_limit, 0))
  return {
    enabled: billingMode === 'quota'
      && period !== 'never'
      && TRAFFIC_EXTENSION_PERIODS.has(period)
      && rawLimit > 0,
    start: Math.max(0, timestampMs(parseJsonValue(kv.metadata_traffic_period_start, 0))),
    base: Math.max(0, finiteNumber(parseJsonValue(kv.metadata_traffic_period_base, 0))),
    used: Math.max(0, finiteNumber(parseJsonValue(kv.metadata_traffic_used, 0))),
  }
}

function rawTrafficState(dynamic: Record<string, unknown>): RawTrafficState {
  return {
    timestamp: timestampMs(dynamic.timestamp ?? dynamic.storage_time),
    uptime: firstFiniteValue(dynamic, ['uptime']),
    up: Math.max(0, firstFiniteValue(dynamic, ['total_transmitted'])),
    down: Math.max(0, firstFiniteValue(dynamic, ['total_received'])),
  }
}

function trafficDelta(current: RawTrafficState, previous: RawTrafficState | undefined, direction: 'up' | 'down'): number {
  if (!previous || current.timestamp <= previous.timestamp || current.uptime < previous.uptime)
    return 0
  const currentValue = current[direction]
  const previousValue = previous[direction]
  return currentValue >= previousValue ? currentValue - previousValue : 0
}

function currentPeriodTraffic(
  rawUp: number,
  rawDown: number,
  period: TrafficPeriodState | undefined,
): { up: number, down: number } {
  if (!period?.enabled)
    return { up: rawUp, down: rawDown }

  // A configured extension may not have initialized its current-period baseline yet.
  if (period.start <= 0 && period.used <= 0)
    return { up: rawUp, down: rawDown }

  const total = rawUp + rawDown
  const used = Math.max(
    period.used,
    period.start > 0 && total >= period.base ? total - period.base : 0,
  )
  if (used <= 0 || total <= 0)
    return { up: 0, down: Math.max(0, used) }

  const up = Math.round(used * rawUp / total)
  return { up, down: Math.max(0, used - up) }
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
    case 'net.total.down': return record.net_total_down
    case 'traffic.down': return record.traffic_down
    case 'net.total.up': return record.net_total_up
    case 'traffic.up': return record.traffic_up
    case 'process.count': return record.process
    case 'connections.tcp': return Math.max(0, record.connections - record.connections_udp)
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
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  return { start: Math.max(from, to - MAX_HISTORY_RANGE_MS), end: to }
}

function normalizeAggregation(value: string | undefined): MetricAggregation {
  const normalized = (value ?? 'avg').trim().toLowerCase()
    .replace(/^(average|mean)$/, 'avg')
    .replace(/^(std_dev|stddev_pop|std_dev_pop)$/, 'stddev')
  if (!METRIC_AGGREGATIONS.has(normalized))
    throw new Error(`Unsupported metric aggregation: ${value}`)
  return normalized as MetricAggregation
}

function metricAggregation(params: MetricQueryParams, metricKey: string): MetricAggregation {
  const specific = params.aggregation_by_metric?.[metricKey]
    ?? params.algorithm_by_metric?.[metricKey]
  return normalizeAggregation(specific ?? params.aggregation ?? params.algorithm)
}

function metricMaxPoints(params: MetricQueryParams, metricKey: string): number {
  const requested = params.max_points_by_metric?.[metricKey]
    ?? params.points_by_metric?.[metricKey]
    ?? params.max_points
    ?? params.downsample_points
    ?? DEFAULT_METRIC_POINTS
  if (!Number.isInteger(requested) || requested <= 0)
    throw new Error(`Max points for ${metricKey} must be a positive integer`)
  return Math.min(requested, MAX_METRIC_POINTS)
}

function percentileValue(values: number[], percentile: number): number | null {
  if (!values.length)
    return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * percentile
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper)
    return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

function aggregateMetricValue(points: MetricPoint[], aggregation: MetricAggregation): number | null {
  const numeric = points.flatMap(point => typeof point.value === 'number' && Number.isFinite(point.value)
    ? [point.value]
    : [])
  if (aggregation === 'count')
    return numeric.length
  if (!numeric.length)
    return null
  if (aggregation === 'sum')
    return numeric.reduce((sum, value) => sum + value, 0)
  if (aggregation === 'min')
    return Math.min(...numeric)
  if (aggregation === 'max')
    return Math.max(...numeric)
  if (aggregation === 'first')
    return numeric[0]!
  if (aggregation === 'last')
    return numeric.at(-1)!
  if (aggregation === 'p50')
    return percentileValue(numeric, 0.5)
  if (aggregation === 'p95')
    return percentileValue(numeric, 0.95)
  if (aggregation === 'p99')
    return percentileValue(numeric, 0.99)
  if (aggregation === 'stddev') {
    const average = numeric.reduce((sum, value) => sum + value, 0) / numeric.length
    return Math.sqrt(numeric.reduce((sum, value) => sum + (value - average) ** 2, 0) / numeric.length)
  }
  if (aggregation === 'rate') {
    const numericPoints = points.filter((point): point is MetricPoint & { value: number } => (
      typeof point.value === 'number' && Number.isFinite(point.value)
    ))
    if (numericPoints.length < 2)
      return 0
    let increase = 0
    for (let index = 1; index < numericPoints.length; index += 1) {
      const current = numericPoints[index]!.value
      const previous = numericPoints[index - 1]!.value
      increase += current >= previous ? current - previous : current
    }
    const seconds = (Date.parse(numericPoints.at(-1)!.time) - Date.parse(numericPoints[0]!.time)) / 1000
    return seconds > 0 ? increase / seconds : 0
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length
}

function visibleMetricValue(metricKey: string, value: number | null, fillEmpty: boolean): number | null {
  return fillEmpty && metricKey.startsWith('ping.') && value === -1 ? null : value
}

function adaptivelyFillMetricPoints(
  points: MetricPoint[],
  metricKey: string,
  start: number,
  end: number,
  fillEmpty: boolean,
  expectedIntervalMs = 0,
): { intervalSeconds?: number, points: MetricPoint[] } {
  const visible = points.map(point => ({
    ...point,
    value: visibleMetricValue(metricKey, point.value, fillEmpty),
    count: point.count ?? 1,
  }))
  if (!fillEmpty) {
    return {
      ...(expectedIntervalMs > 0 ? { intervalSeconds: expectedIntervalMs / 1_000 } : {}),
      points: visible,
    }
  }

  const timestamps = visible.map(point => Date.parse(point.time))
  const deltas: number[] = []
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index]! - timestamps[index - 1]!
    if (delta > 0)
      deltas.push(delta)
  }
  if (deltas.length >= 2) {
    deltas.sort((left, right) => left - right)
    expectedIntervalMs = Math.max(expectedIntervalMs, deltas[Math.floor((deltas.length - 1) / 4)]!)
  }

  const filled: MetricPoint[] = []
  if (!timestamps.length || start < timestamps[0]!)
    filled.push({ time: new Date(start).toISOString(), value: null, count: 0 })
  for (let index = 0; index < visible.length; index += 1) {
    const point = visible[index]!
    if (index > 0 && expectedIntervalMs > 0) {
      const previous = visible[index - 1]!
      const delta = timestamps[index]! - timestamps[index - 1]!
      if (previous.value !== null && point.value !== null && delta > expectedIntervalMs * 1.5) {
        filled.push({
          time: new Date(timestamps[index - 1]! + expectedIntervalMs).toISOString(),
          value: null,
          count: 0,
        })
      }
    }
    filled.push(point)
  }
  if (!timestamps.length)
    filled.push({ time: new Date(end).toISOString(), value: null, count: 0 })
  return {
    ...(expectedIntervalMs > 0 ? { intervalSeconds: expectedIntervalMs / 1_000 } : {}),
    points: filled,
  }
}

function downsampleMetricPoints(
  points: MetricPoint[],
  metricKey: string,
  start: number,
  end: number,
  maxPoints: number,
  aggregation: MetricAggregation,
  fillEmpty: boolean,
): { downsampled: boolean, intervalSeconds?: number, points: MetricPoint[] } {
  const sorted = [...points].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
  if (sorted.length <= maxPoints) {
    const filled = adaptivelyFillMetricPoints(sorted, metricKey, start, end, fillEmpty)
    return {
      downsampled: false,
      ...filled,
    }
  }

  const intervalMs = Math.max(1_000, Math.ceil(Math.max(1, end - start) / maxPoints))
  const bucketCount = Math.max(1, Math.min(maxPoints, Math.ceil(Math.max(1, end - start) / intervalMs)))
  const buckets = new Map<number, MetricPoint[]>()
  for (const point of sorted) {
    const timestamp = Date.parse(point.time)
    if (!Number.isFinite(timestamp))
      continue
    const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor((timestamp - start) / intervalMs)))
    const values = buckets.get(bucket) ?? []
    values.push(point)
    buckets.set(bucket, values)
  }

  const sampled: MetricPoint[] = []
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const values = buckets.get(bucket)
    if (!values?.length)
      continue
    sampled.push({
      time: new Date(start + bucket * intervalMs).toISOString(),
      value: aggregateMetricValue(values, aggregation),
      count: values.reduce((count, point) => count + (point.count ?? 1), 0),
    })
  }
  const filled = adaptivelyFillMetricPoints(sampled, metricKey, start, end, fillEmpty, intervalMs)
  return {
    downsampled: true,
    ...filled,
  }
}

function taskMatchesMetricQuery(row: TaskRow, params: MetricQueryParams): boolean {
  const requestedTaskIds = [params.task_id, ...(params.task_ids ?? [])]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(String)
  if (requestedTaskIds.length && !requestedTaskIds.includes(String(row.taskId)))
    return false
  const tags = params.tags ?? {}
  for (const [key, value] of Object.entries(tags)) {
    if (key === 'task_id' && String(row.taskId) !== value)
      return false
    if (key === 'task_name' && row.name !== value)
      return false
    if (key === 'task_type' && row.type !== value)
      return false
    if (!['task_id', 'task_name', 'task_type'].includes(key))
      return false
  }
  return true
}

function inferredTaskInterval(rows: TaskRow[]): number {
  const intervals: number[] = []
  for (const clientRows of groupBy(rows, row => row.uuid).values()) {
    const timestamps = [...new Set(clientRows.map(row => row.timestamp))].sort((left, right) => left - right)
    for (let index = 1; index < timestamps.length; index += 1) {
      const seconds = (timestamps[index]! - timestamps[index - 1]!) / 1000
      if (seconds > 0 && Number.isFinite(seconds))
        intervals.push(seconds)
    }
  }
  if (!intervals.length)
    return 20
  intervals.sort((left, right) => left - right)
  return Math.max(1, Math.round(intervals[Math.floor(intervals.length / 2)]!))
}

export class NodeGetSource {
  readonly key: string
  readonly name: string
  private clientCache: Record<string, KomariClient> = {}
  private statusCache: Record<string, KomariNodeStatus> = {}
  private latestRawTrafficCache: Record<string, RawTrafficState> = {}
  private trafficPeriodCache: Record<string, TrafficPeriodState> = {}
  private trafficPeriodExpiresAt = 0
  private trafficPeriodRefreshPromise: Promise<void> | null = null
  private pingTaskCache: { expiresAt: number, tasks: KomariPingTask[] } | null = null
  private pingTaskRefreshPromise: Promise<KomariPingTask[]> | null = null

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
    const kvByNamespace = kvPayloadByNamespace(kvPayload)

    const clients: Record<string, KomariClient> = {}
    const trafficPeriods: Record<string, TrafficPeriodState> = {}
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
      trafficPeriods[uuid] = trafficPeriodMetadata(kv)

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
    this.trafficPeriodCache = trafficPeriods
    this.trafficPeriodExpiresAt = Date.now() + TRAFFIC_PERIOD_CACHE_TTL_MS
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

    await this.refreshTrafficPeriodsIfNeeded(ids).catch(() => {})

    const payload = await this.rpc.call<unknown>('agent_dynamic_summary_multi_last_query', {
      uuids: ids,
      fields: DYNAMIC_FIELDS,
    })
    const dynamic = mapPayload(payload)
    const now = Date.now()
    const statuses: Record<string, KomariNodeStatus> = {}
    for (const uuid of ids) {
      const row = dynamic[uuid]
      if (!row && this.statusCache[uuid]) {
        statuses[uuid] = { ...this.statusCache[uuid], online: false }
        continue
      }
      const currentRow = row ?? {}
      const rawTraffic = rawTrafficState(currentRow)
      statuses[uuid] = this.toStatus(uuid, currentRow, now, this.latestRawTrafficCache[uuid], true)
      if (rawTraffic.timestamp > 0)
        this.latestRawTrafficCache[uuid] = rawTraffic
    }
    this.statusCache = { ...this.statusCache, ...statuses }
    return statuses
  }

  async getRecentRecords(uuid: string, limit: number): Promise<KomariStatusRecord[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1_000)
    const response = await this.rpc.call<unknown>('agent_query_dynamic_summary', {
      query: {
        condition: [{ uuid }, { limit: safeLimit + 1 }],
        fields: DYNAMIC_FIELDS,
      },
    })
    const unique = new Map<number, Record<string, unknown>>()
    for (const candidate of arrayPayload(response)) {
      if (!isRecord(candidate))
        continue
      const timestamp = timestampMs(candidate.timestamp ?? candidate.storage_time)
      if (timestamp > 0)
        unique.set(timestamp, candidate)
    }

    const records: KomariStatusRecord[] = []
    let previousTraffic: RawTrafficState | undefined
    for (const [, row] of [...unique.entries()].sort(([left], [right]) => left - right)) {
      const status = this.toStatus(uuid, row, Number.MAX_SAFE_INTEGER, previousTraffic)
      previousTraffic = rawTrafficState(row)
      records.push(recordFromStatus(status))
    }
    return records.slice(-safeLimit)
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
      await this.queryHistoricalSummary(uuid, start, end, query.uuid ? query.maxCount : -1),
    ] as const))
    const grouped = query.uuid
      ? new Map(entries)
      : downsampleGroupsProportionally(new Map(entries), query.maxCount)
    const records = Object.fromEntries(grouped)
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
    const groupedRecords = groupBy(fullRecords, record => record.task_id)
    const records = [...downsampleGroupsProportionally(groupedRecords, query.maxCount).values()]
      .flat()
      .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    const tasks = this.tasksFromRows(filteredRows)
    const basicInfo = this.pingBasicInfo(fullRecords)
    return { count: records.length, records, tasks, basic_info: basicInfo }
  }

  async getPingTasks(): Promise<KomariPingTask[]> {
    if (this.pingTaskCache && this.pingTaskCache.expiresAt > Date.now())
      return this.pingTaskCache.tasks
    if (!this.pingTaskRefreshPromise) {
      const refresh = this.loadPingTasks().finally(() => {
        if (this.pingTaskRefreshPromise === refresh)
          this.pingTaskRefreshPromise = null
      })
      this.pingTaskRefreshPromise = refresh
    }
    return this.pingTaskRefreshPromise
  }

  private async loadPingTasks(): Promise<KomariPingTask[]> {
    const end = Date.now()
    const recentStart = end - PING_TASK_DISCOVERY_WINDOW_MS
    const uuids = Object.keys(this.clientCache).length
      ? Object.keys(this.clientCache)
      : await this.listAgentUuids()
    let rows: TaskRow[] = []
    let globalQuerySucceeded = false
    let firstFailure: unknown
    try {
      rows = await this.queryTaskRows(undefined, recentStart, end, PING_TASK_DISCOVERY_WINDOW_MS)
      globalQuerySucceeded = true
    }
    catch (error) {
      firstFailure = error
    }

    const coveredUuids = new Set(rows.map(row => row.uuid))
    const missingUuids = uuids.filter(uuid => !coveredUuids.has(uuid))
    let scopedQuerySucceeded = false
    const fallbackStart = end - PING_TASK_FALLBACK_WINDOW_MS
    for (let index = 0; index < missingUuids.length; index += 4) {
      const results = await Promise.allSettled(missingUuids.slice(index, index + 4).map(uuid => (
        this.queryTaskRows(uuid, fallbackStart, end, PING_TASK_FALLBACK_WINDOW_MS)
      )))
      for (const result of results) {
        if (result.status === 'rejected') {
          firstFailure ??= result.reason
          continue
        }
        scopedQuerySucceeded = true
        rows.push(...result.value)
      }
    }
    if (uuids.length && !globalQuerySucceeded && !scopedQuerySucceeded)
      throw firstFailure ?? new Error('NodeGet task query failed')

    const tasks = this.tasksFromRows(rows)
    this.pingTaskCache = { expiresAt: Date.now() + 60_000, tasks }
    return tasks
  }

  listMetricDefinitions(): MetricDefinition[] {
    return METRIC_DEFINITIONS.map(definition => ({ ...definition }))
  }

  emptyMetricResult(params: MetricQueryParams, entityIds: string[]): MetricQueryResult {
    const metricKeys = this.metricKeys(params)
    const { start, end } = queryRange({
      ...(params.start || params.start_time ? { start: params.start ?? params.start_time } : {}),
      ...(params.end || params.end_time ? { end: params.end ?? params.end_time } : {}),
      hours: params.hours ?? 4,
    })
    const fillEmpty = params.fill_empty === true
    const series = [...new Set(entityIds.map(id => id.trim()).filter(Boolean))].flatMap(entityId => (
      metricKeys.map((metricKey): MetricSeries => {
        const definition = METRIC_DEFINITIONS.find(item => item.name === metricKey)!
        metricAggregation(params, metricKey)
        const maxPoints = metricMaxPoints(params, metricKey)
        return {
          metric_key: metricKey,
          entity_id: entityId,
          type: definition.type,
          unit: definition.unit,
          retention_days: definition.retention_days,
          downsampled: false,
          fill_empty: fillEmpty,
          max_points: maxPoints,
          count: fillEmpty ? 2 : 0,
          points: fillEmpty
            ? [
                { time: new Date(start).toISOString(), value: null, count: 0 },
                { time: new Date(end).toISOString(), value: null, count: 0 },
              ]
            : [],
          tags: { ...(params.tags ?? {}) },
        }
      })
    ))
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      server_downsample_default: true,
      default_points: DEFAULT_METRIC_POINTS,
      series,
      count: series.length,
    }
  }

  async queryMetrics(params: MetricQueryParams): Promise<MetricQueryResult> {
    const metricKeys = this.metricKeys(params)
    const { start, end } = queryRange({
      ...(params.start || params.start_time ? { start: params.start ?? params.start_time } : {}),
      ...(params.end || params.end_time ? { end: params.end ?? params.end_time } : {}),
      hours: params.hours ?? 4,
    })
    const requestedEntityIds = params.entity_ids?.length
      ? params.entity_ids
      : params.entity_id
        ? [params.entity_id]
        : Object.keys(this.clientCache).length
          ? Object.keys(this.clientCache)
          : await this.listAgentUuids()
    const entityIds = [...new Set(requestedEntityIds.map(id => id.trim()).filter(Boolean))]

    const series: MetricSeries[] = []
    const loadMetricKeys = metricKeys.filter(key => !key.startsWith('ping.'))
    if (loadMetricKeys.length) {
      await Promise.all(entityIds.map(async (uuid) => {
        const records = Object.keys(params.tags ?? {}).length
          ? []
          : await this.queryHistoricalSummary(uuid, start, end, Number.MAX_SAFE_INTEGER)
        for (const metricKey of loadMetricKeys) {
          const definition = METRIC_DEFINITIONS.find(item => item.name === metricKey)
          if (!definition)
            continue
          const rawPoints: MetricPoint[] = records.map(record => ({
            time: record.time,
            value: metricValue(record, metricKey),
            count: 1,
          }))
          const aggregation = metricAggregation(params, metricKey)
          const maxPoints = metricMaxPoints(params, metricKey)
          const fillEmpty = params.fill_empty === true
          const sampled = downsampleMetricPoints(
            rawPoints,
            metricKey,
            start,
            end,
            maxPoints,
            aggregation,
            fillEmpty,
          )
          series.push({
            metric_key: metricKey,
            entity_id: uuid,
            type: definition.type,
            unit: definition.unit,
            retention_days: definition.retention_days,
            downsampled: sampled.downsampled,
            ...(sampled.downsampled ? { downsample_algorithm: aggregation } : {}),
            fill_empty: fillEmpty,
            max_points: maxPoints,
            ...(sampled.intervalSeconds === undefined ? {} : { interval_seconds: sampled.intervalSeconds }),
            count: sampled.points.length,
            points: sampled.points,
            tags: { ...(params.tags ?? {}) },
          })
        }
      }))
    }

    const pingMetricKeys = metricKeys.filter(key => key.startsWith('ping.'))
    if (pingMetricKeys.length) {
      let rowsByEntity: Map<string, TaskRow[]>
      if (entityIds.length > 1) {
        try {
          const requested = new Set(entityIds)
          const rows = await this.queryTaskRows(undefined, start, end)
          rowsByEntity = groupBy(
            rows.filter(row => requested.has(row.uuid)),
            row => row.uuid,
          )
        }
        catch {
          rowsByEntity = new Map(await Promise.all(entityIds.map(async uuid => [
            uuid,
            await this.queryTaskRows(uuid, start, end),
          ] as const)))
        }
      }
      else {
        const uuid = entityIds[0]
        rowsByEntity = new Map(uuid
          ? [[uuid, await this.queryTaskRows(uuid, start, end)]]
          : [])
      }

      for (const uuid of entityIds) {
        const rows = (rowsByEntity.get(uuid) ?? [])
          .filter(row => taskMatchesMetricQuery(row, params))
        const byTask = groupBy(rows, row => `${row.taskId}\u0000${row.name}`)
        if (!byTask.size) {
          series.push(...this.emptyMetricResult({ ...params, metric_keys: pingMetricKeys }, [uuid]).series)
          continue
        }
        for (const taskRows of byTask.values()) {
          const first = taskRows[0]
          if (!first)
            continue
          const tags = {
            task_id: String(first.taskId),
            task_name: first.name,
            task_type: first.type,
            task_interval: String(inferredTaskInterval(taskRows)),
          }
          for (const metricKey of pingMetricKeys) {
            const definition = METRIC_DEFINITIONS.find(item => item.name === metricKey)
            if (!definition)
              continue
            const rawPoints: MetricPoint[] = taskRows.map(row => ({
              time: new Date(row.timestamp).toISOString(),
              value: metricKey === 'ping.loss' ? (row.value < 0 ? 1 : 0) : row.value,
              count: 1,
            }))
            const aggregation = metricAggregation(params, metricKey)
            const maxPoints = metricMaxPoints(params, metricKey)
            const fillEmpty = params.fill_empty === true
            const sampled = downsampleMetricPoints(
              rawPoints,
              metricKey,
              start,
              end,
              maxPoints,
              aggregation,
              fillEmpty,
            )
            series.push({
              metric_key: metricKey,
              entity_id: uuid,
              type: definition.type,
              unit: definition.unit,
              retention_days: definition.retention_days,
              downsampled: sampled.downsampled,
              ...(sampled.downsampled ? { downsample_algorithm: aggregation } : {}),
              fill_empty: fillEmpty,
              max_points: maxPoints,
              ...(sampled.intervalSeconds === undefined ? {} : { interval_seconds: sampled.intervalSeconds }),
              count: sampled.points.length,
              points: sampled.points,
              tags,
            })
          }
        }
      }
    }

    series.sort((left, right) => `${left.entity_id}:${left.metric_key}:${left.tags.task_id ?? ''}`
      .localeCompare(`${right.entity_id}:${right.metric_key}:${right.tags.task_id ?? ''}`))
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      server_downsample_default: true,
      default_points: DEFAULT_METRIC_POINTS,
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

  private async refreshTrafficPeriodsIfNeeded(requestedIds: string[]): Promise<void> {
    if (this.trafficPeriodExpiresAt > Date.now())
      return
    if (!this.trafficPeriodRefreshPromise) {
      const cachedIds = Object.keys(this.clientCache)
      const ids = [...new Set((cachedIds.length ? cachedIds : requestedIds).filter(Boolean))]
      this.trafficPeriodRefreshPromise = this.loadTrafficPeriods(ids)
        .then((periods) => {
          const merged = { ...this.trafficPeriodCache }
          for (const [uuid, period] of Object.entries(periods)) {
            const previous = merged[uuid]
            merged[uuid] = previous?.enabled && period.enabled && previous.start === period.start
              ? { ...period, used: Math.max(previous.used, period.used) }
              : period
          }
          this.trafficPeriodCache = merged
          this.trafficPeriodExpiresAt = Date.now() + TRAFFIC_PERIOD_CACHE_TTL_MS
        })
        .catch((error) => {
          this.trafficPeriodExpiresAt = Date.now() + TRAFFIC_PERIOD_RETRY_MS
          throw error
        })
        .finally(() => {
          this.trafficPeriodRefreshPromise = null
        })
    }
    await this.trafficPeriodRefreshPromise
  }

  private async loadTrafficPeriods(uuids: string[]): Promise<Record<string, TrafficPeriodState>> {
    if (!uuids.length)
      return {}
    const namespaceKeys = uuids.flatMap(uuid => TRAFFIC_PERIOD_METADATA_KEYS.map(key => ({ namespace: uuid, key })))
    const payload = await this.rpc.call<unknown>('kv_get_multi_value', { namespace_key: namespaceKeys })
    const kvByNamespace = kvPayloadByNamespace(payload)
    return Object.fromEntries(uuids.map(uuid => [uuid, trafficPeriodMetadata(kvByNamespace[uuid] ?? {})]))
  }

  private toStatus(
    uuid: string,
    dynamic: Record<string, unknown>,
    now: number,
    previousTraffic?: RawTrafficState,
    applyTrafficPeriod = false,
  ): KomariNodeStatus {
    const timestamp = timestampMs(dynamic.timestamp ?? dynamic.storage_time)
    const ramTotal = firstFiniteValue(dynamic, ['total_memory'])
    const swapTotal = firstFiniteValue(dynamic, ['total_swap'])
    const diskTotal = firstFiniteValue(dynamic, ['total_space'])
    const diskUsed = Math.max(0, diskTotal - firstFiniteValue(dynamic, ['available_space']))
    const time = new Date(timestamp || 0).toISOString()
    const rawTraffic = rawTrafficState(dynamic)
    const tcpConnections = Math.max(0, firstFiniteValue(dynamic, ['tcp_connections']))
    const udpConnections = Math.max(0, firstFiniteValue(dynamic, ['udp_connections']))
    const totals = applyTrafficPeriod
      ? currentPeriodTraffic(rawTraffic.up, rawTraffic.down, this.trafficPeriodCache[uuid])
      : { up: rawTraffic.up, down: rawTraffic.down }

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
      net_total_up: totals.up,
      net_total_down: totals.down,
      traffic_up: trafficDelta(rawTraffic, previousTraffic, 'up'),
      traffic_down: trafficDelta(rawTraffic, previousTraffic, 'down'),
      process: firstFiniteValue(dynamic, ['process_count']),
      connections: tcpConnections + udpConnections,
      connections_udp: udpConnections,
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
    const fetchStart = Math.max(0, start - TRAFFIC_PREDECESSOR_LOOKBACK_MS)
    for (let from = fetchStart; from < end; from += windowMs)
      windows.push({ from, to: Math.min(end, from + windowMs) })

    const rows: Record<string, unknown>[] = []
    let successfulQueries = 0
    let firstFailure: unknown
    for (let index = 0; index < windows.length; index += 4) {
      const batch = windows.slice(index, index + 4).map(({ from, to }) => this.rpc.call<unknown>(
        'agent_query_dynamic_summary',
        {
          query: {
            condition: [{ uuid }, { timestamp_from: from }, { timestamp_to: to }, { limit: 10_000 }],
            fields: DYNAMIC_FIELDS,
          },
        },
      ))
      for (const result of await Promise.allSettled(batch)) {
        if (result.status === 'rejected') {
          firstFailure ??= result.reason
          continue
        }
        successfulQueries += 1
        const response = result.value
        for (const row of arrayPayload(response)) {
          if (isRecord(row))
            rows.push(row)
        }
      }
    }
    if (windows.length && successfulQueries === 0)
      throw firstFailure ?? new Error('NodeGet historical query failed')

    const unique = new Map<number, Record<string, unknown>>()
    for (const row of rows) {
      const timestamp = timestampMs(row.timestamp ?? row.storage_time)
      if (timestamp >= fetchStart && timestamp <= end)
        unique.set(timestamp, row)
    }
    const records: KomariStatusRecord[] = []
    let previousTraffic: RawTrafficState | undefined
    for (const [timestamp, row] of [...unique.entries()].sort(([left], [right]) => left - right)) {
      const status = this.toStatus(uuid, row, Number.MAX_SAFE_INTEGER, previousTraffic)
      previousTraffic = rawTrafficState(row)
      if (timestamp >= start)
        records.push(recordFromStatus(status))
    }
    return downsampleEvenly(records, maxCount)
  }

  private async queryTaskRows(
    uuid: string | undefined,
    start: number,
    end: number,
    windowMs = 3_600_000,
  ): Promise<TaskRow[]> {
    const windows: Array<{ from: number, to: number }> = []
    for (let from = start; from < end; from += windowMs)
      windows.push({ from, to: Math.min(end, from + windowMs) })

    const rawRows: RawTaskRow[] = []
    let successfulQueries = 0
    let firstFailure: unknown
    for (let index = 0; index < windows.length; index += 4) {
      const batch = windows.slice(index, index + 4).flatMap(({ from, to }) => ['ping', 'tcp_ping'].map((type) => {
        const condition: Record<string, unknown>[] = []
        if (uuid)
          condition.push({ uuid })
        condition.push(
          { type },
          { timestamp_from_to: [from, to] },
          { limit: 10_000 },
        )
        return this.rpc.call<unknown>('task_query', { task_data_query: { condition } })
          .then(response => ({ requestedType: type, response }))
      }))

      for (const result of await Promise.allSettled(batch)) {
        if (result.status === 'rejected') {
          firstFailure ??= result.reason
          continue
        }
        successfulQueries += 1
        const { requestedType, response } = result.value
        for (const row of arrayPayload(response)) {
          if (isRecord(row))
            rawRows.push({ row, requestedType })
        }
      }
    }
    if (windows.length && successfulQueries === 0)
      throw firstFailure ?? new Error('NodeGet task query failed')

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
      const taskEvent = isRecord(row.task_event_type) ? row.task_event_type : {}
      const target = stringValue(taskEvent[type])
      const name = stringValue(row.cron_source ?? row.task_name, target || type)
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
    const tasks = [...grouped.entries()].map(([id, taskRows]): KomariPingTask => {
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
        interval: inferredTaskInterval(taskRows),
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
    })

    return rankPingTasks(tasks).sort((left, right) => left.id - right.id)
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
    const keys = [...new Set(requested.map(key => key.trim()).filter(Boolean))]
    if (!keys.length)
      throw new Error('metric_keys is required')
    const unknown = keys.find(key => !supported.has(key))
    if (unknown)
      throw new Error(`Unknown metric key: ${unknown}`)
    return keys
  }
}
