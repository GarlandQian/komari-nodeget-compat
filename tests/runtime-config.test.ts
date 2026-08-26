import { describe, expect, it } from 'bun:test'
import { loadRuntimeConfig } from '../src/runtime/config'

const compatManifest = {
  schema: 1,
  source: { name: 'Fixture', short: 'Fixture', version: '1.0.0' },
  themeSettingsDefaults: {},
  themeSettingKeys: [],
  themeSettingArrayKeys: [],
}

function fixtureFetch(config: unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname
    return Response.json(pathname.endsWith('komari-compat.json') ? compatManifest : config)
  }) as typeof fetch
}

describe('runtime config', () => {
  it('requires a non-empty NodeGet site token', async () => {
    await expect(loadRuntimeConfig(
      fixtureFetch({ site_tokens: [] }),
      new URL('https://theme.example/'),
    )).rejects.toThrow('at least one NodeGet site_tokens entry')

    await expect(loadRuntimeConfig(
      fixtureFetch({ site_tokens: [{ backend_url: 'wss://nodeget.example/nodeget/rpc', token: '' }] }),
      new URL('https://theme.example/'),
    )).rejects.toThrow('.token is required')
  })

  it('accepts a configured read-only token entry', async () => {
    const loaded = await loadRuntimeConfig(
      fixtureFetch({
        site_tokens: [{ backend_url: 'wss://nodeget.example/nodeget/rpc', token: 'read-only-token' }],
      }),
      new URL('https://theme.example/'),
    )
    expect(loaded.config.site_tokens?.[0]?.token).toBe('read-only-token')
  })

  it('accepts the backend origin format saved by the NodeGet theme panel', async () => {
    const loaded = await loadRuntimeConfig(
      fixtureFetch({
        site_tokens: [{ backend_url: 'https://nodeget.example', token: 'read-only-token' }],
      }),
      new URL('https://theme.example/'),
    )
    expect(loaded.config.site_tokens?.[0]?.backend_url).toBe('https://nodeget.example')
  })
})
