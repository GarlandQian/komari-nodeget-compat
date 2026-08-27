import { describe, expect, it } from 'bun:test'
import type { NodeGetCaller } from '../src/nodeget/rpc-client'
import { NodeGetMonitorProvider } from '../src/nodeget/provider'

const manifest = {
  schema: 1 as const,
  source: { name: 'Fixture', short: 'Fixture', version: '1.0.0' },
  themeSettingsDefaults: { sourceDefault: true },
  themeSettingKeys: ['sourceDefault'],
  themeSettingArrayKeys: [],
}

function monitoringCaller(uuid: string, historicalRows: Array<Record<string, unknown>> = []): NodeGetCaller {
  return {
    async call<T>(method: string): Promise<T> {
      if (method === 'agent-uuid_list_all')
        return [uuid] as T
      if (method === 'agent_static_data_multi_last_query')
        return [] as T
      if (method === 'kv_get_multi_value')
        return [{ namespace: uuid, key: 'metadata_name', value: `${uuid} node` }] as T
      if (method === 'agent_dynamic_summary_multi_last_query') {
        return [{
          uuid,
          timestamp: Date.now() - 1_000,
          total_memory: 1_000,
          used_memory: 500,
          total_space: 2_000,
          available_space: 1_000,
        }] as T
      }
      if (method === 'agent_query_dynamic_summary')
        return historicalRows as T
      throw new Error(`Unexpected method: ${method}`)
    },
    close() {},
  }
}

