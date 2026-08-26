export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function environmentFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '')
}

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value == null)
    return fallback
  if (typeof value !== 'string')
    return value as T

  try {
    return JSON.parse(value) as T
  }
  catch {
    return value as T
  }
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function firstFiniteValue(source: unknown, keys: readonly string[], fallback = 0): number {
  if (!isRecord(source))
    return fallback

  for (const key of keys) {
    const value = Number(source[key])
    if (Number.isFinite(value))
      return value
  }

  return fallback
}

export function timestampMs(value: unknown): number {
  const number = finiteNumber(value)
  return number > 0 && number < 1e12 ? number * 1000 : number
}

export function isoTime(value: unknown = Date.now()): string {
  const milliseconds = timestampMs(value)
  return new Date(milliseconds || Date.now()).toISOString()
}

export function stablePositiveId(value: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) || 1
}

export function sourceKey(name: string, backendUrl: string): string {
  return stablePositiveId(`${name}\u0000${backendUrl}`).toString(36)
}

export function normalizeWebSocketUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'http:')
    url.protocol = 'ws:'
  else if (url.protocol === 'https:')
    url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new Error(`NodeGet backend_url must use http(s):// or ws(s)://: ${value}`)
  if (url.pathname === '/' || !url.pathname)
    url.pathname = '/nodeget/rpc'
  url.username = ''
  url.password = ''
  url.hash = ''
  return url.toString()
}

export function downsampleEvenly<T>(values: readonly T[], maxCount: number): T[] {
  if (maxCount <= 0 || values.length <= maxCount)
    return [...values]
  if (maxCount === 1)
    return [values.at(-1)!]

  const result: T[] = []
  const lastIndex = values.length - 1
  for (let index = 0; index < maxCount; index += 1) {
    const sourceIndex = Math.round((index * lastIndex) / (maxCount - 1))
    result.push(values[sourceIndex]!)
  }
  return result
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(String).map(item => item.trim()).filter(Boolean)
  if (typeof value !== 'string')
    return []
  return value.split(/[,;，；\s]+/u).map(item => item.trim()).filter(Boolean)
}

export function localizedText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim())
    return value.trim()
  if (!isRecord(value))
    return fallback

  const preferredKeys = ['zh-CN', 'zh', 'en-US', 'en']
  for (const key of preferredKeys) {
    const text = value[key]
    if (typeof text === 'string' && text.trim())
      return text.trim()
  }

  for (const text of Object.values(value)) {
    if (typeof text === 'string' && text.trim())
      return text.trim()
  }
  return fallback
}

export function publicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
