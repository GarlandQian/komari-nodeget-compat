import type {
  JsonRpcFailure,
  JsonRpcRequest,
  JsonRpcResponse,
  KomariMeInfo,
  KomariNodeStatus,
  KomariStatusRecord,
  MetricQueryParams,
  MetricSeries,
  MonitorProvider,
} from '../types'
import { finiteNumber, isRecord, publicErrorMessage } from '../shared/utils'

const PUBLIC_ME: KomariMeInfo = {
  logged_in: false,
  username: 'Guest',
  uuid: '',
  '2fa_enabled': false,
  'sso_id': '',
  'sso_type': '',
}

const SUPPORTED_METHODS = [
  'rpc.ping',
  'rpc.version',
  'rpc.methods',
  'rpc.getMethods',
  'rpc.help',
  'rpc.getHelp',
  'rpc.getVersion',
  'common:getVersion',
  'common:getBackendVersion',
  'common:getPublicInfo',
  'common:getMe',
  'common:getNodes',
  'common:getNodesLatestStatus',
  'common:getNodeRecentStatus',
  'common:getRecords',
  'public:getMe',
  'public:getVersion',
  'public:getPublicSettings',
  'public:getNodesInformation',
  'public:getClientRecentRecords',
  'public:getRecordsByUUID',
  'public:getPingRecords',
  'public:getPublicPingTasks',
  'public:listMetricDefinitions',
  'public:queryMetrics',
  'public:getPingMetricStats',
  'public:recordVisitorEvent',
] as const

class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'RpcFault'
  }
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

function apiSuccess(data: unknown): Response {
  return jsonResponse({ status: 'success', message: '', data })
}

function apiError(status: number, message: string): Response {
  return jsonResponse({ status: 'error', message, data: null }, { status })
}

function isRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && typeof value.method === 'string'
}

function rpcFailure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

function requestId(request: JsonRpcRequest): string | number | null {
  return request.id === undefined ? null : request.id
}

function parameter(
  params: JsonRpcRequest['params'],
  name: string,
  index: number,
): unknown {
  if (Array.isArray(params))
    return params[index]
  if (isRecord(params))
    return params[name]
  return undefined
}

function stringParameter(params: JsonRpcRequest['params'], name: string, index: number): string | undefined {
  const value = parameter(params, name, index)
  if (value == null || value === '')
    return undefined
  return String(value)
}

function numberParameter(
  params: JsonRpcRequest['params'],
  names: string[],
  index: number,
  fallback: number,
): number {
  for (const name of names) {
    const value = parameter(params, name, index)
    if (value !== undefined)
      return finiteNumber(value, fallback)
  }
  return fallback
}

function requiredString(params: JsonRpcRequest['params'], name: string, index: number): string {
  const value = stringParameter(params, name, index)
  if (!value)
    throw new RpcFault(-32602, `Missing required parameter: ${name}`)
  return value
}

function metricParams(params: JsonRpcRequest['params']): MetricQueryParams {
  if (Array.isArray(params)) {
    const first = params[0]
    return isRecord(first) ? first as MetricQueryParams : {}
  }
  return isRecord(params) ? params as MetricQueryParams : {}
}

function realtimeRecord(record: KomariStatusRecord | KomariNodeStatus): Record<string, unknown> {
  return {
    client: record.client,
    time: record.time,
    cpu: { usage: record.cpu },
    gpu: { usage: record.gpu },
    ram: { used: record.ram, total: record.ram_total },
    swap: { used: record.swap, total: record.swap_total },
    load: { load1: record.load, load5: record.load5, load15: record.load15 },
    disk: { used: record.disk, total: record.disk_total },
    network: {
      up: record.net_out,
      down: record.net_in,
      totalUp: record.net_total_up,
      totalDown: record.net_total_down,
    },
    connections: {
      tcp: Math.max(0, record.connections - record.connections_udp),
      udp: record.connections_udp,
    },
    uptime: record.uptime,
    process: record.process,
    online: 'online' in record ? record.online : true,
  }
}