describe('NodeGetMonitorProvider', () => {
  it('passes safe NodeGet preferences through as Komari theme settings', async () => {
    const provider = new NodeGetMonitorProvider({
      user_preferences: {
        site_name: 'NodeGet Site',
        footer: 'Footer',
        metric_retention_days: 99,
        backgroundMediaType: 'image',
        backgroundImage: 'https://adapter.example/api/acg-background',
      },
      site_tokens: [],
    }, manifest)

    const info = await provider.getPublicInfo()
    expect(info.sitename).toBe('NodeGet Site')
    expect(info.metric_retention_days).toBe(30)
    expect(info.theme_settings).toEqual({
      sourceDefault: true,
      backgroundMediaType: 'image',
      backgroundImage: 'https://adapter.example/api/acg-background',
    })
    expect(info.theme_settings).not.toHaveProperty('site_name')
    expect(info.theme_settings).not.toHaveProperty('footer')
    expect(info.theme_settings).not.toHaveProperty('metric_retention_days')
  })

  it('keeps healthy NodeGet sources available when another source is offline', async () => {
    const uuid = '22222222-2222-4222-8222-222222222222'
    const healthy: NodeGetCaller = {
      async call<T>(method: string): Promise<T> {
        if (method === 'agent-uuid_list_all')
          return [uuid] as T
        if (method === 'agent_static_data_multi_last_query')
          return [] as T
        if (method === 'kv_get_multi_value')
          return [{ namespace: uuid, key: 'metadata_name', value: 'Healthy node' }] as T
        if (method === 'agent_dynamic_summary_multi_last_query') {
          return [{
            uuid,
            timestamp: Date.now(),
            total_memory: 1_000,
            used_memory: 500,
            total_space: 2_000,
            available_space: 1_000,
          }] as T
        }
        throw new Error(`Unexpected method: ${method}`)
      },
      close() {},
    }
    const offline: NodeGetCaller = {
      async call(): Promise<never> {
        throw new Error('offline')
      },
      close() {},
    }
    const provider = new NodeGetMonitorProvider({
      site_tokens: [
        { name: 'Offline', backend_url: 'https://offline.example', token: 'token' },
        { name: 'Healthy', backend_url: 'https://healthy.example', token: 'token' },
      ],
    }, manifest, entry => entry.name === 'Healthy' ? healthy : offline)

    const clients = await provider.getClients()
    expect(clients[uuid]?.name).toBe('Healthy node')
    expect(clients[uuid]?.mem_total).toBe(1_000)
  })

  it('keeps public IDs stable when duplicate nodes disappear and return', async () => {
    const uuid = '66666666-6666-4666-8666-666666666666'
    const states = {
      First: { online: true },
      Second: { online: true },
    }
    const caller = (name: keyof typeof states): NodeGetCaller => ({
      async call<T>(method: string): Promise<T> {
        if (!states[name].online)
          throw new Error(`${name} offline`)
        if (method === 'agent-uuid_list_all')
          return [uuid] as T
        if (method === 'agent_static_data_multi_last_query')
          return [] as T
        if (method === 'kv_get_multi_value')
          return [{ namespace: uuid, key: 'metadata_name', value: `${name} node` }] as T
        if (method === 'agent_dynamic_summary_multi_last_query')
          return [{ uuid, timestamp: Date.now(), total_memory: 1_000, total_space: 2_000 }] as T
        throw new Error(`Unexpected method: ${method}`)
      },
      close() {},
    })
    const provider = new NodeGetMonitorProvider({
      site_tokens: [
        { name: 'First', backend_url: 'https://first.example', token: 'token' },
        { name: 'Second', backend_url: 'https://second.example', token: 'token' },
      ],
    }, manifest, entry => caller(entry.name as keyof typeof states))
    const expire = () => {
      (provider as unknown as { clientsExpiresAt: number }).clientsExpiresAt = Date.now() - 1
    }
    const idFor = (clients: Record<string, { name: string }>, name: string) => (
      Object.entries(clients).find(([, client]) => client.name === `${name} node`)?.[0]
    )

    const initial = await provider.getClients()
    const firstId = idFor(initial, 'First')
    const secondId = idFor(initial, 'Second')
    expect(firstId).toBeString()
    expect(secondId).toBeString()
    if (!firstId || !secondId)
      throw new Error('Expected both duplicate nodes to have public IDs')
    expect(firstId).not.toBe(uuid)
    expect(secondId).not.toBe(uuid)

    states.First.online = false
    expire()
    const degradedStatuses = await provider.getLatestStatuses()
    expect(Object.keys(degradedStatuses)).toEqual([secondId])
    const degraded = await provider.getClients()
    expect(idFor(degraded, 'Second')).toBe(secondId)

    states.First.online = true
    expire()
    const recoveredStatuses = await provider.getLatestStatuses()
    expect(Object.keys(recoveredStatuses).sort()).toEqual([firstId, secondId].sort())
    const recovered = await provider.getClients()
    expect(idFor(recovered, 'First')).toBe(firstId)
    expect(idFor(recovered, 'Second')).toBe(secondId)
  })

  it('applies maxCount across every NodeGet source instead of once per node', async () => {
    const firstUuid = '33333333-3333-4333-8333-333333333333'
    const secondUuid = '44444444-4444-4444-8444-444444444444'
    const now = Date.now()
    const rows = (uuid: string) => [1, 2, 3, 4].map((minute) => ({
      uuid,
      timestamp: now - (5 - minute) * 60_000,
      cpu_usage: minute * 10,
    }))
    const callers = new Map([
      ['First', monitoringCaller(firstUuid, rows(firstUuid))],
      ['Second', monitoringCaller(secondUuid, rows(secondUuid))],
    ])
    const provider = new NodeGetMonitorProvider({
      site_tokens: [
        { name: 'First', backend_url: 'https://first.example', token: 'token' },
        { name: 'Second', backend_url: 'https://second.example', token: 'token' },
      ],
    }, manifest, entry => callers.get(entry.name!)!)

    const result = await provider.getLoadRecords({ hours: 1, maxCount: 3 })
    expect(Array.isArray(result)).toBe(false)
    const grouped = result as Record<string, unknown[]>
    expect(Object.values(grouped).reduce((count, records) => count + records.length, 0)).toBe(3)
    expect(grouped[firstUuid]).toHaveLength(2)
    expect(grouped[secondUuid]).toHaveLength(1)
  })

  it('returns official empty metric series for an unknown public entity ID', async () => {
    const uuid = '55555555-5555-4555-8555-555555555555'
    const provider = new NodeGetMonitorProvider({
      site_tokens: [{ name: 'Only', backend_url: 'https://only.example', token: 'token' }],
    }, manifest, () => monitoringCaller(uuid))

    const result = await provider.queryMetrics({
      entity_id: 'missing-node',
      metric_keys: ['cpu.usage'],
      start: '2026-08-25T00:00:00.000Z',
      end: '2026-08-25T01:00:00.000Z',
      fill_empty: true,
    })
    expect(result.server_downsample_default).toBe(true)
    expect(result.default_points).toBe(500)
    expect(result.series).toHaveLength(1)
    expect(result.series[0]?.entity_id).toBe('missing-node')
    expect(result.series[0]?.points).toEqual([
      { time: '2026-08-25T00:00:00.000Z', value: null, count: 0 },
      { time: '2026-08-25T01:00:00.000Z', value: null, count: 0 },
    ])
  })
})
