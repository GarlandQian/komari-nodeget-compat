import { isRecord } from '../shared/utils'
import type { HistoryRequestScheduler } from './history-requests'
import type { NodeGetCaller } from './rpc-client'

const REFRESH_MS = 10_000
const CACHE_MS = 30_000
const MAX_ENTRIES = 256
const REQUEST_TIMEOUT_MS = 5_000
const CURRENT_METHOD = 'agent_query_traffic_current'
const HISTORY_METHOD = 'agent_query_traffic'

type TrafficMethod = typeof CURRENT_METHOD | typeof HISTORY_METHOD

export interface NativeTraffic {
  up: number
  down: number
  // Oldest included interface report, not the database flush time of a period total.
  updatedAt: number
}

interface TrafficEntry {
  value?: NativeTraffic
  expiresAt: number
  refreshAt: number
  pending: boolean
}

class TrafficRetryError extends Error {
  constructor(readonly retryAt: number) {
    super('Native traffic is unavailable')
  }
}

function unavailable(): never {
  throw new TrafficRetryError(Date.now() + 60_000)
}

function unsignedInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return unavailable()
  return value
}

function snapshotTime(value: unknown): number {
  const timestamp = unsignedInteger(value)
  return timestamp > 0 ? timestamp : unavailable()
}

function interfaces(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value) || !value.length)
    return unavailable()
  const result = new Map<string, Record<string, unknown>>()
  for (const row of value) {
    if (!isRecord(row) || typeof row.interface_name !== 'string'
      || !row.interface_name.trim() || result.has(row.interface_name))
      return unavailable()
    result.set(row.interface_name, row)
  }
  return result
}

function sumTraffic(
  rows: Map<string, Record<string, unknown>>,
  received: string,
  transmitted: string,
): Pick<NativeTraffic, 'up' | 'down'> {
  let up = 0
  let down = 0
  for (const row of rows.values()) {
    up = unsignedInteger(up + unsignedInteger(row[transmitted]))
    down = unsignedInteger(down + unsignedInteger(row[received]))
  }
  return { up, down }
}

function sameInterfaces(
  expected: Map<string, Record<string, unknown>>,
  actual: Map<string, Record<string, unknown>>,
): boolean {
  return expected.size === actual.size && [...expected.keys()].every(name => actual.has(name))
}

function currentTraffic(value: unknown, uuid: string): {
  value: NativeTraffic
  interfaces: Map<string, Record<string, unknown>>
} {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0]) || value[0].uuid !== uuid)
    return unavailable()
  const rows = interfaces(value[0].interfaces)
  let updatedAt = Infinity
  for (const row of rows.values()) {
    // A current counter can exist before the Worker has persisted its first snapshot.
    if (row.last_snapshot_time !== null)
      snapshotTime(row.last_snapshot_time)
    updatedAt = Math.min(updatedAt, snapshotTime(row.updated_at))
  }
  return { value: { ...sumTraffic(rows, 'total_received', 'total_transmitted'), updatedAt }, interfaces: rows }
}

function trafficRange(value: unknown, uuid: string): Map<string, Record<string, unknown>> {
  if (!isRecord(value) || value.uuid !== uuid)
    return unavailable()
  const rows = interfaces(value.interfaces)
  for (const row of rows.values()) {
    if (snapshotTime(row.first_snapshot_time) > snapshotTime(row.last_snapshot_time))
      return unavailable()
  }
  return rows
}

function trafficTotal(value: unknown, uuid: string, start: number): {
  value: Pick<NativeTraffic, 'up' | 'down'>
  interfaces: Map<string, Record<string, unknown>>
} {
  if (!isRecord(value) || value.uuid !== uuid || value.start_time !== start || value.end_time !== null
    || !Array.isArray(value.possible_data_losses) || value.possible_data_losses.length)
    return unavailable()
  const rows = interfaces(value.interfaces)
  const total = sumTraffic(rows, 'received', 'transmitted')
  if (unsignedInteger(value.received) !== total.down || unsignedInteger(value.transmitted) !== total.up)
    return unavailable()
  return { value: total, interfaces: rows }
}

/** Per-source, nonblocking reads of NodeGet 0.6.0 native traffic counters. */
export class NodeGetTrafficReader {
  private readonly entries = new Map<string, TrafficEntry>()
  private readonly retryAt = new Map<string, number>()
  private readonly disabledMethods = new Set<TrafficMethod>()
  private closed = false

