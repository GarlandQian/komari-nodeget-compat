import { describe, expect, it } from 'bun:test'
import { loadRuntimeConfig } from '../src/runtime/config'

const compatManifest = {
  schema: 1,
  source: { name: 'Fixture', short: 'Fixture', version: '1.0.0' },
  themeSettingsDefaults: {},
  themeSettingKeys: [],
  themeSettingArrayKeys: [],
}

function fixtureFetch(config: unknown, manifest: unknown = compatManifest): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname
    return Response.json(pathname.endsWith('komari-compat.json') ? manifest : config)
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

  it('rejects malformed preference and compatibility metadata before installing hooks', async () => {
    await expect(loadRuntimeConfig(
      fixtureFetch({
        user_preferences: 'not-an-object',
        site_tokens: [{ backend_url: 'https://nodeget.example', token: 'read-only-token' }],
      }),
      new URL('https://theme.example/'),
    )).rejects.toThrow('user_preferences must be an object')

    const invalidManifestFetch = (async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname
      return Response.json(pathname.endsWith('komari-compat.json')
        ? { ...compatManifest, themeSettingKeys: [1] }
        : { site_tokens: [{ backend_url: 'https://nodeget.example', token: 'read-only-token' }] })
    }) as typeof fetch
    await expect(loadRuntimeConfig(
      invalidManifestFetch,
      new URL('https://theme.example/'),
    )).rejects.toThrow('theme setting keys must be strings')
  })

  it('accepts optional explicit JSON field types while keeping old manifests valid', async () => {
    const types = { note: 'string', tasks: 'array', bindings: 'object', count: 'number', enabled: 'boolean', custom: 'any' } as const
    const config = { site_tokens: [{ backend_url: 'https://nodeget.example', token: 'read-only-token' }] }
    const loaded = await loadRuntimeConfig(
      fixtureFetch(config, { ...compatManifest, themeSettingValueTypes: types }),
      new URL('https://theme.example/'),
    )
    expect(loaded.manifest.themeSettingValueTypes).toEqual(types)
    const legacy = await loadRuntimeConfig(fixtureFetch(config), new URL('https://theme.example/'))
    expect(legacy.manifest.themeSettingValueTypes).toBeUndefined()
  })

  it('rejects invalid JSON field metadata and unsafe setting keys', async () => {
    const config = { site_tokens: [{ backend_url: 'https://nodeget.example', token: 'read-only-token' }] }
    for (const metadata of [
      { themeSettingValueTypes: [] },
      { themeSettingValueTypes: { tasks: 'csv' } },
      { themeSettingValueTypes: { enabled: false } },
      { themeSettingValueTypes: JSON.parse('{"__proto__":"object"}') },
      { themeSettingKeys: ['constructor'] },
      { themeSettingArrayKeys: ['prototype'] },
      { themeSettingsDefaults: JSON.parse('{"__proto__":{}}') },
    ]) {
      await expect(loadRuntimeConfig(
        fixtureFetch(config, { ...compatManifest, ...metadata }),
        new URL('https://theme.example/'),
      )).rejects.toThrow('komari-compat.json')
    }
  })
})
