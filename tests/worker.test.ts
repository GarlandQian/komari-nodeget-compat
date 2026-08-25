import { describe, expect, it } from 'bun:test'
import worker from '../src/worker/index'

function environment(background?: string) {
  return {
    ASSETS: {
      fetch: async () => new Response('asset'),
    },
    ...(background === undefined ? {} : { ACG_BACKGROUND_ENABLED: background }),
  }
}

describe('Cloudflare worker', () => {
  it('keeps the optional background disabled by default', async () => {
    const response = await worker.fetch(new Request('https://adapter.example/api/config'), environment())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ acg_background_enabled: false })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('accepts explicit true-like environment values', async () => {
    for (const value of ['true', '1', 'yes', 'ON']) {
      const response = await worker.fetch(new Request('https://adapter.example/api/config'), environment(value))
      expect(await response.json()).toEqual({ acg_background_enabled: true })
    }
  })

  it('does not expose an open API proxy', async () => {
    const response = await worker.fetch(new Request('https://adapter.example/api/unknown'), environment('true'))
    expect(response.status).toBe(404)
  })

  it('falls back to the static assets binding outside API routes', async () => {
    const response = await worker.fetch(new Request('https://adapter.example/index.html'), environment())
    expect(await response.text()).toBe('asset')
  })
})
