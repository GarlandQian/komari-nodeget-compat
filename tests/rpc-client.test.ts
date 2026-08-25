import { describe, expect, it } from 'bun:test'
import { NodeGetRpcClient } from '../src/nodeget/rpc-client'

class FakeSocket {
  readyState: number = WebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: any[] = []

  constructor() {
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  send(data: string): void {
    const request = JSON.parse(data)
    this.sent.push(request)
    queueMicrotask(() => this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }),
    })))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code: 1000 }))
  }
}

describe('NodeGetRpcClient', () => {
  it('never allows call params to replace the configured token', async () => {
    const socket = new FakeSocket()
    const client = new NodeGetRpcClient(
      { backend_url: 'wss://nodeget.example/nodeget/rpc', token: 'read-only-token' },
      () => socket,
    )
    expect(await client.call<string>('test_method', { token: 'attacker-value' })).toBe('ok')
    expect(socket.sent[0].params.token).toBe('read-only-token')
    client.close()
  })
})
