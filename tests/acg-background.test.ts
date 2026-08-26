import { describe, expect, it } from 'bun:test'
import { handleAcgBackground } from '../src/worker/acg-background'

describe('ACG background proxy', () => {
  it('stays unavailable while the environment switch is disabled', async () => {
    let called = false
    const response = await handleAcgBackground(
      new Request('https://adapter.example/api/acg-background'),
      {},
      { fetcher: (async () => { called = true; return new Response() }) as unknown as typeof fetch },
    )
    expect(response.status).toBe(404)
    expect(called).toBe(false)
  })

  it('proxies a validated landscape image through the Worker origin', async () => {
    const requests: string[] = []
    const redirects: Array<RequestRedirect | undefined> = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url.href)
      redirects.push(init?.redirect)
      if (url.hostname === 'api.yppp.net') {
        return Response.json({
          code: '200',
          acgurl: 'https://list.yppp.net/d/image/test.png',
        })
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-length': '3', 'content-type': 'image/png' },
      })
    }) as unknown as typeof fetch
    const response = await handleAcgBackground(
      new Request('https://adapter.example/api/acg-background?orientation=landscape'),
      { ACG_BACKGROUND_ENABLED: 'true' },
      { fetcher, now: () => 1234 },
    )
    expect(response.status).toBe(200)
    expect(requests[0]).toContain('/pc.php?')
    expect(requests[0]).toContain('return=json')
    expect(requests[1]).toBe('https://list.yppp.net/d/image/test.png')
    expect(redirects).toEqual(['manual', 'manual'])
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects image URLs outside the fixed upstream host', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      return Response.json({ acgurl: 'https://example.com/not-allowed.png' })
    }) as unknown as typeof fetch
    const response = await handleAcgBackground(
      new Request('https://adapter.example/api/acg-background'),
      { ACG_BACKGROUND_ENABLED: 'true' },
      { fetcher, onError: () => {} },
    )
    expect(response.status).toBe(502)
    expect(calls).toBe(1)
  })
})
