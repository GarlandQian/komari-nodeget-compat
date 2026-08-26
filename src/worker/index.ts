import type { RemoteThemeEnvironment } from './remote-theme'
import { allowedGitHubRepositories, handleRemoteTheme } from './remote-theme'

interface Environment extends RemoteThemeEnvironment {
  ACG_BACKGROUND_ENABLED?: string
}

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '')
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    },
  })
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url)
    const remoteTheme = await handleRemoteTheme(request, env)
    if (remoteTheme)
      return remoteTheme

    const repositories = allowedGitHubRepositories(env.ALLOWED_GITHUB_REPOSITORIES)
    if (request.method === 'GET' && url.pathname === '/api/config') {
      return json({
        acg_background_enabled: enabled(env.ACG_BACKGROUND_ENABLED),
        remote_theme_enabled: repositories.length > 0,
        remote_theme_repositories: repositories,
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({
        status: 'ok',
        version: '0.2.1',
        conversion: 'browser-local',
        remote_distribution: env.THEME_CACHE ? 'r2' : 'unavailable',
        remote_theme_repositories: repositories.length,
        token_storage: 'nodeget-theme-config',
        acg_background_enabled: enabled(env.ACG_BACKGROUND_ENABLED),
      })
    }
    if (url.pathname.startsWith('/api/'))
      return json({ status: 'error', message: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
}
