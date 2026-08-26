import { environmentFlagEnabled, isRecord } from '../shared/utils'

export interface AcgBackgroundEnvironment {
  ACG_BACKGROUND_ENABLED?: string
}

export interface AcgBackgroundDependencies {
  fetcher?: typeof fetch
  now?: () => number
  onError?: (error: unknown) => void
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ status: 'error', code, message }, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

function portraitRequest(request: Request): boolean {
  const orientation = new URL(request.url).searchParams.get('orientation')?.trim().toLowerCase()
  if (orientation === 'portrait')
    return true
  if (orientation === 'landscape')
    return false
  if (orientation && orientation !== 'auto')
    throw new TypeError('orientation must be auto, portrait, or landscape')
  if (request.headers.get('sec-ch-ua-mobile') === '?1')
    return true
  return /Android|iP(?:hone|od)|Mobile|Opera Mobi|BlackBerry/i.test(request.headers.get('user-agent') ?? '')
}

function allowedImageUrl(value: unknown): URL | null {
  if (typeof value !== 'string')
    return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:')
      return null
    if (url.hostname !== 'list.yppp.net' && !url.hostname.endsWith('.list.yppp.net'))
      return null
    url.username = ''
    url.password = ''
    url.hash = ''
    return url
  }
  catch {
    return null
  }
}

export async function handleAcgBackground(
  request: Request,
  env: AcgBackgroundEnvironment,
  dependencies: AcgBackgroundDependencies = {},
): Promise<Response> {
  if (!environmentFlagEnabled(env.ACG_BACKGROUND_ENABLED))
    return jsonError(404, 'background_disabled', 'ACG background is disabled')
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return jsonError(405, 'method_not_allowed', 'Method not allowed')

  let portrait: boolean
  try {
    portrait = portraitRequest(request)
  }
  catch (error) {
    return jsonError(400, 'invalid_orientation', error instanceof Error ? error.message : String(error))
  }

  const fetcher = dependencies.fetcher ?? fetch
  const now = dependencies.now ?? Date.now
  const apiUrl = new URL(`https://api.yppp.net/${portrait ? 'pe.php' : 'pc.php'}`)
  apiUrl.searchParams.set('return', 'json')
  apiUrl.searchParams.set('komari-nodeget', String(now()))

  try {
    const metadataResponse = await fetcher(apiUrl, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'user-agent': 'komari-nodeget-theme-adapter/0.3.2',
      },
      redirect: 'manual',
      signal: request.signal,
    })
    if (!metadataResponse.ok)
      throw new Error(`metadata HTTP ${metadataResponse.status}`)
    const metadata: unknown = await metadataResponse.json()
    const imageUrl = isRecord(metadata) ? allowedImageUrl(metadata.acgurl) : null
    if (!imageUrl)
      throw new Error('metadata did not contain an allowed image URL')

    const imageResponse = await fetcher(imageUrl, {
      cache: 'no-store',
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
      redirect: 'manual',
      signal: request.signal,
    })
    const contentType = imageResponse.headers.get('content-type') ?? ''
    if (!imageResponse.ok || !contentType.toLowerCase().startsWith('image/'))
      throw new Error(`image HTTP ${imageResponse.status}`)

    const headers = new Headers({
      'access-control-allow-origin': '*',
      'cache-control': 'private, no-store',
      'content-type': contentType,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-upstream-service': 'yppp-acg',
    })
    const contentLength = imageResponse.headers.get('content-length')
    if (contentLength)
      headers.set('content-length', contentLength)
    return new Response(request.method === 'HEAD' ? null : imageResponse.body, {
      status: 200,
      headers,
    })
  }
  catch (error) {
    if (dependencies.onError)
      dependencies.onError(error)
    else
      console.error('[acg-background] Upstream request failed', error)
    return jsonError(502, 'background_upstream_failed', 'ACG background service is temporarily unavailable')
  }
}
