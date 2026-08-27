import type { NodeGetCaller } from '../src/nodeget/rpc-client'
import { describe, expect, it } from 'bun:test'
import { NodeGetSource } from '../src/nodeget/source'
import { TEST_UUID } from './fixtures'

interface CallRecord {
  method: string
  params: Record<string, unknown>
}

const GIBIBYTE_BYTES = 1024 ** 3

class FixtureCaller implements NodeGetCaller {
  calls: CallRecord[] = []
  closed = false

  constructor(
    private readonly legacyUuidList = false,
    private readonly metadata: Record<string, unknown> = {},
    private readonly historicalRows: Array<Record<string, unknown>> = [],
    readonly latestDynamic: Record<string, unknown> = {},
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    const now = Date.now()
    if (method === 'agent-uuid_list_all') {
      if (this.legacyUuidList)
        throw new Error('Method not found')
      return [TEST_UUID] as T
    }
    if (method === 'nodeget-server_list_all_agent_uuid')
      return { uuids: [TEST_UUID] } as T
    if (method === 'agent_static_data_multi_last_query') {
      return [{
        uuid: TEST_UUID,
        cpu: JSON.stringify({ physical_cores: 2, logical_cores: 4, per_core: [{ brand: 'Fixture CPU' }] }),
        system: JSON.stringify({ system_name: 'Linux', system_arch: 'x86_64', virtualization: 'kvm' }),
      }] as T
    }
    if (method === 'kv_get_multi_value') {
      return [
        { namespace: TEST_UUID, key: 'metadata_name', value: JSON.stringify('Fixture Node') },
        { namespace: TEST_UUID, key: 'metadata_country', value: JSON.stringify('US') },
        { namespace: TEST_UUID, key: 'metadata_asn', value: JSON.stringify('AS64500') },
        ...Object.entries(this.metadata).map(([key, value]) => ({ namespace: TEST_UUID, key, value })),
      ] as T
    }
    if (method === 'agent_dynamic_summary_multi_last_query') {
      return [{
        uuid: TEST_UUID,
        timestamp: now - 1_000,
        cpu_usage: 12.5,
        used_memory: 4_000,
        total_memory: 8_000,
        used_swap: 100,
        total_swap: 2_000,
        total_space: 100_000,
        available_space: 40_000,
        ...this.latestDynamic,
      }] as T
    }
    if (method === 'task_query') {
      const condition = (params.task_data_query as { condition: Array<Record<string, unknown>> }).condition
      const requestedType = condition.find(item => typeof item.type === 'string')?.type
      if (requestedType === 'tcp_ping') {
        return [{
          uuid: TEST_UUID,
          timestamp: now - 2_000,
          success: true,
          cron_source: 'shared-name',
          task_event_result: { tcp_ping: 18 },
        }] as T
      }
      return [
        {
          uuid: TEST_UUID,
          timestamp: now - 3_000,
          success: true,
          cron_source: 'shared-name',
          task_event_result: { ping: 21 },
        },
        {
          uuid: TEST_UUID,
          timestamp: now - 1_000,
          success: false,
          cron_source: 'shared-name',
          task_event_result: null,
        },
      ] as T
    }
    if (method === 'agent_query_dynamic_summary')
      return this.historicalRows as T
    throw new Error(`Unexpected method: ${method}`)
  }

  close(): void {
    this.closed = true
  }
}

