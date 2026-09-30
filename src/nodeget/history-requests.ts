import type { NodeGetCaller } from './rpc-client'
import { NodeGetRpcError } from './rpc-client'

type HistoryMethod = 'agent_query_dynamic_summary' | 'task_query'

interface HistoryRequestOptions {
  concurrency?: 1 | 2
  cacheTtlMs?: number
  maxCacheEntries?: number
  now?: () => number
}

interface HistoryRequest {
  caller: NodeGetCaller
  key: string
  method: HistoryMethod
  params: Record<string, unknown>
  promise: Promise<unknown>
  controller: AbortController
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface CachedResponse {
  caller: NodeGetCaller
  expiresAt: number
  value: unknown
}

function requestParamsKey(params: Record<string, unknown>): string {
  return JSON.stringify(params, (_key, value: unknown) => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value
  ))
}

/** One scheduler per runtime: nodes, sources and history endpoints share the same slots. */
export class HistoryRequestScheduler {
  private readonly concurrency: 1 | 2
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly now: () => number
  private readonly callerIds = new WeakMap<NodeGetCaller, number>()
  private readonly closedCallers = new WeakSet<NodeGetCaller>()
  private readonly pending = new Map<string, HistoryRequest>()
  private readonly cache = new Map<string, CachedResponse>()
  private queue: HistoryRequest[] = []
  private active = 0
  private nextCallerId = 0
  private closed = false
  private timeAnchor: { value: number, expiresAt: number } | null = null

  constructor({ concurrency = 2, cacheTtlMs = 10_000, maxCacheEntries = 32, now = Date.now }: HistoryRequestOptions = {}) {
    if (concurrency !== 1 && concurrency !== 2)
      throw new RangeError('History concurrency must be 1 or 2')
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0)
      throw new RangeError('History cache TTL must be non-negative')
    if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 0)
      throw new RangeError('History cache size must be a non-negative integer')
    this.concurrency = concurrency
    this.cacheTtlMs = cacheTtlMs
    this.maxCacheEntries = maxCacheEntries
    this.now = now
  }

  /** Avoid millisecond drift defeating deduplication of repeated relative time ranges. */
  queryTime(): number {
    const now = this.now()
    if (!this.timeAnchor || now >= this.timeAnchor.expiresAt || now < this.timeAnchor.value)
      this.timeAnchor = { value: now, expiresAt: now + this.cacheTtlMs }
    return this.timeAnchor.value
  }

  call<T>(caller: NodeGetCaller, method: HistoryMethod, params: Record<string, unknown>): Promise<T> {
    if (this.closed || this.closedCallers.has(caller))
      return Promise.reject(new NodeGetRpcError('NodeGet history requests are closed'))

    let callerId = this.callerIds.get(caller)
    if (callerId === undefined) {
      callerId = ++this.nextCallerId
      this.callerIds.set(caller, callerId)
    }
    const key = `${callerId}:${method}:${requestParamsKey(params)}`
    this.expireCache()
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return Promise.resolve(cached.value).then(value => structuredClone(value) as T)
    }

    let request = this.pending.get(key)
    if (!request) {
      let resolve!: (value: unknown) => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<unknown>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
      })
      request = { caller, key, method, params, promise, controller: new AbortController(), resolve, reject }
      this.pending.set(key, request)
      this.queue.push(request)
      this.drain()
    }
    // Consumers can transform their results without modifying another request or the cache.
    return request.promise.then(value => structuredClone(value) as T)
  }

  close(caller?: NodeGetCaller): void {
    if (caller)
      this.closedCallers.add(caller)
    else
      this.closed = true
    const error = new NodeGetRpcError('NodeGet history requests are closed')
    for (const [key, request] of this.pending) {
      if (!caller || request.caller === caller) {
        this.pending.delete(key)
        request.reject(error)
        request.controller.abort(error)
      }
    }
    for (const [key, cached] of this.cache) {
      if (!caller || cached.caller === caller)
        this.cache.delete(key)
    }
    this.queue = this.queue.filter(request => this.pending.get(request.key) === request)
    if (!caller)
      this.timeAnchor = null
  }

  private expireCache(): void {
    const now = this.now()
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now)
        this.cache.delete(key)
    }
  }

  private drain(): void {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const request = this.queue.shift()!
      this.active += 1
      void this.execute(request)
    }
  }

  private async execute(request: HistoryRequest): Promise<void> {
    try {
      const value = await request.caller.call<unknown>(request.method, request.params, { signal: request.controller.signal })
      if (this.pending.get(request.key) !== request)
        return
      this.pending.delete(request.key)
      if (this.cacheTtlMs > 0 && this.maxCacheEntries > 0) {
        this.expireCache()
        this.cache.set(request.key, { caller: request.caller, value, expiresAt: this.now() + this.cacheTtlMs })
        while (this.cache.size > this.maxCacheEntries)
          this.cache.delete(this.cache.keys().next().value!)
      }
      request.resolve(value)
    }
    catch (error) {
      if (this.pending.get(request.key) === request) {
        this.pending.delete(request.key)
        request.reject(error)
      }
    }
    finally {
      this.active -= 1
      this.drain()
    }
  }
}
