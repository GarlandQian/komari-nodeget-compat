import type { NodeGetSiteToken } from '../types'
import { normalizeWebSocketUrl, publicErrorMessage } from '../shared/utils'

interface WebSocketLike {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

type WebSocketFactory = (url: string) => WebSocketLike

const SOCKET_OPEN = 1
const SOCKET_IDLE_TIMEOUT_MS = 500

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeout: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
}

interface NodeGetRpcEnvelope {
  id?: number
  result?: unknown
  error?: { code?: number, message?: string, data?: unknown }
}

export class NodeGetRpcError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'NodeGetRpcError'
  }
}

export interface NodeGetCaller {
  call<T>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number, signal?: AbortSignal }): Promise<T>
  close(): void
}

export class NodeGetRpcClient implements NodeGetCaller {
  private socket: WebSocketLike | null = null
  private connecting: Promise<void> | null = null
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly backendUrl: string

  constructor(
    private readonly entry: NodeGetSiteToken,
    private readonly createWebSocket: WebSocketFactory = url => new WebSocket(url),
    private readonly idleTimeoutMs = SOCKET_IDLE_TIMEOUT_MS,
  ) {
    this.backendUrl = normalizeWebSocketUrl(entry.backend_url)
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number, signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    this.cancelIdleClose()
    await this.connect()
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN)
      throw new NodeGetRpcError('NodeGet WebSocket is not connected')

    const id = ++this.nextId
    const timeoutMs = options.timeoutMs ?? 120_000
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, token: this.entry.token },
    }

    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }

      const timeout = setTimeout(() => {
        this.finishPending(id)
        reject(new NodeGetRpcError(`${method} timed out after ${timeoutMs}ms`, -32001))
      }, timeoutMs)

      const pending: PendingRequest = {
        resolve: value => resolve(value as T),
        reject,
        timeout,
      }

      if (options.signal) {
        const onAbort = () => {
          this.finishPending(id)
          reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      }

      this.pending.set(id, pending)
      try {
        this.socket!.send(JSON.stringify(payload))
      }
      catch (error) {
        this.finishPending(id)
        reject(new NodeGetRpcError(`Failed to send ${method}: ${publicErrorMessage(error)}`))
      }
    })
  }

  close(): void {
    this.cancelIdleClose()
    const socket = this.socket
    this.socket = null
    this.connecting = null
    socket?.close(1000, 'Compatibility runtime closed')
    this.rejectAll(new NodeGetRpcError('NodeGet connection closed'))
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === SOCKET_OPEN)
      return
    if (this.connecting)
      return this.connecting

    const attempt = new Promise<void>((resolve, reject) => {
      const socket = this.createWebSocket(this.backendUrl)
      this.socket = socket
      let settled = false

      const timeout = setTimeout(() => {
        if (settled)
          return
        settled = true
        if (this.socket === socket)
          this.socket = null
        socket.close(4000, 'Connection timeout')
        reject(new NodeGetRpcError('NodeGet WebSocket connection timed out', -32001))
      }, 12_000)

      socket.onopen = (event) => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        resolve()
        void event
      }

      socket.onerror = () => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        this.cancelIdleClose()
        if (this.socket === socket)
          this.socket = null
        socket.close(4001, 'Connection failed')
        reject(new NodeGetRpcError('NodeGet WebSocket connection failed'))
      }

      socket.onmessage = (event) => {
        if (this.socket === socket)
          this.handleMessage(event.data)
      }
      socket.onclose = () => {
        clearTimeout(timeout)
        if (this.socket === socket) {
          this.cancelIdleClose()
          this.socket = null
          this.rejectAll(new NodeGetRpcError('NodeGet WebSocket disconnected'))
        }
        if (!settled) {
          settled = true
          reject(new NodeGetRpcError('NodeGet WebSocket closed before opening'))
        }
      }
    })

    this.connecting = attempt
    try {
      await attempt
    }
    finally {
      if (this.connecting === attempt)
        this.connecting = null
    }
  }

  private handleMessage(data: unknown): void {
    let envelope: NodeGetRpcEnvelope
    try {
      envelope = JSON.parse(String(data)) as NodeGetRpcEnvelope
    }
    catch {
      return
    }

    if (typeof envelope.id !== 'number')
      return
    const pending = this.pending.get(envelope.id)
    if (!pending)
      return

    this.finishPending(envelope.id)
    if (envelope.error) {
      pending.reject(new NodeGetRpcError(
        envelope.error.message || 'NodeGet RPC request failed',
        envelope.error.code,
        envelope.error.data,
      ))
      return
    }
    pending.resolve(envelope.result)
  }

  private finishPending(id: number): void {
    const pending = this.pending.get(id)
    if (!pending)
      return
    clearTimeout(pending.timeout)
    pending.removeAbortListener?.()
    this.pending.delete(id)
    if (this.pending.size === 0)
      this.scheduleIdleClose()
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose()
    const socket = this.socket
    if (!socket || socket.readyState !== SOCKET_OPEN || this.pending.size > 0)
      return
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null
      if (this.socket !== socket || socket.readyState !== SOCKET_OPEN || this.pending.size > 0)
        return
      this.socket = null
      socket.close(1000, 'Idle connection released')
    }, Math.max(0, this.idleTimeoutMs))
  }

  private cancelIdleClose(): void {
    if (this.idleCloseTimer)
      clearTimeout(this.idleCloseTimer)
    this.idleCloseTimer = null
  }

  private rejectAll(error: Error): void {
    const pendingRequests = [...this.pending.values()]
    for (const id of this.pending.keys())
      this.finishPending(id)
    for (const pending of pendingRequests)
      pending.reject(error)
  }
}
