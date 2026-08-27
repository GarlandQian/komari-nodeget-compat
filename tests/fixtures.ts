import type {
  KomariClient,
  KomariNodeStatus,
  KomariPingTask,
  KomariPublicInfo,
  KomariStatusRecord,
  KomariVersionInfo,
  LoadRecordQuery,
  MetricDefinition,
  MetricQueryParams,
  MetricQueryResult,
  MonitorProvider,
  PingRecordQuery,
  PingRecordsResult,
} from '../src/types'

export const TEST_UUID = '11111111-1111-4111-8111-111111111111'
export const TEST_TIME = '2026-08-25T12:00:00.000Z'

export function testClient(uuid = TEST_UUID): KomariClient {
  return {
    uuid,
    name: 'Test Node',
    cpu_name: 'Test CPU',
    virtualization: 'kvm',
    arch: 'x86_64',
    cpu_cores: 4,
    cpu_physical_cores: 2,
    os: 'Test Linux',
    kernel_version: '6.0.0',
    gpu_name: '',
    ipv4: '',
    ipv6: '',
    region: 'Test Region',
    provider: 'Test Provider',
    city: 'Test City',
    country: 'US',
    asn: 'AS64500',
    remark: '',
    public_remark: 'Public',
    mem_total: 8_000,
    swap_total: 2_000,
    disk_total: 100_000,
    weight: 1,
    price: 5,
    billing_cycle: 30,
    auto_renewal: false,
    currency: 'USD',
    expired_at: null,
    group: 'Test',
    tags: 'demo',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    created_at: '',
    updated_at: TEST_TIME,
  }
}

export function testStatus(uuid = TEST_UUID): KomariNodeStatus {
  return {
    client: uuid,
    time: TEST_TIME,
    cpu: 12.5,
    gpu: 0,
    ram: 4_000,
    ram_total: 8_000,
    swap: 100,
    swap_total: 2_000,
    load: 0.4,
    load5: 0.3,
    load15: 0.2,
    temp: 45,
    disk: 50_000,
    disk_total: 100_000,
    net_in: 1_000,
    net_out: 500,
    net_total_up: 10_000,
    net_total_down: 20_000,
    traffic_up: 10_000,
    traffic_down: 20_000,
    process: 100,
    connections: 20,
    connections_udp: 5,
    online: true,
    uptime: 3_600,
    updated_at: TEST_TIME,
  }
}

function testRecord(uuid = TEST_UUID): KomariStatusRecord {
  const { online: _online, updated_at: _updatedAt, ...record } = testStatus(uuid)
  return record
}

export class FakeMonitorProvider implements MonitorProvider {
  closed = false

  async getPublicInfo(): Promise<KomariPublicInfo> {
    return {
      cors_origin_check_enabled: false,
      custom_body: '',
      custom_head: '',
      description: 'Test',
      disable_password_login: true,
      oauth_enable: false,
      oauth_provider: null,
      ping_record_preserve_time: 168,
      private_site: false,
      record_enabled: true,
      record_preserve_time: 720,
      metric_retention_days: 30,
      sitename: 'Test Site',
      theme: 'TestTheme',
      theme_settings: { dense: true },
    }
  }

  async getVersion(): Promise<KomariVersionInfo> {
    return { version: '1.3.0-nodeget', hash: 'test' }
  }

  async getClients(): Promise<Record<string, KomariClient>> {
    return { [TEST_UUID]: testClient() }
  }

  async getLatestStatuses(): Promise<Record<string, KomariNodeStatus>> {
    return { [TEST_UUID]: testStatus() }
  }

  async getRecentRecords(uuid: string, _limit: number): Promise<KomariStatusRecord[]> {
    return [testRecord(uuid)]
  }

  async getLoadRecords(query: LoadRecordQuery): Promise<KomariStatusRecord[] | Record<string, KomariStatusRecord[]>> {
    return query.uuid ? [testRecord(query.uuid)] : { [TEST_UUID]: [testRecord()] }
  }

  async getPingRecords(_query: PingRecordQuery): Promise<PingRecordsResult> {
    return {
      count: 2,
      records: [
        { client: TEST_UUID, task_id: 7, time: TEST_TIME, value: 20 },
        { client: TEST_UUID, task_id: 7, time: '2026-08-25T12:01:00.000Z', value: -1 },
      ],
      tasks: [this.pingTask()],
      basic_info: [{ client: TEST_UUID, loss: 50, min: 20, max: 20 }],
    }
  }

  async getPingTasks(): Promise<KomariPingTask[]> {
    return [this.pingTask()]
  }

  async listMetricDefinitions(): Promise<MetricDefinition[]> {
    return [
      { name: 'cpu.usage', description: 'CPU', type: 'gauge', unit: 'percent', retention_days: 30 },
      { name: 'ping.latency_ms', description: 'Ping', type: 'gauge', unit: 'ms', retention_days: 30 },
      { name: 'ping.loss', description: 'Loss', type: 'gauge', unit: 'ratio', retention_days: 30 },
    ]
  }

  async queryMetrics(_params: MetricQueryParams): Promise<MetricQueryResult> {
    return {
      start: TEST_TIME,
      end: '2026-08-25T12:01:00.000Z',
      count: 2,
      series: [
        {
          metric_key: 'ping.latency_ms', entity_id: TEST_UUID, type: 'gauge', unit: 'ms',
          downsampled: false, count: 2,
          points: [{ time: TEST_TIME, value: 20 }, { time: '2026-08-25T12:01:00.000Z', value: null }],
          tags: { task_id: '7', task_name: 'Test Ping' },
        },
        {
          metric_key: 'ping.loss', entity_id: TEST_UUID, type: 'gauge', unit: 'ratio',
          downsampled: false, count: 2,
          points: [{ time: TEST_TIME, value: 0 }, { time: '2026-08-25T12:01:00.000Z', value: 1 }],
          tags: { task_id: '7', task_name: 'Test Ping' },
        },
      ],
    }
  }

  close(): void {
    this.closed = true
  }

  private pingTask(): KomariPingTask {
    return {
      id: 7,
      name: 'Test Ping',
      clients: [TEST_UUID],
      default_on: true,
      type: 'icmp',
      interval: 60,
    }
  }
}
