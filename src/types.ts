export interface NodeGetSiteToken {
  name?: string
  backend_url: string
  token: string
}

export interface NodeGetThemeConfig {
  user_preferences?: Record<string, unknown>
  site_tokens?: NodeGetSiteToken[]
}

export interface CompatManifest {
  schema: 1
  source: {
    name: string
    short: string
    version: string
    url?: string
  }
  themeSettingsDefaults: Record<string, unknown>
  themeSettingKeys: string[]
  themeSettingArrayKeys: string[]
}

export interface KomariVersionInfo {
  version: string
  hash: string
}

export interface KomariMeInfo {
  logged_in: false
  username: 'Guest'
  uuid: ''
  '2fa_enabled': false
  'sso_id': ''
  'sso_type': ''
}

export interface KomariPublicInfo {
  cors_origin_check_enabled: false
  custom_body: string
  custom_head: string
  description: string
  disable_password_login: true
  oauth_enable: false
  oauth_provider: null
  ping_record_preserve_time: number
  private_site: false
  record_enabled: true
  record_preserve_time: number
  sitename: string
  theme: string
  theme_settings: Record<string, unknown>
}

export interface KomariClient {
  uuid: string
  name: string
  cpu_name: string
  virtualization: string
  arch: string
  cpu_cores: number
  cpu_physical_cores?: number
  os: string
  kernel_version: string
  gpu_name: string
  ipv4: string
  ipv6: string
  region: string
  provider: string
  city: string
  country: string
  asn: string
  remark: string
  public_remark: string
  mem_total: number
  swap_total: number
  disk_total: number
  weight: number
  price: number
  billing_cycle: number
  auto_renewal: boolean
  currency: string
  expired_at: string | null
  group: string
  tags: string
  hidden: boolean
  traffic_limit: number
  traffic_limit_type: 'sum' | 'max' | 'min' | 'up' | 'down'
  created_at: string
  updated_at: string
}

export interface KomariNodeStatus {
  client: string
  time: string
  cpu: number
  gpu: number
  ram: number
  ram_total: number
  swap: number
  swap_total: number
  load: number
  load5: number
  load15: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  net_total_up: number
  net_total_down: number
  traffic_up: number
  traffic_down: number
  process: number
  connections: number
  connections_udp: number
  online: boolean
  uptime: number
  updated_at: string
}

export type KomariStatusRecord = Omit<KomariNodeStatus, 'online' | 'updated_at'>

export interface KomariPingRecord {
  client: string
  task_id: number
  time: string
  value: number
}

export interface KomariPingTask {
  id: number
  name: string
  clients: string[]
  default_on: boolean
  type: string
  interval: number
  loss?: number
  min?: number
  max?: number
  avg?: number
  total?: number
}

export interface KomariPingBasicInfo {
  client: string
  loss: number
  min: number
  max: number
}

export interface PingRecordsResult {
  count: number
  records: KomariPingRecord[]
  tasks: KomariPingTask[]
  basic_info: KomariPingBasicInfo[]
}

export interface MetricPoint {
  time: string
  value: number | null
  count?: number
}

export interface MetricSeries {
  metric_key: string
  entity_id: string
  type: 'gauge' | 'counter'
  unit: string
  downsampled: boolean
  count: number
  points: MetricPoint[]
  tags: Record<string, string>
}

export interface MetricQueryParams {
  metric_key?: string
  metric_keys?: string[]
  metrics?: string[]
  entity_id?: string
  entity_ids?: string[]
  start?: string
  start_time?: string
  end?: string
  end_time?: string
  hours?: number
  max_points?: number
  downsample_points?: number
  tags?: Record<string, string>
}

export interface MetricQueryResult {
  start: string
  end: string
  series: MetricSeries[]
  count: number
}

export interface MetricDefinition {
  name: string
  description: string
  type: 'gauge' | 'counter'
  unit: string
  retention_days: number
}

export interface LoadRecordQuery {
  uuid?: string
  hours: number
  maxCount: number
  start?: string
  end?: string
}

export interface PingRecordQuery {
  uuid?: string
  taskId?: number
  hours: number
  maxCount: number
  start?: string
  end?: string
}

export interface MonitorProvider {
  getPublicInfo(): Promise<KomariPublicInfo>
  getVersion(): Promise<KomariVersionInfo>
  getClients(): Promise<Record<string, KomariClient>>
  getLatestStatuses(uuids?: string[]): Promise<Record<string, KomariNodeStatus>>
  getRecentRecords(uuid: string, limit: number): Promise<KomariStatusRecord[]>
  getLoadRecords(query: LoadRecordQuery): Promise<KomariStatusRecord[] | Record<string, KomariStatusRecord[]>>
  getPingRecords(query: PingRecordQuery): Promise<PingRecordsResult>
  getPingTasks(): Promise<KomariPingTask[]>
  listMetricDefinitions(): Promise<MetricDefinition[]>
  queryMetrics(params: MetricQueryParams): Promise<MetricQueryResult>
  close(): void
}

export interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown> | unknown[]
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: string | number | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure
