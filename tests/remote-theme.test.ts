import { beforeEach, describe, expect, it } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
  handleRemoteTheme,
  resetRemoteThemeMemoryForTests,
  type R2ObjectBody,
  type RemoteThemeEnvironment,
  type ThemeCacheBucket,
} from '../src/worker/remote-theme'

function sourceTheme(version = '2.0.0'): Uint8Array {
  return zipSync({
    'komari-theme.json': strToU8(JSON.stringify({
      name: 'Komari Remote Fixture',
      short: 'RemoteFixture',
      version,
      configuration: {
        type: 'managed',
        data: [
          { key: 'backgroundEnabled', type: 'switch', name: '背景', default: false },
          { key: 'backgroundType', type: 'select', name: '类型', options: ['image', 'video'], default: 'image' },
          { key: 'lightBackgroundUrl', type: 'string', name: '亮色背景', default: '' },
          { key: 'darkBackgroundUrl', type: 'string', name: '暗色背景', default: '' },
        ],
      },
    })),
    'preview.png': new Uint8Array([1, 2, 3]),
    'dist/index.html': strToU8('<!doctype html><html><head><title>Komari Monitor</title><link rel="icon" href="/favicon.ico"><script type="module" src="/assets/app.js"></script></head><body><img src="/images/logo.png">remote</body></html>'),
    'dist/assets/app.js': strToU8(`globalThis.remoteFixture="${version}";globalThis.brand="Komari Monitor";globalThis.favicon="/favicon.ico";globalThis.logo="/images/logo.png";globalThis.preload="assets/lazy.css"`),
    'dist/images/logo.png': new Uint8Array([4, 5, 6]),
  })
}

function bytesFromView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
}

class MemoryObject implements R2ObjectBody {
  readonly body: ReadableStream<Uint8Array>
  readonly etag: string
  readonly size: number

  constructor(private readonly bytes: Uint8Array) {
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    this.body = new Blob([body]).stream()
    this.etag = `memory-${bytes.byteLength}`
    this.size = bytes.byteLength
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer as ArrayBuffer
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes)
  }
}

class MemoryBucket implements ThemeCacheBucket {
  readonly objects = new Map<string, Uint8Array>()
  puts = 0

  constructor(private readonly failPutSuffix?: string) {}

  async get(key: string, options?: { range?: { offset: number, length: number } }): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key)
    if (!stored)
      return null
    const range = options?.range
    const bytes = range ? stored.slice(range.offset, range.offset + range.length) : stored.slice()
    return new MemoryObject(bytes)
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
  ): Promise<void> {
    if (this.failPutSuffix && key.endsWith(this.failPutSuffix))
      throw new Error(`Fixture R2 write failed: ${key}`)
    let bytes: Uint8Array
    if (typeof value === 'string')
      bytes = new TextEncoder().encode(value)
    else if (value instanceof Blob)
      bytes = new Uint8Array(await value.arrayBuffer())
    else if (value instanceof ArrayBuffer)
      bytes = new Uint8Array(value.slice(0))
    else if (ArrayBuffer.isView(value))
      bytes = bytesFromView(value)
    else
      bytes = new Uint8Array(await new Response(value).arrayBuffer())
    this.objects.set(key, bytes)
    this.puts += 1
  }
}

