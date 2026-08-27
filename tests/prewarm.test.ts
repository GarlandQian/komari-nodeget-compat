import { describe, expect, it } from 'bun:test'
import { parseAllowedRepositories, prewarmThemes } from '../scripts/prewarm-themes'

describe('remote theme deployment prewarm', () => {
  it('normalizes repository variables and rejects invalid entries', () => {
    expect(parseAllowedRepositories(' owner/theme,owner/theme,other/theme ')).toEqual([
      'owner/theme',
      'other/theme',
    ])
    expect(parseAllowedRepositories('none')).toEqual([])
    expect(parseAllowedRepositories('*')).toEqual([])
    expect(() => parseAllowedRepositories('owner/theme/extra')).toThrow('Invalid repository')
  })

  it('validates every critical file after deployment', async () => {
    const base = 'https://worker.example/themes/github/owner/theme/latest'
    const requested: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      requested.push(url)
      if (url === `${base}/nodeget-theme.json`) {
        return Response.json({
          short: 'NG-Theme',
          version: '1.2.3',
          dist_page: base,
          preview: 'preview.png',
        })
      }
      if (url === `${base}/nodeget-theme-files.json`) {
        return Response.json([
          'nodeget-theme.json',
          'nodeget-theme-files.json',
          'index.html',
          'komari-nodeget-runtime.js',
          'komari-compat.json',
          'config.json',
          'preview.png',
        ])
      }
      if (url === `${base}/index.html`)
        return new Response('<script src="./komari-nodeget-runtime.js"></script><script src="https://worker.example/themes/github/owner/theme/releases/1/v2/app.js"></script>')
      if (url === 'https://worker.example/themes/github/owner/theme/releases/1/v2/app.js')
        return new Response('globalThis.theme = true')
      if (url === `${base}/komari-nodeget-runtime.js`)
        return new Response('globalThis.compat = true')
      if (url === `${base}/preview.png`)
        return new Response('preview')
      if (url === `${base}/config.json`) {
        return Response.json({
          site_tokens: [],
          user_preferences: {
            backgroundEnabled: true,
            backgroundMediaType: 'image',
            lightBackgroundUrl: 'https://worker.example/api/acg-background',
            darkBackgroundUrl: 'https://worker.example/api/acg-background',
            backgroundImage: 'https://worker.example/api/acg-background',
            backgroundImageMobile: 'https://worker.example/api/acg-background',
          },
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const logs: string[] = []

    const repositories = await prewarmThemes(
      'https://worker.example/',
      'owner/theme',
      { expectedBackgroundEnabled: true, fetcher, log: message => logs.push(message) },
    )
    expect(repositories).toEqual(['owner/theme'])
    expect(requested).toHaveLength(7)
    expect(requested).toContain(`${base}/preview.png`)
    expect(requested).toContain('https://worker.example/themes/github/owner/theme/releases/1/v2/app.js')
    expect(logs[0]).toContain('Prewarmed owner/theme')
  })
})
