import { describe, expect, it } from 'bun:test'
import { KomariFacade } from '../src/komari/facade'
import { FakeMonitorProvider, TEST_UUID } from './fixtures'

describe('KomariFacade', () => {
  it('returns Komari HTTP envelopes for public data', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const response = await facade.handleHttp(new Request('https://theme.example/api/public'))
    expect(response?.status).toBe(200)
    const body = await response!.json() as any
    expect(body.status).toBe('success')
    expect(body.data.sitename).toBe('Test Site')
  })

  it('hard-rejects administrative HTTP and RPC operations', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const httpResponse = await facade.handleHttp(new Request('https://theme.example/api/admin/settings'))
    expect(httpResponse?.status).toBe(403)

    const rpcResponse = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 1, method: 'admin:getSettings', params: {},
    }) as any
    expect(rpcResponse.error.code).toBe(-32601)
    expect(rpcResponse.error.message).toContain('disabled')
  })

  it('supports public node RPC and JSON-RPC batches', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const response = await facade.handleRpcPayload([
      { jsonrpc: '2.0', id: 'nodes', method: 'public:getNodesInformation' },
      { jsonrpc: '2.0', method: 'rpc.ping' },
      { jsonrpc: '2.0', id: 'ping', method: 'rpc.ping' },
    ]) as any[]
    expect(response).toHaveLength(2)
    expect(response[0].result[0].uuid).toBe(TEST_UUID)
    expect(response[1].result).toBe('pong')
  })

  it('produces realtime and Ping metric compatibility shapes', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const realtime = await facade.getRealtimeSnapshot() as any
    expect(realtime.status).toBe('success')
    expect(realtime.data.online).toEqual([TEST_UUID])
    expect(realtime.data.data[TEST_UUID].cpu.usage).toBe(12.5)

    const stats = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 2, method: 'public:getPingMetricStats', params: { entity_id: TEST_UUID },
    }) as any
    expect(stats.result.stats[0].loss).toBe(50)
    expect(stats.result.stats[0].avg).toBe(20)
  })

  it('supports version aliases, single-node lookup, and audit no-op', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const version = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 3, method: 'rpc.getVersion',
    }) as any
    expect(version.result.version).toBe('1.3.0-nodeget')

    const node = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 4, method: 'common:getNodes', params: { uuid: TEST_UUID },
    }) as any
    expect(node.result.uuid).toBe(TEST_UUID)

    const audit = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 5, method: 'public:recordVisitorEvent', params: { event: 'page_view' },
    }) as any
    expect(audit.result).toEqual({ status: 'disabled' })

    const rpcVersion = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 6, method: 'rpc.version',
    }) as any
    expect(rpcVersion.result).toBe('1.0')
  })

  it('returns official record metadata and treats task_id=-1 as all tasks', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const load = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 7, method: 'common:getRecords',
      params: { type: 'load', uuid: TEST_UUID, start: '2026-08-25T11:00:00.000Z', end: '2026-08-25T12:00:00.000Z' },
    }) as any
    expect(load.result.count).toBe(1)
    expect(load.result.from).toBe('2026-08-25T11:00:00.000Z')
    expect(load.result.to).toBe('2026-08-25T12:00:00.000Z')

    const ping = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 8, method: 'common:getRecords',
      params: { type: 'ping', task_id: -1, hours: 1 },
    }) as any
    expect(ping.result.count).toBe(2)
    expect(ping.result.from).toBeString()
    expect(ping.result.to).toBeString()
  })
})