function percentile(values: number[], quantile: number): number | undefined {
  if (!values.length)
    return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))
  return sorted[index]
}

function taskIdForSeries(series: MetricSeries): string {
  return series.tags.task_id ?? series.tags.task ?? series.tags.id ?? ''
}

function responseRange(start: string | undefined, end: string | undefined, hours: number): { from: string, to: string } {
  const endCandidate = end ? Date.parse(end) : Date.now()
  const endTime = Number.isFinite(endCandidate) ? endCandidate : Date.now()
  const startCandidate = start ? Date.parse(start) : endTime - Math.max(1, hours) * 3_600_000
  const startTime = Number.isFinite(startCandidate) ? startCandidate : endTime - 3_600_000
  const from = Math.min(startTime, endTime)
  const to = Math.max(startTime, endTime)
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

function recordCount(records: KomariStatusRecord[] | Record<string, KomariStatusRecord[]>): number {
  return Array.isArray(records)
    ? records.length
    : Object.values(records).reduce((count, values) => count + values.length, 0)
}

const LOAD_TYPES = new Set([
  'cpu', 'gpu', 'ram', 'swap', 'load', 'temp', 'disk', 'network', 'process', 'connections', 'all', '',
])

function loadTypeParameter(params: JsonRpcRequest['params'], index: number): string {
  const loadType = stringParameter(params, 'load_type', index) ?? ''
  if (!LOAD_TYPES.has(loadType))
    throw new RpcFault(-32602, `Invalid load_type parameter: ${loadType}`)
  return loadType
}

function projectLoadRecord(record: KomariStatusRecord, loadType: string): Record<string, unknown> {
  const base: Record<string, unknown> = { client: record.client, time: record.time }
  switch (loadType) {
    case 'cpu': return { ...base, cpu: record.cpu }
    case 'gpu': return { ...base, gpu: record.gpu }
    case 'ram': return {
      ...base,
      ram: record.ram,
      ram_total: record.ram_total,
      ...(record.ram_total > 0 ? { ram_percent: record.ram / record.ram_total * 100 } : {}),
    }
    case 'swap': return {
      ...base,
      swap: record.swap,
      swap_total: record.swap_total,
      ...(record.swap_total > 0 ? { swap_percent: record.swap / record.swap_total * 100 } : {}),
    }
    case 'load': return { ...base, load: record.load }
    case 'temp': return { ...base, temp: record.temp }
    case 'disk': return {
      ...base,
      disk: record.disk,
      disk_total: record.disk_total,
      ...(record.disk_total > 0 ? { disk_percent: record.disk / record.disk_total * 100 } : {}),
    }
    case 'network': return {
      ...base,
      net_in: record.net_in,
      net_out: record.net_out,
      net_total_up: record.net_total_up,
      net_total_down: record.net_total_down,
    }
    case 'process': return { ...base, process: record.process }
    case 'connections': return {
      ...base,
      connections: record.connections,
      connections_udp: record.connections_udp,
      connections_tcp: Math.max(0, record.connections - record.connections_udp),
    }
    default: return record
  }
}

function projectLoadRecords(
  records: KomariStatusRecord[] | Record<string, KomariStatusRecord[]>,
  loadType: string,
): KomariStatusRecord[] | Record<string, Array<KomariStatusRecord | Record<string, unknown>>> {
  if (!loadType || loadType === 'all')
    return records
  if (Array.isArray(records))
    return records.map(record => projectLoadRecord(record, loadType)) as KomariStatusRecord[]
  return Object.fromEntries(Object.entries(records).map(([uuid, values]) => [
    uuid,
    values.map(record => projectLoadRecord(record, loadType)),
  ]))
}

function groupedLoadRecords(
  records: KomariStatusRecord[] | Record<string, KomariStatusRecord[]>,
  uuid: string | undefined,
): Record<string, KomariStatusRecord[]> {
  if (!Array.isArray(records))
    return records
  if (uuid)
    return { [uuid]: records }
  const grouped: Record<string, KomariStatusRecord[]> = {}
  for (const record of records) {
    grouped[record.client] ??= []
    grouped[record.client]!.push(record)
  }
  return grouped
}

function metricKeysFromParams(params: MetricQueryParams): string[] {
  return params.metric_keys ?? params.metrics ?? (params.metric_key ? [params.metric_key] : [])
}

function metricInvalidParams(error: unknown): boolean {
  return error instanceof Error && /metric_keys|required|metric key|max points|aggregation/i.test(error.message)
}

export class KomariFacade {
  constructor(private readonly provider: MonitorProvider) {}

  get supportedMethods(): readonly string[] {
    return SUPPORTED_METHODS
  }

  async handleHttp(request: Request): Promise<Response | null> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/'))
      return null

    try {
      if (request.method === 'GET' && url.pathname === '/api/public')
        return apiSuccess(await this.provider.getPublicInfo())
      if (request.method === 'GET' && url.pathname === '/api/version')
        return apiSuccess(await this.provider.getVersion())
      if (request.method === 'GET' && url.pathname === '/api/me')
        return jsonResponse(PUBLIC_ME)
      if (request.method === 'GET' && url.pathname === '/api/nodes')
        return apiSuccess(Object.values(await this.provider.getClients()))
      if (request.method === 'GET' && url.pathname === '/api/task/ping')
        return apiSuccess(await this.provider.getPingTasks())

      const recentMatch = /^\/api\/recent\/([^/]+)$/.exec(url.pathname)
      if (request.method === 'GET' && recentMatch) {
        const uuid = decodeURIComponent(recentMatch[1]!)
        const limit = finiteNumber(url.searchParams.get('limit'), 150)
        const records = await this.provider.getRecentRecords(uuid, limit)
        return apiSuccess(records.map(realtimeRecord))
      }

      if (request.method === 'GET' && ['/api/records', '/api/records/load', '/api/records/ping'].includes(url.pathname))
        return this.handleLegacyRecordsHttp(url)

      if (url.pathname === '/api/rpc2' && request.method === 'POST')
        return this.handleRpcHttp(request)

      if (url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/clients/terminal'))
        return apiError(403, 'Administrative Komari operations are disabled by the NodeGet compatibility layer')

      return apiError(404, `Unsupported Komari endpoint: ${request.method} ${url.pathname}`)
    }
    catch (error) {
      return apiError(502, publicErrorMessage(error))
    }
  }

  async handleRpcPayload(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(payload)) {
      if (!payload.length)
        return rpcFailure(null, -32600, 'Invalid Request')
      const responses = await Promise.all(payload.map(item => this.handleRpcRequest(item)))
      const visible = responses.filter((item): item is JsonRpcResponse => item !== null)
      return visible.length ? visible : null
    }
    return this.handleRpcRequest(payload)
  }

  async getRealtimeSnapshot(uuid?: string): Promise<Record<string, unknown>> {
    const statuses = await this.provider.getLatestStatuses(uuid ? [uuid] : undefined)
    const data = Object.fromEntries(Object.entries(statuses).map(([client, status]) => [
      client,
      realtimeRecord(status),
    ]))
    return {
      status: 'success',
      message: '',
      data: {
        online: Object.entries(statuses).filter(([, status]) => status.online).map(([client]) => client),
        data,
      },
    }
  }

  close(): void {
    this.provider.close()
  }

  private async handleRpcHttp(request: Request): Promise<Response> {
    let payload: unknown
    try {
      payload = await request.json()
    }
    catch {
      return jsonResponse(rpcFailure(null, -32700, 'Parse error'))
    }

    const response = await this.handleRpcPayload(payload)
    return response === null ? new Response(null, { status: 204 }) : jsonResponse(response)
  }

  private async handleRpcRequest(value: unknown): Promise<JsonRpcResponse | null> {
    if (!isRpcRequest(value))
      return rpcFailure(null, -32600, 'Invalid Request')
    const notification = value.id === undefined
    try {
      const result = await this.invoke(value.method, value.params)
      return notification ? null : { jsonrpc: '2.0', id: requestId(value), result }
    }
    catch (error) {
      if (notification)
        return null
      if (error instanceof RpcFault)
        return rpcFailure(requestId(value), error.code, error.message, error.data)
      return rpcFailure(requestId(value), -32603, publicErrorMessage(error))
    }
  }

  private async invoke(method: string, params: JsonRpcRequest['params']): Promise<unknown> {
    if (method.startsWith('admin:'))
      throw new RpcFault(-32601, 'Administrative RPC methods are disabled')

    switch (method) {
      case 'rpc.ping': return 'pong'
      case 'rpc.version': return '1.0'
      case 'rpc.methods':
      case 'rpc.getMethods': return [...SUPPORTED_METHODS]
      case 'rpc.help':
      case 'rpc.getHelp': return this.rpcHelp(stringParameter(params, 'method', 0))
      case 'rpc.getVersion':
      case 'common:getVersion':
      case 'common:getBackendVersion':
      case 'public:getVersion': return this.provider.getVersion()
      case 'common:getPublicInfo':
      case 'public:getPublicSettings': return this.provider.getPublicInfo()
      case 'common:getMe':
      case 'public:getMe': return PUBLIC_ME
      case 'common:getNodes': {
        const uuid = stringParameter(params, 'uuid', 0)
        const clients = await this.provider.getClients()
        if (!uuid)
          return clients
        const client = clients[uuid]
        if (!client)
          throw new RpcFault(-32004, `Node not found: ${uuid}`)
        return client
      }
      case 'public:getNodesInformation': return Object.values(await this.provider.getClients())
      case 'common:getNodesLatestStatus': {
        const one = stringParameter(params, 'uuid', 0)
        const many = parameter(params, 'uuids', 1)
        const uuids = one ? [one] : Array.isArray(many) ? many.map(String) : undefined
        const statuses = await this.provider.getLatestStatuses(uuids)
        if (!one)
          return statuses
        const status = statuses[one]
        if (!status)
          throw new RpcFault(-32602, `Node not found: ${one}`)
        return status
      }
      case 'common:getNodeRecentStatus': {
        const uuid = requiredString(params, 'uuid', 0)
        const limit = numberParameter(params, ['limit'], 1, 150)
        const records = await this.provider.getRecentRecords(uuid, limit)
        return { count: records.length, records }
      }
      case 'common:getRecords': return this.commonRecords(params)
      case 'public:getClientRecentRecords': {
        const uuid = requiredString(params, 'uuid', 0)
        return this.provider.getRecentRecords(uuid, 150)
      }
      case 'public:getRecordsByUUID': {
        const uuid = requiredString(params, 'uuid', 0)
        const loadType = loadTypeParameter(params, 1)
        const hours = numberParameter(params, ['hours'], 2, 4)
        const maxCount = numberParameter(params, ['maxCount', 'max_count'], 3, 6_000)
        const records = await this.provider.getLoadRecords({ uuid, hours, maxCount })
        const list = Array.isArray(records) ? records : records[uuid] ?? []
        const projected = projectLoadRecords(list, loadType)
        return {
          count: list.length,
          records: projected,
          ...(loadType && loadType !== 'all' ? { load_type: loadType } : {}),
        }
      }
      case 'public:getPingRecords': {
        const uuid = stringParameter(params, 'uuid', 0)
        const taskIdValue = parameter(params, 'task_id', 1)
        const hasTaskId = taskIdValue !== undefined && taskIdValue !== null && taskIdValue !== ''
        if (!uuid && !hasTaskId)
          throw new RpcFault(-32602, 'UUID or task_id is required')
        const rawTaskId = hasTaskId ? Number(taskIdValue) : 0
        if (hasTaskId && !Number.isInteger(rawTaskId))
          throw new RpcFault(-32602, 'Invalid task_id parameter')
        const taskId = rawTaskId > 0 ? rawTaskId : undefined
        const hours = numberParameter(params, ['hours'], 2, 4)
        const maxCount = numberParameter(params, ['maxCount', 'max_count'], 3, 6_000)
        return this.provider.getPingRecords({
          ...(uuid ? { uuid } : {}),
          ...(taskId ? { taskId } : {}),
          hours,
          maxCount,
        })
      }
      case 'public:getPublicPingTasks': return this.provider.getPingTasks()
      case 'public:listMetricDefinitions': return this.provider.listMetricDefinitions()
      case 'public:queryMetrics': {
        const query = metricParams(params)
        if (!metricKeysFromParams(query).length)
          throw new RpcFault(-32602, 'metric_keys is required')
        try {
          return await this.provider.queryMetrics(query)
        }
        catch (error) {
          if (metricInvalidParams(error))
            throw new RpcFault(-32602, publicErrorMessage(error))
          throw error
        }
      }
      case 'public:getPingMetricStats': return this.pingMetricStats(metricParams(params))
      case 'public:recordVisitorEvent': return { status: 'disabled' }
      default: throw new RpcFault(-32601, `Method not found: ${method}`)
    }
  }

  private async commonRecords(params: JsonRpcRequest['params']): Promise<unknown> {
    const type = stringParameter(params, 'type', 0) ?? 'load'
    if (type !== 'load' && type !== 'ping')
      throw new RpcFault(-32602, `Invalid record type: ${type}`)
    const uuid = stringParameter(params, 'uuid', 1)
    const hours = numberParameter(params, ['hours'], 2, 1)
    const start = stringParameter(params, 'start', 3)
    const end = stringParameter(params, 'end', 4)
    const loadType = loadTypeParameter(params, 5)
    const rawTaskId = numberParameter(params, ['task_id'], 6, 0)
    const taskId = rawTaskId > 0 ? rawTaskId : undefined
    const requestedMaxCount = numberParameter(params, ['maxCount', 'max_count'], 7, 4_000)
    const maxCount = requestedMaxCount === 0 ? 4_000 : requestedMaxCount
    const range = responseRange(start, end, hours)
    if (type === 'ping') {
      const result = await this.provider.getPingRecords({
        ...(uuid ? { uuid } : {}),
        ...(taskId ? { taskId } : {}),
        hours,
        maxCount,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      })
      return { ...result, ...range }
    }
    const records = await this.provider.getLoadRecords({
      ...(uuid ? { uuid } : {}),
      hours,
      maxCount,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    })
    const grouped = groupedLoadRecords(records, uuid)
    const projected = projectLoadRecords(grouped, loadType)
    return {
      count: recordCount(records),
      records: projected,
      ...(loadType && loadType !== 'all' ? { load_type: loadType } : {}),
      ...range,
    }
  }

  private async handleLegacyRecordsHttp(url: URL): Promise<Response> {
    const type = url.pathname.endsWith('/ping') ? 'ping' : url.searchParams.get('type') ?? 'load'
    if (type !== 'load' && type !== 'ping')
      throw new RpcFault(-32602, `Invalid record type: ${type}`)
    const uuid = url.searchParams.get('uuid') || undefined
    const hours = finiteNumber(url.searchParams.get('hours'), 4)
    const maxCount = finiteNumber(url.searchParams.get('maxCount') ?? url.searchParams.get('max_count'), 6_000)
    const start = url.searchParams.get('start') || undefined
    const end = url.searchParams.get('end') || undefined
    const loadType = url.searchParams.get('load_type') ?? ''
    if (!LOAD_TYPES.has(loadType))
      throw new RpcFault(-32602, `Invalid load_type parameter: ${loadType}`)
    const range = responseRange(start, end, hours)
    if (type === 'ping') {
      const rawTaskId = finiteNumber(url.searchParams.get('task_id'), 0)
      const taskId = rawTaskId > 0 ? rawTaskId : undefined
      const result = await this.provider.getPingRecords({
        ...(uuid ? { uuid } : {}),
        ...(taskId ? { taskId } : {}),
        hours,
        maxCount,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      })
      return apiSuccess({ ...result, ...range })
    }
    const records = await this.provider.getLoadRecords({
      ...(uuid ? { uuid } : {}),
      hours,
      maxCount,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    })
    const projected = projectLoadRecords(records, loadType)
    return apiSuccess({
      count: recordCount(records),
      records: projected,
      ...(loadType && loadType !== 'all' ? { load_type: loadType } : {}),
      ...range,
    })
  }

  private rpcHelp(method?: string): unknown {
    const describe = (name: string) => ({
      name,
      summary: 'Implemented by the NodeGet compatibility layer',
      description: 'Read-only compatibility method backed by NodeGet data.',
      params: [],
      returns: 'See the Komari public RPC documentation.',
    })
    return method ? describe(method) : SUPPORTED_METHODS.map(describe)
  }

  private async pingMetricStats(params: MetricQueryParams): Promise<unknown> {
    const maxPoints = Number.isInteger(params.max_points) && (params.max_points ?? 0) > 0
      ? Math.min(params.max_points!, 20_000)
      : 500
    const result = await this.provider.queryMetrics({
      ...params,
      ...(params.entity_id || params.entity_ids?.length || !params.uuid
        ? {}
        : { entity_id: params.uuid }),
      metric_keys: ['ping.latency_ms', 'ping.loss'],
      fill_empty: true,
      max_points: maxPoints,
    })
    const requestedTaskIds = new Set([params.task_id, ...(params.task_ids ?? [])]
      .filter(value => value !== undefined && value !== null && value !== '')
      .map(String))
    const lossByKey = new Map<string, MetricSeries>()
    for (const series of result.series) {
      if (series.metric_key === 'ping.loss')
        lossByKey.set(`${series.entity_id}\u0000${taskIdForSeries(series)}`, series)
    }

    const stats = result.series.flatMap((series) => {
      if (series.metric_key !== 'ping.latency_ms')
        return []
      const taskId = taskIdForSeries(series)
      if (!taskId)
        return []
      if (requestedTaskIds.size && !requestedTaskIds.has(taskId))
        return []
      const valid = series.points.map(point => point.value).filter((value): value is number => typeof value === 'number')
      const lossSeries = lossByKey.get(`${series.entity_id}\u0000${taskId}`)
      const lossPoints = lossSeries?.points.filter((point): point is typeof point & { value: number } => (
        typeof point.value === 'number'
      )) ?? []
      const total = lossPoints.reduce((count, point) => count + (point.count ?? 1), 0)
      if (total <= 0)
        return []
      const lost = lossPoints.reduce((count, point) => count + point.value * (point.count ?? 1), 0)
      const p50 = percentile(valid, 0.5)
      const p99 = percentile(valid, 0.99)
      const average = valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : undefined
      const stddev = average === undefined
        ? undefined
        : Math.sqrt(valid.reduce((sum, value) => sum + (value - average) ** 2, 0) / valid.length)
      const p99P50Ratio = p50 !== undefined && p99 !== undefined && p50 > 0 && p99 >= p50
        ? (p99 - p50) / Math.max(Math.min(p50, 50), 10)
        : 0
      return [{
        entity_id: series.entity_id,
        task_id: taskId,
        name: series.tags.task_name ?? taskId,
        type: series.tags.task_type ?? '',
        interval: Math.max(1, finiteNumber(series.tags.task_interval, 20)),
        tags: series.tags,
        total: total || series.points.reduce((count, point) => count + (point.count ?? 1), 0),
        valid: total ? Math.max(0, Math.round(total - lost)) : valid.length,
        loss: total ? lost / total * 100 : 0,
        loss_approximate: series.downsampled || lossSeries?.downsampled === true,
        p99_p50_ratio: p99P50Ratio,
        ...(valid.length
          ? {
              min: Math.min(...valid),
              max: Math.max(...valid),
              avg: average,
              latest: valid.at(-1),
              p50,
              p99,
              stddev,
            }
          : {}),
      }]
    })
    return {
      start: result.start,
      end: result.end,
      interval_seconds: Math.max(1, Math.ceil(
        Math.max(0, Date.parse(result.end) - Date.parse(result.start)) / 1_000 / maxPoints,
      )),
      stats,
      count: stats.length,
    }
  }
}

export { realtimeRecord }