  constructor(
    private readonly rpc: NodeGetCaller,
    private readonly scheduler: HistoryRequestScheduler,
  ) {}

  read(uuid: string, periodStart?: number): NativeTraffic | undefined {
    if (this.closed || !uuid.trim()
      || (periodStart !== undefined && (!Number.isSafeInteger(periodStart) || periodStart <= 0)))
      return undefined
    const key = JSON.stringify([uuid, periodStart ?? null])
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= MAX_ENTRIES) {
        const removable = [...this.entries].find(([, candidate]) => !candidate.pending)
        if (!removable)
          return undefined
        this.entries.delete(removable[0])
      }
      entry = { expiresAt: 0, refreshAt: 0, pending: false }
    }
    this.entries.delete(key)
    this.entries.set(key, entry)

    const now = Date.now()
    if (!entry.pending && now >= entry.refreshAt && !this.disabledMethods.has(CURRENT_METHOD)
      && (periodStart === undefined || !this.disabledMethods.has(HISTORY_METHOD))) {
      entry.pending = true
      void this.refresh(key, entry, uuid, periodStart)
    }
    return entry.value && now < entry.expiresAt ? { ...entry.value } : undefined
  }

  close(): void {
    this.closed = true
    this.entries.clear()
    this.retryAt.clear()
    this.disabledMethods.clear()
  }

  private async refresh(key: string, entry: TrafficEntry, uuid: string, periodStart?: number): Promise<void> {
    try {
      const current = await this.request(CURRENT_METHOD, [uuid], { uuids: [uuid] }, value => currentTraffic(value, uuid))
      let value = current.value
      if (periodStart !== undefined) {
        // In 0.6.0, omitting end_time uses database cumulative totals. These
        // can trail current counters by the approximately 60-second DB flush.
        const [range, total] = await Promise.all([
          this.request(HISTORY_METHOD, [uuid, 'range'], {
            query: { uuid, granularity: 'range' },
          }, payload => trafficRange(payload, uuid)),
          this.request(HISTORY_METHOD, [uuid, 'total', periodStart], {
            query: { uuid, start_time: periodStart, granularity: 'total' },
          }, payload => trafficTotal(payload, uuid, periodStart)),
        ])
        if (!sameInterfaces(current.interfaces, range) || !sameInterfaces(current.interfaces, total.interfaces)
          || [...range.values()].some(row => snapshotTime(row.first_snapshot_time) > periodStart
            || snapshotTime(row.last_snapshot_time) < periodStart))
          unavailable()
        value = { ...total.value, updatedAt: current.value.updatedAt }
      }
      if (!this.closed && this.entries.get(key) === entry) {
        const now = Date.now()
        entry.value = value
        entry.expiresAt = now + CACHE_MS
        entry.refreshAt = now + REFRESH_MS
      }
    }
    catch (error) {
      if (!this.closed && this.entries.get(key) === entry)
        entry.refreshAt = error instanceof TrafficRetryError ? error.retryAt : Date.now() + 30_000
    }
    finally {
      entry.pending = false
    }
  }

  private async request<T>(
    method: TrafficMethod,
    scope: Array<string | number>,
    params: Record<string, unknown>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    if (this.closed || this.disabledMethods.has(method))
      throw new TrafficRetryError(Infinity)
    const key = JSON.stringify([method, ...scope])
    const retryAt = this.retryAt.get(key) ?? 0
    if (Date.now() < retryAt)
      throw new TrafficRetryError(retryAt)
    try {
      const payload = await this.scheduler.call<unknown>(this.rpc, method, params, { timeoutMs: REQUEST_TIMEOUT_MS })
      if (this.closed)
        throw new TrafficRetryError(Infinity)
      const parsed = parse(payload)
      this.retryAt.delete(key)
      return parsed
    }
    catch (error) {
      if (this.closed)
        throw new TrafficRetryError(Infinity)
      const code = isRecord(error) ? error.code : undefined
      let failure = error instanceof TrafficRetryError
        ? error
        : new TrafficRetryError(Date.now() + (code === 102 ? 300_000 : code === 105 ? 60_000 : 30_000))
      if (code === -32601) {
        this.disabledMethods.add(method)
        failure = new TrafficRetryError(Infinity)
      }
      this.retryAt.delete(key)
      this.retryAt.set(key, failure.retryAt)
      while (this.retryAt.size > MAX_ENTRIES)
        this.retryAt.delete(this.retryAt.keys().next().value!)
      throw failure
    }
  }
}
