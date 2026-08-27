import { describe, expect, it } from 'bun:test'
import { NodeGetRpcClient } from '../src/nodeget/rpc-client'

class FakeSocket {
  readyState: number = WebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: any[] = []

  constructor(autoOpen = true) {
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = WebSocket.OPEN
        this.onopen?.(new Event('open'))
      })
    }
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

class ManualSocket extends FakeSocket {
  constructor() {
    super(false)
    this.readyState = WebSocket.CONNECTING
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  disconnect(): void {
    this.readyState = WebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code: 1006 }))
  }

  respondLast(result: unknown): void {
    const request = this.sent.at(-1)
    this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }))
  }

  override send(data: string): void {
    this.sent.push(JSON.parse(data))
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

  it('normalizes a NodeGet panel backend origin to its WebSocket RPC endpoint', async () => {
    const socket = new FakeSocket()
    let connectedUrl = ''
    const client = new NodeGetRpcClient(
      { backend_url: 'https://nodeget.example', token: 'read-only-token' },
      (url) => {
        connectedUrl = url
        return socket
      },
    )
    expect(await client.call<string>('test_method')).toBe('ok')
    expect(connectedUrl).toBe('wss://nodeget.example/nodeget/rpc')
    client.close()
  })

  it('adds the default RPC path when NodeGet stores a pathless WebSocket URL', async () => {
    const socket = new FakeSocket()
    let connectedUrl = ''
    const client = new NodeGetRpcClient(
      { backend_url: 'wss://nodeget.example', token: 'read-only-token' },
      (url) => {
        connectedUrl = url
        return socket
      },
    )
    expect(await client.call<string>('test_method')).toBe('ok')
    expect(connectedUrl).toBe('wss://nodeget.example/nodeget/rpc')
    client.close()
  })

  it('does not let a stale socket close reject requests on a reconnected socket', async () => {
    const sockets: ManualSocket[] = []
    const client = new NodeGetRpcClient(
      { backend_url: 'wss://nodeget.example', token: 'read-only-token' },
      () => {
        const socket = new ManualSocket()
        sockets.push(socket)
        return socket
      },
    )

    const firstCall = client.call<string>('first')
    await Promise.resolve()
    sockets[0]!.open()
    while (sockets[0]!.sent.length === 0)
      await Promise.resolve()
    const staleClose = sockets[0]!.onclose!
    sockets[0]!.disconnect()
    await expect(firstCall).rejects.toThrow('disconnected')

    const secondCall = client.call<string>('second')
    await Promise.resolve()
    sockets[1]!.open()
    while (sockets[1]!.sent.length === 0)
      await Promise.resolve()
    staleClose(new CloseEvent('close', { code: 1006 }))
    sockets[1]!.respondLast('second-ok')
    expect(await secondCall).toBe('second-ok')
    client.close()
  })

  it('does not open a socket for an already aborted request', async () => {
    let connections = 0
    const controller = new AbortController()
    controller.abort()
    const client = new NodeGetRpcClient(
      { backend_url: 'wss://nodeget.example', token: 'read-only-token' },
      () => {
        connections += 1
        return new FakeSocket()
      },
    )
    await expect(client.call('cancelled', {}, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(connections).toBe(0)
  })
})
