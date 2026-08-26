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
      return [] as T
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
