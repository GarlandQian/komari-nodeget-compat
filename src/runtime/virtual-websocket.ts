import type { KomariFacade } from '../komari/facade'
import { publicErrorMessage } from '../shared/utils'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

type FacadePromise = Promise<KomariFacade>

abstract class VirtualWebSocketBase extends EventTarget {
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = CLOSING
  readonly CLOSED = CLOSED
  readonly protocol = ''
  readonly extensions = ''
  readonly bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  readyState = CONNECTING
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null

  constructor(readonly url: string, protected readonly facadePromise: FacadePromise) {
    super()
    void this.openWhenReady()
  }

  abstract send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING)
      return
    this.readyState = CLOSING
    this.beforeClose()
    this.readyState = CLOSED
    const event = new CloseEvent('close', { code, reason, wasClean: code === 1000 })
    this.emit(event, this.onclose)
  }

  protected beforeClose(): void {}

  protected assertOpen(): void {
    if (this.readyState !== OPEN)
      throw new DOMException('WebSocket is not open', 'InvalidStateError')
  }

  protected emitMessage(data: unknown): void {
    if (this.readyState !== OPEN)
      return
    const event = new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })
    this.emit(event, this.onmessage)
  }

  protected emitError(error: unknown): void {
    const event = new ErrorEvent('error', { message: publicErrorMessage(error), error })
    this.emit(event, this.onerror)
  }

  private async openWhenReady(): Promise<void> {
    try {
      await this.facadePromise
      if (this.readyState !== CONNECTING)
        return
      this.readyState = OPEN
      const event = new Event('open')
      this.emit(event, this.onopen)
    }
    catch (error) {
      this.emitError(error)
      this.close(1011, 'Compatibility runtime initialization failed')
    }
  }

  private emit<T extends Event>(event: T, handler: ((event: T) => unknown) | null): void {
    handler?.call(this as unknown as WebSocket, event)
    this.dispatchEvent(event)
  }
}

export class VirtualRpcWebSocket extends VirtualWebSocketBase {
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.assertOpen()
    void this.respond(data)
  }

  private async respond(data: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<void> {
    try {
      const text = typeof data === 'string'
        ? data
        : data instanceof Blob
          ? await data.text()
          : new TextDecoder().decode(data as ArrayBufferLike)
      const payload = JSON.parse(text) as unknown
      const facade = await this.facadePromise
      const response = await facade.handleRpcPayload(payload)
      if (response !== null)
        this.emitMessage(response)
    }
    catch (error) {
      this.emitMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: publicErrorMessage(error) },
      })
    }
  }
}

export class VirtualClientsWebSocket extends VirtualWebSocketBase {
  private targetUuid: string | undefined
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.assertOpen()
    if (typeof data !== 'string')
      throw new TypeError('Komari /api/clients expects a text command')
    const [command, uuid] = data.trim().split(/\s+/, 2)
    if (command !== 'get')
      return
    this.targetUuid = uuid || undefined
    void this.pollAndSchedule()
  }

  protected override beforeClose(): void {
    if (this.pollTimer)
      clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private async pollAndSchedule(): Promise<void> {
    if (this.polling || this.readyState !== OPEN)
      return
    this.polling = true
    try {
      const facade = await this.facadePromise
      this.emitMessage(await facade.getRealtimeSnapshot(this.targetUuid))
    }
    catch (error) {
      this.emitError(error)
    }
    finally {
      this.polling = false
      if (this.readyState === OPEN) {
        if (this.pollTimer)
          clearTimeout(this.pollTimer)
        this.pollTimer = setTimeout(() => void this.pollAndSchedule(), 3_000)
      }
    }
  }
}

export function installWebSocketFacade(
  target: Window & typeof globalThis,
  facadePromise: FacadePromise,
): typeof WebSocket {
  const NativeWebSocket = target.WebSocket
  const CompatibleWebSocket = new Proxy(NativeWebSocket, {
    construct(constructor, argumentsList) {
      const rawUrl = String(argumentsList[0] ?? '')
      const url = new URL(rawUrl, target.location.href)
      const isCurrentHost = url.host === target.location.host && (url.protocol === 'ws:' || url.protocol === 'wss:')
      if (isCurrentHost && url.pathname === '/api/rpc2')
        return new VirtualRpcWebSocket(url.toString(), facadePromise)
      if (isCurrentHost && url.pathname === '/api/clients')
        return new VirtualClientsWebSocket(url.toString(), facadePromise)
      return Reflect.construct(constructor, argumentsList)
    },
  })
  target.WebSocket = CompatibleWebSocket
  return NativeWebSocket
}
