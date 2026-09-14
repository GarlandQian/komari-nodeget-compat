import { describe, expect, it, spyOn } from 'bun:test'
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

  it('uses the same recent-record limit for HTTP and RPC, including an omitted limit', async () => {
    const provider = new FakeMonitorProvider()
    const recent = spyOn(provider, 'getRecentRecords')
    const facade = new KomariFacade(provider)
    for (const limit of [undefined, 25, 0]) {
      const query = limit === undefined ? '' : `?limit=${limit}`
      const http = await facade.handleHttp(new Request(`https://theme.example/api/recent/${TEST_UUID}${query}`))
      expect(http?.status).toBe(200)
      expect(recent).toHaveBeenLastCalledWith(TEST_UUID, limit ?? 150)
      await facade.handleRpcPayload({
        jsonrpc: '2.0', id: 1, method: 'common:getNodeRecentStatus',
        params: { uuid: TEST_UUID, ...(limit === undefined ? {} : { limit }) },
      })
      expect(recent).toHaveBeenLastCalledWith(TEST_UUID, limit ?? 150)
    }
  })

  it('preserves HTTP history defaults and count aliases with the matching public RPC semantics', async () => {
    const provider = new FakeMonitorProvider()
    const load = spyOn(provider, 'getLoadRecords')
    const ping = spyOn(provider, 'getPingRecords')
    const facade = new KomariFacade(provider)
    const cases = [
      { query: '', params: {}, hours: 4, maxCount: 6_000 },
      { query: '&hours=12', params: { hours: 12 }, hours: 12, maxCount: 6_000 },
      { query: '&max_count=200', params: { max_count: 200 }, hours: 4, maxCount: 200 },
      { query: '&hours=12&max_count=200', params: { hours: 12, max_count: 200 }, hours: 12, maxCount: 200 },
      { query: '&hours=8&maxCount=300', params: { hours: 8, maxCount: 300 }, hours: 8, maxCount: 300 },
      { query: '&hours=0&maxCount=0', params: { hours: 0, maxCount: 0 }, hours: 0, maxCount: 0 },
    ]
    for (const type of ['load', 'ping'] as const) {
      const records = type === 'load' ? load : ping
      const method = type === 'load' ? 'public:getRecordsByUUID' : 'public:getPingRecords'
      for (const entry of cases) {
        const http = await facade.handleHttp(new Request(
          `https://theme.example/api/records/${type}?uuid=${TEST_UUID}${entry.query}`,
        ))
        expect(http?.status).toBe(200)
        const expected = { uuid: TEST_UUID, hours: entry.hours, maxCount: entry.maxCount }
        expect(records).toHaveBeenLastCalledWith(expected)
        const body = await http!.json() as any
        expect(Date.parse(body.data.to) - Date.parse(body.data.from)).toBe(Math.max(1, entry.hours) * 3_600_000)
        await facade.handleRpcPayload({
          jsonrpc: '2.0', id: 1, method, params: { uuid: TEST_UUID, ...entry.params },
        })
        expect(records).toHaveBeenLastCalledWith(expected)
      }
    }
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
    expect(realtime.data.data[TEST_UUID].connections).toEqual({ tcp: 15, udp: 5 })

    const stats = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 2, method: 'public:getPingMetricStats', params: { entity_id: TEST_UUID },
    }) as any
    expect(stats.result.stats[0].loss).toBe(50)
    expect(stats.result.stats[0].avg).toBe(20)
  })

  it('weights Ping latency statistics by successful samples and requests mean aggregation', async () => {
    const provider = new FakeMonitorProvider()
    const result = await provider.queryMetrics({})
    const metrics = spyOn(provider, 'queryMetrics').mockResolvedValue({
      ...result,
      series: result.series.map(series => ({
        ...series,
        downsampled: true,
        count: 3,
        points: series.metric_key === 'ping.latency_ms'
          ? [
              { time: '2026-08-25T12:00:00.000Z', value: 10, count: 9 },
              { time: '2026-08-25T12:01:00.000Z', value: 100, count: 1 },
              { time: '2026-08-25T12:02:00.000Z', value: -1, count: 0 },
            ]
          : [
              { time: '2026-08-25T12:00:00.000Z', value: 0, count: 9 },
              { time: '2026-08-25T12:01:00.000Z', value: 0.5, count: 2 },
              { time: '2026-08-25T12:02:00.000Z', value: 1, count: 2 },
            ],
      })),
    })
    const facade = new KomariFacade(provider)
    const response = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 2, method: 'public:getPingMetricStats',
      params: {
        entity_id: TEST_UUID,
        aggregation: 'sum',
        aggregation_by_metric: { 'ping.latency_ms': 'max', 'ping.loss': 'count' },
      },
    }) as any
    expect(metrics.mock.calls[0]?.[0]).toMatchObject({
      aggregation: 'avg',
      aggregation_by_metric: { 'ping.latency_ms': 'avg', 'ping.loss': 'avg' },
    })
    expect(response.result.stats[0]).toMatchObject({
      total: 13, valid: 10, min: 10, max: 100, avg: 19,
      latest: 100, p50: 10, p99: 100, stddev: 27, loss_approximate: true,
    })
    expect(response.result.stats[0].loss).toBeCloseTo(3 / 13 * 100)
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

  it('matches single-status, load projection, and metric validation semantics', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const status = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 9, method: 'common:getNodesLatestStatus', params: { uuid: TEST_UUID },
    }) as any
    expect(status.result.client).toBe(TEST_UUID)
    expect(status.result[TEST_UUID]).toBeUndefined()

    const load = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 10, method: 'common:getRecords',
      params: { type: 'load', uuid: TEST_UUID, load_type: 'network', hours: 1 },
    }) as any
    expect(load.result.load_type).toBe('network')
    expect(load.result.records[TEST_UUID][0]).toEqual({
      client: TEST_UUID,
      time: '2026-08-25T12:00:00.000Z',
      net_in: 1_000,
      net_out: 500,
      net_total_up: 10_000,
      net_total_down: 20_000,
    })

    const invalidMetrics = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 11, method: 'public:queryMetrics', params: {},
    }) as any
    expect(invalidMetrics.error.code).toBe(-32602)
    expect(invalidMetrics.error.message).toContain('metric_keys is required')
  })

  it('filters Ping metric statistics by requested task IDs', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const response = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 12, method: 'public:getPingMetricStats',
      params: { entity_ids: [TEST_UUID], task_ids: [999] },
    }) as any
    expect(response.result.stats).toEqual([])
    expect(response.result.count).toBe(0)
  })

  it('matches public record projections and Ping parameter validation', async () => {
    const facade = new KomariFacade(new FakeMonitorProvider())
    const ram = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 13, method: 'public:getRecordsByUUID',
      params: { uuid: TEST_UUID, load_type: 'ram' },
    }) as any
    expect(ram.result.records[0]).toEqual({
      client: TEST_UUID,
      time: '2026-08-25T12:00:00.000Z',
      ram: 4_000,
      ram_total: 8_000,
      ram_percent: 50,
    })

    const connections = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 14, method: 'public:getRecordsByUUID',
      params: { uuid: TEST_UUID, load_type: 'connections' },
    }) as any
    expect(connections.result.records[0].connections_tcp).toBe(15)

    const missingFilter = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 15, method: 'public:getPingRecords', params: {},
    }) as any
    expect(missingFilter.error.code).toBe(-32602)
    expect(missingFilter.error.message).toBe('UUID or task_id is required')

    const invalidTask = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 16, method: 'public:getPingRecords', params: { task_id: 'bad' },
    }) as any
    expect(invalidTask.error.code).toBe(-32602)

    const invalidRecordType = await facade.handleRpcPayload({
      jsonrpc: '2.0', id: 17, method: 'common:getRecords', params: { type: 'unknown' },
    }) as any
    expect(invalidRecordType.error.code).toBe(-32602)
    expect(invalidRecordType.error.message).toContain('Invalid record type')
  })
})