describe('NodeGetSource', () => {
  it('maps current NodeGet data using only the minimal static fields', async () => {
    const caller = new FixtureCaller()
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const clients = await source.getClients()
    expect(clients[TEST_UUID]?.name).toBe('Fixture Node')
    expect(clients[TEST_UUID]?.cpu_name).toBe('Fixture CPU')
    expect(clients[TEST_UUID]?.country).toBe('US')
    expect(clients[TEST_UUID]?.mem_total).toBe(8_000)

    const staticCall = caller.calls.find(call => call.method === 'agent_static_data_multi_last_query')
    expect(staticCall?.params.fields).toEqual(['cpu', 'system'])
  })

  it('falls back to the deprecated UUID method for older NodeGet servers', async () => {
    const caller = new FixtureCaller(true)
    const source = new NodeGetSource('Legacy', 'wss://legacy.example/nodeget/rpc', caller)
    await source.getClients()
    expect(caller.calls.map(call => call.method)).toContain('nodeget-server_list_all_agent_uuid')
  })

  it('converts a configured NodeGet traffic extension quota from GB to bytes', async () => {
    const caller = new FixtureCaller(false, {
      metadata_billing_mode: 'quota',
      metadata_traffic_limit: 1_000,
      metadata_traffic_limit_type: 'max',
      metadata_traffic_period: 'monthly',
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const clients = await source.getClients()

    expect(clients[TEST_UUID]?.traffic_limit).toBe(1_000 * GIBIBYTE_BYTES)
    expect(clients[TEST_UUID]?.traffic_limit_type).toBe('sum')
    const metadataCall = caller.calls.find(call => call.method === 'kv_get_multi_value')
    expect(metadataCall?.params.namespace_key).toContainEqual({
      namespace: TEST_UUID,
      key: 'metadata_billing_mode',
    })
    expect(metadataCall?.params.namespace_key).toContainEqual({
      namespace: TEST_UUID,
      key: 'metadata_traffic_period',
    })
  })

  it('keeps raw cumulative traffic before the extension period worker initializes', async () => {
    const caller = new FixtureCaller(false, {
      metadata_billing_mode: 'quota',
      metadata_traffic_limit: 10,
      metadata_traffic_period: 'monthly',
      metadata_traffic_period_start: 0,
      metadata_traffic_period_base: 0,
      metadata_traffic_used: 0,
    }, [], {
      timestamp: Date.now() - 1_000,
      uptime: 1_000,
      total_transmitted: 1_200,
      total_received: 3_400,
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    await source.getClients()

    const statuses = await source.getLatestStatuses([TEST_UUID])
    expect(statuses[TEST_UUID]!.net_total_up).toBe(1_200)
    expect(statuses[TEST_UUID]!.net_total_down).toBe(3_400)
  })

  it('keeps standalone traffic metadata in bytes without the extension signature', async () => {
    const caller = new FixtureCaller(false, {
      metadata_traffic_limit: 5_000_000_000,
      metadata_traffic_limit_type: 'max',
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const clients = await source.getClients()

    expect(clients[TEST_UUID]?.traffic_limit).toBe(5_000_000_000)
    expect(clients[TEST_UUID]?.traffic_limit_type).toBe('max')
  })

  it('does not infer the traffic extension from a period without a billing mode', async () => {
    const caller = new FixtureCaller(false, {
      metadata_traffic_limit: 5_000_000_000,
      metadata_traffic_limit_type: 'max',
      metadata_traffic_period: 'monthly',
      metadata_traffic_period_start: Date.now() - 3_600_000,
      metadata_traffic_period_base: 1_000,
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const clients = await source.getClients()

    expect(clients[TEST_UUID]?.traffic_limit).toBe(5_000_000_000)
    expect(clients[TEST_UUID]?.traffic_limit_type).toBe('max')
  })

  it('does not expose pay-as-you-go extension metadata as a Komari quota', async () => {
    const caller = new FixtureCaller(false, {
      metadata_billing_mode: 'payg',
      metadata_traffic_limit: 500,
      metadata_traffic_period: 'never',
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const clients = await source.getClients()

    expect(clients[TEST_UUID]?.traffic_limit).toBe(0)
    expect(clients[TEST_UUID]?.traffic_limit_type).toBe('sum')
  })

  it('treats the extension never period as unlimited', async () => {
    const caller = new FixtureCaller(false, {
      metadata_billing_mode: 'quota',
      metadata_traffic_limit: 500,
      metadata_traffic_period: 'never',
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const clients = await source.getClients()

    expect(clients[TEST_UUID]?.traffic_limit).toBe(0)
    expect(clients[TEST_UUID]?.traffic_limit_type).toBe('sum')
  })

  it('keeps extension traffic counters cumulative after the period worker initializes', async () => {
    const timestamp = Date.parse('2026-08-25T12:00:00.000Z')
    const caller = new FixtureCaller(false, {
      metadata_billing_mode: 'quota',
      metadata_traffic_limit: 10,
      metadata_traffic_period: 'monthly',
      metadata_traffic_period_start: timestamp - 3_600_000,
      metadata_traffic_period_base: 1_500,
      metadata_traffic_used: 450,
    }, [], {
      timestamp,
      uptime: 1_000,
      total_transmitted: 1_000,
      total_received: 1_000,
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    await source.getClients()

    const first = await source.getLatestStatuses([TEST_UUID])
    expect(first[TEST_UUID]!.net_total_up).toBe(1_000)
    expect(first[TEST_UUID]!.net_total_down).toBe(1_000)
    expect(first[TEST_UUID]!.traffic_up).toBe(0)
    expect(first[TEST_UUID]!.traffic_down).toBe(0)

    Object.assign(caller.latestDynamic, {
      timestamp: timestamp + 10_000,
      uptime: 1_010,
      total_transmitted: 1_100,
      total_received: 1_200,
    })
    const second = await source.getLatestStatuses([TEST_UUID])
    expect(second[TEST_UUID]!.net_total_up).toBe(1_100)
    expect(second[TEST_UUID]!.net_total_down).toBe(1_200)
    expect(second[TEST_UUID]!.traffic_up).toBe(100)
    expect(second[TEST_UUID]!.traffic_down).toBe(200)
  })

  it('does not poll private period-worker metadata during realtime status updates', async () => {
    const timestamp = Date.parse('2026-08-25T12:00:00.000Z')
    const metadata: Record<string, unknown> = {
      metadata_billing_mode: 'quota',
      metadata_traffic_limit: 10,
      metadata_traffic_period: 'monthly',
      metadata_traffic_period_start: timestamp - 3_600_000,
      metadata_traffic_period_base: 1_500,
      metadata_traffic_used: 500,
    }
    const caller = new FixtureCaller(false, metadata, [], {
      timestamp,
      uptime: 1_000,
      total_transmitted: 1_000,
      total_received: 1_000,
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    await source.getClients()

    const statuses = await source.getLatestStatuses([TEST_UUID])

    expect(statuses[TEST_UUID]!.net_total_up + statuses[TEST_UUID]!.net_total_down).toBe(2_000)
    expect(caller.calls.filter(call => call.method === 'kv_get_multi_value')).toHaveLength(1)
  })

  it('uses reset agent counters instead of private period-worker usage', async () => {
    const timestamp = Date.parse('2026-08-25T12:00:00.000Z')
    const metadata: Record<string, unknown> = {
      metadata_billing_mode: 'quota',
      metadata_traffic_limit: 10,
      metadata_traffic_period: 'monthly',
      metadata_traffic_period_start: timestamp - 3_600_000,
      metadata_traffic_period_base: 5_000,
      metadata_traffic_used: 800,
    }
    const caller = new FixtureCaller(false, metadata, [], {
      timestamp,
      uptime: 1_000,
      total_transmitted: 4_000,
      total_received: 6_000,
    })
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    await source.getClients()
    Object.assign(caller.latestDynamic, {
      timestamp: timestamp + 10_000,
      uptime: 10,
      total_transmitted: 100,
      total_received: 200,
    })
    const statuses = await source.getLatestStatuses([TEST_UUID])

    expect(statuses[TEST_UUID]!.net_total_up).toBe(100)
    expect(statuses[TEST_UUID]!.net_total_down).toBe(200)
    expect(statuses[TEST_UUID]!.traffic_up).toBe(0)
    expect(statuses[TEST_UUID]!.traffic_down).toBe(0)
  })

  it('computes reset-aware traffic deltas and honors per-metric aggregation', async () => {
    const at = (minute: number) => Date.parse(`2026-08-25T00:${String(minute).padStart(2, '0')}:00.000Z`)
    const historicalRows = [
      { uuid: TEST_UUID, timestamp: at(0), uptime: 100, total_transmitted: 100, total_received: 200, transmit_speed: 1, receive_speed: 2 },
      { uuid: TEST_UUID, timestamp: at(5), uptime: 400, total_transmitted: 130, total_received: 260, transmit_speed: 3, receive_speed: 4 },
      { uuid: TEST_UUID, timestamp: at(10), uptime: 700, total_transmitted: 180, total_received: 300, transmit_speed: 5, receive_speed: 6 },
      { uuid: TEST_UUID, timestamp: at(15), uptime: 1_000, total_transmitted: 200, total_received: 360, transmit_speed: 7, receive_speed: 8 },
      { uuid: TEST_UUID, timestamp: at(20), uptime: 10, total_transmitted: 5, total_received: 9, transmit_speed: 9, receive_speed: 10 },
    ]
    const source = new NodeGetSource(
      'Fixture',
      'wss://nodeget.example/nodeget/rpc',
      new FixtureCaller(false, {}, historicalRows),
    )

    const result = await source.queryMetrics({
      entity_ids: [TEST_UUID],
      metric_keys: ['traffic.up', 'traffic.down', 'net.out.rate'],
      start: new Date(at(5)).toISOString(),
      end: new Date(at(21)).toISOString(),
      max_points: 20,
      max_points_by_metric: { 'traffic.up': 2, 'traffic.down': 2 },
      aggregation_by_metric: { 'traffic.up': 'sum', 'traffic.down': 'sum', 'net.out.rate': 'max' },
    })

    const upload = result.series.find(series => series.metric_key === 'traffic.up')!
    const download = result.series.find(series => series.metric_key === 'traffic.down')!
    const rate = result.series.find(series => series.metric_key === 'net.out.rate')!
    expect(upload.type).toBe('gauge')
    expect(upload.max_points).toBe(2)
    expect(upload.downsample_algorithm).toBe('sum')
    expect(upload.points.reduce((sum, point) => sum + (point.value ?? 0), 0)).toBe(100)
    expect(download.points.reduce((sum, point) => sum + (point.value ?? 0), 0)).toBe(160)
    expect(rate.points.map(point => point.value)).toEqual([3, 5, 7, 9])
    expect(result.server_downsample_default).toBe(true)
    expect(result.default_points).toBe(500)
  })

  it('loads the latest records by limit even when they are older than one hour', async () => {
    const historicalRows = [
      { uuid: TEST_UUID, timestamp: Date.parse('2026-08-25T01:00:00.000Z'), uptime: 100, total_transmitted: 100 },
      { uuid: TEST_UUID, timestamp: Date.parse('2026-08-25T02:00:00.000Z'), uptime: 200, total_transmitted: 130 },
      { uuid: TEST_UUID, timestamp: Date.parse('2026-08-25T03:00:00.000Z'), uptime: 300, total_transmitted: 180 },
    ]
    const caller = new FixtureCaller(false, {}, historicalRows)
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)

    const records = await source.getRecentRecords(TEST_UUID, 2)
    expect(records.map(record => record.time)).toEqual([
      '2026-08-25T02:00:00.000Z',
      '2026-08-25T03:00:00.000Z',
    ])
    expect(records.map(record => record.traffic_up)).toEqual([30, 50])
    const query = caller.calls.find(call => call.method === 'agent_query_dynamic_summary')!
    expect((query.params.query as { condition: unknown[] }).condition).toEqual([
      { uuid: TEST_UUID },
      { limit: 3 },
    ])
  })

  it('uses adaptive null markers instead of filling every empty metric bucket', async () => {
    const at = (second: number) => Date.parse(`2026-08-25T00:00:${String(second).padStart(2, '0')}.000Z`)
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', new FixtureCaller(false, {}, [
      { uuid: TEST_UUID, timestamp: at(10), cpu_usage: 10 },
      { uuid: TEST_UUID, timestamp: at(20), cpu_usage: 20 },
      { uuid: TEST_UUID, timestamp: at(50), cpu_usage: 30 },
    ]))

    const result = await source.queryMetrics({
      entity_id: TEST_UUID,
      metric_keys: ['cpu.usage'],
      start: new Date(at(0)).toISOString(),
      end: new Date(at(59)).toISOString(),
      max_points: 100,
      fill_empty: true,
    })
    expect(result.series[0]?.points).toEqual([
      { time: new Date(at(0)).toISOString(), value: null, count: 0 },
      { time: new Date(at(10)).toISOString(), value: 10, count: 1 },
      { time: new Date(at(20)).toISOString(), value: 20, count: 1 },
      { time: new Date(at(30)).toISOString(), value: null, count: 0 },
      { time: new Date(at(50)).toISOString(), value: 30, count: 1 },
    ])
  })

  it('reports a historical permission failure when every query window fails', async () => {
    const caller: NodeGetCaller = {
      async call(): Promise<never> {
        throw new Error('permission denied')
      },
      close() {},
    }
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    await expect(source.queryMetrics({
      entity_id: TEST_UUID,
      metric_keys: ['cpu.usage'],
      hours: 1,
    })).rejects.toThrow('permission denied')
  })

  it('keeps Ping data available when one NodeGet task type is denied', async () => {
    const caller: NodeGetCaller = {
      async call<T>(_method: string, params: Record<string, unknown>): Promise<T> {
        const condition = (params.task_data_query as { condition: Array<Record<string, unknown>> }).condition
        const type = condition.find(item => item.type)?.type
        if (type === 'tcp_ping')
          throw new Error('tcp ping permission denied')
        return [{
          uuid: TEST_UUID,
          timestamp: Date.now() - 1_000,
          success: true,
          cron_source: 'ping-only',
          task_event_result: { ping: 12 },
        }] as T
      },
      close() {},
    }
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const result = await source.getPingRecords({ uuid: TEST_UUID, hours: 1, maxCount: 100 })
    expect(result.records).toHaveLength(1)
    expect(result.tasks[0]?.type).toBe('ping')
  })

  it('rejects empty and unknown metric requests instead of reporting false support', async () => {
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', new FixtureCaller())
    await expect(source.queryMetrics({})).rejects.toThrow('metric_keys is required')
    await expect(source.queryMetrics({ metric_keys: ['not.a.metric'] })).rejects.toThrow('Unknown metric key')
  })

  it('returns one empty series per requested Ping metric when no probes exist', async () => {
    const caller: NodeGetCaller = {
      async call<T>(method: string): Promise<T> {
        if (method === 'task_query')
          return [] as T
        throw new Error(`Unexpected method: ${method}`)
      },
      close() {},
    }
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const result = await source.queryMetrics({
      entity_id: TEST_UUID,
      metric_keys: ['ping.latency_ms', 'ping.loss'],
      start: '2026-08-25T00:00:00.000Z',
      end: '2026-08-25T01:00:00.000Z',
      fill_empty: true,
    })

    expect(result.count).toBe(2)
    expect(result.series.map(series => series.metric_key)).toEqual(['ping.latency_ms', 'ping.loss'])
    expect(result.series.every(series => series.points.length === 2 && series.tags.task_id === undefined)).toBe(true)
  })

  it('keeps Ping and TCPing tasks distinct and records failed probes as loss', async () => {
    const caller = new FixtureCaller()
    const source = new NodeGetSource('Fixture', 'wss://nodeget.example/nodeget/rpc', caller)
    const result = await source.getPingRecords({ uuid: TEST_UUID, hours: 1, maxCount: 100 })
    expect(result.records).toHaveLength(3)
    expect(result.records.some(record => record.value === -1)).toBe(true)
    expect(result.tasks.map(task => task.type).sort()).toEqual(['ping', 'tcp_ping'])
    expect(new Set(result.tasks.map(task => task.id)).size).toBe(2)
    expect(result.tasks.find(task => task.type === 'ping')?.loss).toBe(50)
  })
})