function fixtureFetch(source: Uint8Array): { fetcher: typeof fetch, calls: { api: number, asset: number } } {
  const calls = { api: 0, asset: 0 }
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'api.github.com') {
      calls.api += 1
      return Response.json({
        id: 20,
        tag_name: 'v2.0.0',
        published_at: '2026-08-25T12:00:00Z',
        assets: [{
          id: 30,
          name: 'komari-theme-build.zip',
          browser_download_url: 'https://github.com/test-owner/test-theme/releases/download/v2.0.0/komari-theme-build.zip',
          size: source.byteLength,
        }],
      })
    }
    if (url.hostname === 'github.com') {
      calls.asset += 1
      return new Response(source.slice(), {
        headers: { 'content-length': String(source.byteLength), 'content-type': 'application/zip' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetcher, calls }
}

function environment(bucket: MemoryBucket): RemoteThemeEnvironment {
  return {
    ASSETS: {
      fetch: async request => new URL(request.url).pathname === '/komari-nodeget-runtime.js'
        ? new Response('globalThis.compat=true;')
        : new Response('not found', { status: 404 }),
    },
    THEME_CACHE: bucket,
    ALLOWED_GITHUB_REPOSITORIES: 'test-owner/test-theme',
  }
}

describe('remote NodeGet theme distribution', () => {
  beforeEach(() => resetRemoteThemeMemoryForTests())

  it('serves a lightweight install list backed by immutable release assets', async () => {
    const source = sourceTheme()
    const bucket = new MemoryBucket()
    const { fetcher, calls } = fixtureFetch(source)
    const env = environment(bucket)
    env.ACG_BACKGROUND_ENABLED = 'true'
    const base = 'https://adapter.example/themes/github/test-owner/test-theme/latest'

    const manifestResponse = await handleRemoteTheme(
      new Request(`${base}/nodeget-theme.json`),
      env,
      { fetcher, now: () => 1_000_000 },
    )
    expect(manifestResponse?.status).toBe(200)
    const manifest = await manifestResponse!.json() as Record<string, unknown>
    expect(manifest.short).toBe('NG-RemoteFixture')
    expect(manifest.version).toBe('2.0.0')
    expect(manifest.dist_page).toBe(base)
    expect(manifest.name).toBe('NodeGet Remote Fixture')
    expect(JSON.stringify(manifest)).not.toContain('Komari Remote Fixture')
    expect(manifestResponse?.headers.get('access-control-allow-origin')).toBe('*')

    const manifestHead = await handleRemoteTheme(
      new Request(`${base}/nodeget-theme.json`, { method: 'HEAD' }),
      env,
      { fetcher, now: () => 1_000_050 },
    )
    expect(manifestHead?.status).toBe(200)
    expect(manifestHead?.headers.get('etag')).toBeNull()
    expect(manifestHead?.headers.get('content-length')).toBe(manifestResponse?.headers.get('content-length'))
    expect(await manifestHead!.text()).toBe('')

    const fileListResponse = await handleRemoteTheme(
      new Request(`${base}/nodeget-theme-files.json`),
      env,
      { fetcher, now: () => 1_000_100 },
    )
    const fileList = await fileListResponse!.json() as string[]
    expect(fileList).toEqual([
      'nodeget-theme.json',
      'nodeget-theme-files.json',
      'index.html',
      'komari-nodeget-runtime.js',
      'komari-compat.json',
      'config.json',
      'custom.css',
      'custom.js',
      'preview.png',
    ])
    expect(fileList).not.toContain('assets/app.js')
    expect(fileList).not.toContain('images/logo.png')

    env.ASSETS = {
      fetch: async request => new URL(request.url).pathname === '/komari-nodeget-runtime.js'
        ? new Response('globalThis.compat="current-deployment";')
        : new Response('not found', { status: 404 }),
    }
    const runtimeResponse = await handleRemoteTheme(
      new Request(`${base}/komari-nodeget-runtime.js`),
      env,
      { fetcher, now: () => 1_000_125 },
    )
    expect(await runtimeResponse!.text()).toBe('globalThis.compat="current-deployment";')
    expect(runtimeResponse?.headers.get('cache-control')).toBe('no-store')
    expect(runtimeResponse?.headers.get('etag')).toBeNull()

    const indexResponse = await handleRemoteTheme(
      new Request(`${base}/index.html`),
      env,
      { fetcher, now: () => 1_000_150 },
    )
    const html = await indexResponse!.text()
    const pinnedBase = 'https://adapter.example/themes/github/test-owner/test-theme/releases/30/v2'
    expect(html).toContain(`${pinnedBase}/assets/app.js`)
    expect(html).toContain(`${pinnedBase}/images/logo.png`)
    expect(html).toContain('https://adapter.example/nodeget-logo.png')
    expect(html).toContain('<title>NodeGet Monitor</title>')
    expect(html).toContain('./komari-nodeget-runtime.js')
    expect(html).toContain('./custom.css')
    expect(html).toContain('./custom.js')

    const assetResponse = await handleRemoteTheme(
      new Request(`${pinnedBase}/assets/app.js`),
      env,
      { fetcher, now: () => 1_000_200 },
    )
    expect(await assetResponse!.text()).toBe(`globalThis.remoteFixture="2.0.0";globalThis.brand="NodeGet Monitor";globalThis.favicon="https://adapter.example/nodeget-logo.png";globalThis.logo="${pinnedBase}/images/logo.png";globalThis.preload="${pinnedBase}/assets/lazy.css"`)
    expect(assetResponse?.headers.get('content-type')).toContain('text/javascript')
    expect(assetResponse?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const cachedAssetResponse = await handleRemoteTheme(
      new Request(`${pinnedBase}/assets/app.js`, {
        headers: { 'if-none-match': assetResponse!.headers.get('etag')! },
      }),
      env,
      { fetcher, now: () => 1_000_225 },
    )
    expect(cachedAssetResponse?.status).toBe(304)
    expect(cachedAssetResponse?.headers.get('content-length')).toBeNull()

    const imageResponse = await handleRemoteTheme(
      new Request(`${pinnedBase}/images/logo.png`),
      env,
      { fetcher, now: () => 1_000_250 },
    )
    expect(new Uint8Array(await imageResponse!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
    expect(imageResponse?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const configResponse = await handleRemoteTheme(
      new Request(`${base}/config.json`),
      env,
      { fetcher, now: () => 1_000_275 },
    )
    const config = await configResponse!.json() as { user_preferences: Record<string, unknown> }
    expect(config.user_preferences).toMatchObject({
      backgroundEnabled: true,
      backgroundType: 'image',
      lightBackgroundUrl: 'https://adapter.example/api/acg-background',
      darkBackgroundUrl: 'https://adapter.example/api/acg-background',
      site_name: 'NodeGet Remote Fixture',
      site_title: 'NodeGet Remote Fixture',
    })
    expect(calls).toEqual({ api: 1, asset: 1 })
    expect(bucket.puts).toBe(3)
    expect([...bucket.objects.keys()].some(key => key.endsWith('/theme.pack'))).toBe(true)
    expect([...bucket.objects.keys()].some(key => key.includes('/compat-v3/'))).toBe(true)
    const alias = JSON.parse(await new MemoryObject(bucket.objects.get('aliases/github/test-owner/test-theme/latest.json')!).text())
    expect(alias.schema).toBe(2)
  })

  it('rebuilds a cached release when the adapter conversion schema changes', async () => {
    const source = sourceTheme()
    const bucket = new MemoryBucket()
    await bucket.put('aliases/github/test-owner/test-theme/latest.json', JSON.stringify({
      schema: 1,
      checkedAt: 1_000_000,
      repository: 'test-owner/test-theme',
      release: { id: 20, tag: 'v2.0.0', publishedAt: '2026-08-25T12:00:00Z' },
      asset: {
        id: 30,
        name: 'komari-theme-build.zip',
        browser_download_url: 'https://github.com/test-owner/test-theme/releases/download/v2.0.0/komari-theme-build.zip',
        size: source.byteLength,
      },
      bundle: {
        packKey: 'bundles/github/test-owner/test-theme/30/theme.pack',
        indexKey: 'bundles/github/test-owner/test-theme/30/index.json',
      },
    }))
    bucket.puts = 0
    const { fetcher, calls } = fixtureFetch(source)
    const response = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/test-owner/test-theme/latest/nodeget-theme.json'),
      environment(bucket),
      { fetcher, now: () => 1_000_100 },
    )
    expect(response?.status).toBe(200)
    expect(calls).toEqual({ api: 1, asset: 1 })
    expect([...bucket.objects.keys()].some(key => key.includes('/compat-v3/theme.pack'))).toBe(true)
  })

  it('returns a stable NodeGet import address without starting a conversion', async () => {
    const bucket = new MemoryBucket()
    const { fetcher, calls } = fixtureFetch(sourceTheme())
    const base = 'https://adapter.example/themes/github/test-owner/test-theme/latest'
    const env = environment(bucket)
    env.NODEGET_DASHBOARD_URL = 'https://nodeget.example/custom/'
    const response = await handleRemoteTheme(new Request(base), env, { fetcher })
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({
      theme_url: base,
      nodeget_import_url: `https://nodeget.example/custom/#/dashboard/theme-management?add=${encodeURIComponent(base)}`,
      update_mode: 'manual-remote-update',
    })
    expect(calls).toEqual({ api: 0, asset: 0 })
    expect(bucket.puts).toBe(0)
  })

  it('falls back to public GitHub release pages when the API is rate limited', async () => {
    const source = sourceTheme('2.2.0')
    const bucket = new MemoryBucket()
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      calls.push(`${url.hostname}${url.pathname}`)
      if (url.hostname === 'api.github.com')
        return Response.json({ message: 'API rate limit exceeded' }, { status: 403 })
      if (url.pathname.endsWith('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/test-owner/test-theme/releases/tag/v2.2.0' },
        })
      }
      if (url.pathname.endsWith('/releases/expanded_assets/v2.2.0')) {
        return new Response(`
          <ul><li>
            <a href="/test-owner/test-theme/releases/download/v2.2.0/komari-theme-build-v2.2.0.zip">theme</a>
            <span>${Math.ceil(source.byteLength / 1024)} KB</span>
            <relative-time datetime="2026-08-26T07:00:00Z"></relative-time>
          </li></ul>
        `, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname.endsWith('/releases/download/v2.2.0/komari-theme-build-v2.2.0.zip')) {
        return new Response(source.slice(), {
          headers: { 'content-length': String(source.byteLength), 'content-type': 'application/zip' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const response = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/test-owner/test-theme/latest/nodeget-theme.json'),
      environment(bucket),
      { fetcher, now: () => 1_000_000 },
    )
    expect(response?.status).toBe(200)
    expect((await response!.json() as Record<string, unknown>).version).toBe('2.2.0')
    expect(calls).toEqual([
      'api.github.com/repos/test-owner/test-theme/releases/latest',
      'github.com/test-owner/test-theme/releases/latest',
      'github.com/test-owner/test-theme/releases/expanded_assets/v2.2.0',
      'github.com/test-owner/test-theme/releases/download/v2.2.0/komari-theme-build-v2.2.0.zip',
    ])
  })

  it('rejects disallowed repositories before fetching GitHub', async () => {
    const bucket = new MemoryBucket()
    const { fetcher, calls } = fixtureFetch(sourceTheme())
    const response = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/other/theme/latest/nodeget-theme.json'),
      environment(bucket),
      { fetcher },
    )
    expect(response?.status).toBe(403)
    expect(await response!.json()).toMatchObject({ code: 'repository_not_allowed' })
    expect(calls).toEqual({ api: 0, asset: 0 })
  })

  it('does not fetch GitHub for an uncached immutable release address', async () => {
    const bucket = new MemoryBucket()
    const { fetcher, calls } = fixtureFetch(sourceTheme())
    const response = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/test-owner/test-theme/releases/999/v2/assets/app.js'),
      environment(bucket),
      { fetcher, now: () => 1_000_000 },
    )
    expect(response?.status).toBe(404)
    expect(await response!.json()).toMatchObject({ code: 'release_not_cached' })
    expect(calls).toEqual({ api: 0, asset: 0 })
  })

  it('does not expose inherited object properties as theme files', async () => {
    const bucket = new MemoryBucket()
    const { fetcher } = fixtureFetch(sourceTheme())
    const response = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/test-owner/test-theme/latest/toString'),
      environment(bucket),
      { fetcher, now: () => 1_000_000 },
    )
    expect(response?.status).toBe(404)
    expect(await response!.json()).toMatchObject({ code: 'theme_file_not_found' })
  })

  it('does not publish an index or latest alias when the R2 pack write fails', async () => {
    const bucket = new MemoryBucket('/theme.pack')
    const { fetcher } = fixtureFetch(sourceTheme())
    const response = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/test-owner/test-theme/latest/nodeget-theme.json'),
      environment(bucket),
      { fetcher, now: () => 1_000_000 },
    )
    expect(response?.status).toBe(502)
    expect([...bucket.objects.keys()].some(key => key.endsWith('/index.json'))).toBe(false)
    expect([...bucket.objects.keys()].some(key => key.startsWith('aliases/'))).toBe(false)
  })

  it('switches the stable latest address to a new release after the check interval', async () => {
    const bucket = new MemoryBucket()
    const releases = [
      { id: 20, assetId: 30, tag: 'v2.0.0', source: sourceTheme('2.0.0') },
      { id: 21, assetId: 31, tag: 'v2.1.0', source: sourceTheme('2.1.0') },
    ]
    let releaseIndex = 0
    const calls = { api: 0, asset: 0 }
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const current = releases[releaseIndex]!
      if (url.hostname === 'api.github.com') {
        calls.api += 1
        return Response.json({
          id: current.id,
          tag_name: current.tag,
          published_at: '2026-08-25T12:00:00Z',
          assets: [{
            id: current.assetId,
            name: `komari-theme-build-${current.tag}.zip`,
            browser_download_url: `https://github.com/test-owner/test-theme/releases/download/${current.tag}/theme.zip`,
            size: current.source.byteLength,
          }],
        })
      }
      calls.asset += 1
      return new Response(current.source.slice(), {
        headers: { 'content-length': String(current.source.byteLength) },
      })
    }) as typeof fetch
    const base = 'https://adapter.example/themes/github/test-owner/test-theme/latest'

    const first = await handleRemoteTheme(
      new Request(`${base}/nodeget-theme.json`),
      environment(bucket),
      { fetcher, now: () => 1_000_000 },
    )
    expect((await first!.json() as Record<string, unknown>).version).toBe('2.0.0')
    const firstIndex = await handleRemoteTheme(
      new Request(`${base}/index.html`),
      environment(bucket),
      { fetcher, now: () => 1_000_100 },
    )
    expect(await firstIndex!.text()).toContain('/releases/30/v2/assets/app.js')

    releaseIndex = 1
    const updated = await handleRemoteTheme(
      new Request(`${base}/nodeget-theme.json`),
      environment(bucket),
      { fetcher, now: () => 1_301_000 },
    )
    const updatedManifest = await updated!.json() as Record<string, unknown>
    expect(updatedManifest.version).toBe('2.1.0')
    expect(updatedManifest.dist_page).toBe(base)
    expect(updated?.headers.get('x-komari-release')).toBe('v2.1.0')

    const updatedIndex = await handleRemoteTheme(
      new Request(`${base}/index.html`),
      environment(bucket),
      { fetcher, now: () => 1_301_100 },
    )
    expect(await updatedIndex!.text()).toContain('/releases/31/v2/assets/app.js')

    const oldAsset = await handleRemoteTheme(
      new Request('https://adapter.example/themes/github/test-owner/test-theme/releases/30/v2/assets/app.js'),
      environment(bucket),
      { fetcher, now: () => 1_301_200 },
    )
    expect(await oldAsset!.text()).toContain('remoteFixture="2.0.0"')
    expect(calls).toEqual({ api: 2, asset: 2 })
  })
})
