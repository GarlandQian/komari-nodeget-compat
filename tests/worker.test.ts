import { describe, expect, it } from 'bun:test'
import worker from '../src/worker/index'

function environment(background?: string) {
  return {
    ASSETS: {
      fetch: async () => new Response('asset'),
    },
    ALLOWED_GITHUB_REPOSITORIES: '',
    ...(background === undefined ? {} : { ACG_BACKGROUND_ENABLED: background }),
  }
}

describe('Cloudflare worker', () => {
  it('keeps the optional background disabled by default', async () => {
    const response = await worker.fetch(new Request('https://adapter.example/api/config'), environment())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      acg_background_enabled: false,
      nodeget_dashboard_url: 'https://dash.nodeget.com',
      remote_theme_enabled: false,
      remote_theme_repositories: [],
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('accepts explicit true-like environment values', async () => {
    for (const value of ['true', '1', 'yes', 'ON']) {
      const response = await worker.fetch(new Request('https://adapter.example/api/config'), environment(value))
      expect(await response.json()).toEqual({
        acg_background_enabled: true,
        nodeget_dashboard_url: 'https://dash.nodeget.com',
        remote_theme_enabled: false,
        remote_theme_repositories: [],
      })
    }
  })

  it('publishes a validated custom NodeGet dashboard URL and falls back to the official dashboard', async () => {
    const custom = await worker.fetch(new Request('https://adapter.example/api/config'), {
      ...environment(),
      NODEGET_DASHBOARD_URL: 'https://nodeget.example/panel/?ignored=true#old',
    })
    expect(await custom.json()).toMatchObject({
      nodeget_dashboard_url: 'https://nodeget.example/panel',
    })

    const invalid = await worker.fetch(new Request('https://adapter.example/api/config'), {
      ...environment(),
      NODEGET_DASHBOARD_URL: 'javascript:alert(1)',
    })
    expect(await invalid.json()).toMatchObject({
      nodeget_dashboard_url: 'https://dash.nodeget.com',
    })
  })

  it('does not expose an open API proxy', async () => {
    const response = await worker.fetch(new Request('https://adapter.example/api/unknown'), environment('true'))
    expect(response.status).toBe(404)
  })

  it('falls back to the static assets binding outside API routes', async () => {
    const response = await worker.fetch(new Request('https://adapter.example/index.html'), environment())
    expect(await response.text()).toBe('asset')
  })

  it('rejects GitHub repositories outside the configured allowlist', async () => {
    const response = await worker.fetch(
      new Request('https://adapter.example/themes/github/example/theme/latest/nodeget-theme.json'),
      environment(),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'repository_not_allowed' })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
