import { describe, expect, it } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { convertThemeArchive, convertThemeEntries } from '../src/converter/archive'

function sourceTheme(): Uint8Array {
  return zipSync({
    'komari-theme.json': strToU8(JSON.stringify({
      name: 'Fixture',
      short: 'Fixture',
      version: '1.0.0',
      preview: 'preview.png',
      configuration: { type: 'managed', data: [] },
    })),
    'preview.png': new Uint8Array([1, 2, 3]),
    'dist/assets/': new Uint8Array(),
    'dist/index.html': strToU8('<!doctype html><html><head><title>Komari Monitor</title><link rel="icon" href="/favicon.ico"><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>'),
    'dist/assets/app.js': strToU8('const brand="Komari Monitor",technical=KomariRpc;fetch("/api/public")'),
  })
}

describe('theme archive conversion', () => {
  it('creates a NodeGet package and injects runtime before the theme entry', () => {
    const result = convertThemeArchive(sourceTheme(), { runtime: strToU8('globalThis.compat=true;') })
    const files = unzipSync(result.archive)
    expect(files['komari-theme.json']).toBeUndefined()
    expect(files['nodeget-theme.json']).toBeDefined()
    expect(files['komari-compat.json']).toBeDefined()
    expect(files['config.json']).toBeDefined()
    expect(files['assets/app.js']).toBeDefined()
    expect(files.assets).toBeUndefined()
    expect(files['komari-nodeget-runtime.js']).toBeDefined()

    const html = strFromU8(files['index.html']!)
    expect(html.indexOf('komari-nodeget-runtime.js')).toBeLessThan(html.indexOf('assets/app.js'))
    expect(html).toContain('./assets/app.js')
    expect(html).toContain('./custom.css')
    expect(html).toContain('./custom.js')
    expect(html).toContain('<title>NodeGet Monitor</title>')
    expect(html).toContain('href="./favicon.ico"')
    expect(strFromU8(files['assets/app.js']!)).toContain('brand="NodeGet Monitor",technical=KomariRpc')

    const fileManifest = JSON.parse(strFromU8(files['nodeget-theme-files.json']!)) as string[]
    expect(fileManifest).toContain('nodeget-theme-files.json')
    expect(fileManifest).toContain('index.html')
    expect(fileManifest).not.toContain('assets')
    expect(result.outputShort).toBe('NG-Fixture')
    expect(result.sourceName).toBe('Fixture')
    expect(result.sourceVersion).toBe('1.0.0')
    expect(result.inputFileCount).toBe(4)
    expect(result.outputFileCount).toBe(fileManifest.length)
  })

  it('rejects traversal paths and missing package contracts', () => {
    const unsafe = zipSync({ '../outside.txt': strToU8('bad') })
    expect(() => convertThemeArchive(unsafe, { runtime: strToU8('runtime') })).toThrow('Unsafe archive path')

    const missingManifest = zipSync({ 'dist/index.html': strToU8('<html></html>') })
    expect(() => convertThemeArchive(missingManifest, { runtime: strToU8('runtime') })).toThrow('komari-theme.json')
  })

  it('returns reusable converted entries for remote distribution', () => {
    const result = convertThemeEntries(sourceTheme(), {
      appearance: {
        backgroundUrl: 'https://adapter.example/api/acg-background',
        logoUrl: 'https://adapter.example/nodeget-logo.png',
      },
      runtime: strToU8('runtime'),
      distPage: 'https://adapter.example/themes/github/test/theme/latest',
      limits: { maxFiles: 20 },
    })
    expect(result.entries['index.html']).toBeDefined()
    expect(result.entries['nodeget-theme-files.json']).toBeDefined()
    const manifest = JSON.parse(strFromU8(result.entries['nodeget-theme.json']!)) as Record<string, unknown>
    const config = JSON.parse(strFromU8(result.entries['config.json']!)) as { user_preferences: Record<string, unknown> }
    expect(manifest.dist_page).toBe('https://adapter.example/themes/github/test/theme/latest')
    expect(strFromU8(result.entries['index.html']!)).toContain('https://adapter.example/nodeget-logo.png')
    expect(config.user_preferences).toMatchObject({
      backgroundEnabled: true,
      lightBackgroundUrl: 'https://adapter.example/api/acg-background',
      darkBackgroundUrl: 'https://adapter.example/api/acg-background',
    })
    expect(result.outputFileCount).toBe(Object.keys(result.entries).length)
  })
})
