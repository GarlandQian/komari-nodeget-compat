const REQUIRED_THEME_FILES = [
  'nodeget-theme.json',
  'nodeget-theme-files.json',
  'index.html',
  'komari-nodeget-runtime.js',
  'komari-compat.json',
  'config.json',
] as const

interface PrewarmOptions {
  expectedBackgroundEnabled?: boolean
  fetcher?: typeof fetch
  log?: (message: string) => void
}

function deploymentBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('DEPLOYMENT_URL must be an HTTP(S) URL without credentials')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}

export function parseAllowedRepositories(value: string | undefined): string[] {
  const repositories = (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item && item.toLowerCase() !== 'none')
  if (repositories.includes('*'))
    return []

  for (const repository of repositories) {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository))
      throw new Error(`Invalid repository in ALLOWED_GITHUB_REPOSITORIES: ${repository}`)
  }
  return [...new Set(repositories)]
}

async function responseError(response: Response): Promise<string> {
  const text = (await response.text()).replace(/\s+/g, ' ').trim()
  return text.slice(0, 500) || `HTTP ${response.status}`
}

async function fetchRequired(fetcher: typeof fetch, url: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(url, {
        cache: 'no-store',
        headers: { accept: '*/*' },
        signal: AbortSignal.timeout(120_000),
      })
      if (response.ok)
        return response
      lastError = new Error(`${url} returned ${response.status}: ${await responseError(response)}`)
      if (response.status < 500 && response.status !== 429)
        break
    }
    catch (error) {
      lastError = error
    }
    if (attempt < 3)
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000))
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to fetch ${url}`)
}

async function jsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const value = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must contain a JSON object`)
  return value as Record<string, unknown>
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export async function prewarmThemes(
  deploymentUrl: string,
  allowedRepositories: string | undefined,
  options: PrewarmOptions = {},
): Promise<string[]> {
  const baseUrl = deploymentBaseUrl(deploymentUrl)
  const repositories = parseAllowedRepositories(allowedRepositories)
  const log = options.log ?? console.log
  const fetcher = options.fetcher ?? fetch

  if (!repositories.length) {
    log('No enumerable GitHub theme repositories configured; skipping prewarm')
    return []
  }

  for (const repository of repositories) {
    const [owner, repo] = repository.split('/') as [string, string]
    const themeBase = `${baseUrl}/themes/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/latest`
    const manifest = await jsonObject(
      await fetchRequired(fetcher, `${themeBase}/nodeget-theme.json`),
      `${repository} nodeget-theme.json`,
    )
    if (typeof manifest.short !== 'string' || typeof manifest.version !== 'string')
      throw new Error(`${repository} converted manifest is missing short or version`)
    if (manifest.dist_page !== themeBase)
      throw new Error(`${repository} converted manifest has an unexpected dist_page`)

    const fileListResponse = await fetchRequired(fetcher, `${themeBase}/nodeget-theme-files.json`)
    const fileList = await fileListResponse.json()
    if (!Array.isArray(fileList) || fileList.some(item => typeof item !== 'string'))
      throw new Error(`${repository} nodeget-theme-files.json must contain a string array`)
    for (const required of REQUIRED_THEME_FILES) {
      if (!fileList.includes(required))
        throw new Error(`${repository} converted file list is missing ${required}`)
    }
    const preview = typeof manifest.preview === 'string' ? manifest.preview.trim() : ''
    if (preview) {
      if (!fileList.includes(preview))
        throw new Error(`${repository} converted file list is missing preview ${preview}`)
      await fetchRequired(fetcher, `${themeBase}/${encodeURIComponent(preview)}`)
    }

    const indexHtml = await (await fetchRequired(fetcher, `${themeBase}/index.html`)).text()
    const immutableAsset = indexHtml.match(/https?:\/\/[^\s"'<>]+\/releases\/\d+\/v2\/[^\s"'<>]+/)?.[0]
    if (!indexHtml.includes('komari-nodeget-runtime.js') || !immutableAsset)
      throw new Error(`${repository} converted index.html is missing runtime or immutable release assets`)
    await fetchRequired(fetcher, immutableAsset)
    const runtime = await (await fetchRequired(fetcher, `${themeBase}/komari-nodeget-runtime.js`)).text()
    if (!runtime.trim())
      throw new Error(`${repository} compatibility runtime is empty`)
    const config = await jsonObject(
      await fetchRequired(fetcher, `${themeBase}/config.json`),
      `${repository} config.json`,
    )
    if (options.expectedBackgroundEnabled) {
      const preferences = objectValue(config.user_preferences)
      const expectedUrl = `${baseUrl}/api/acg-background`
      if (preferences.backgroundEnabled !== true
        || preferences.backgroundMediaType !== 'image'
        || preferences.lightBackgroundUrl !== expectedUrl
        || preferences.darkBackgroundUrl !== expectedUrl
        || preferences.backgroundImage !== expectedUrl
        || preferences.backgroundImageMobile !== expectedUrl) {
        throw new Error(`${repository} ACG background aliases were not injected into config.json`)
      }
    }
    log(`Prewarmed ${repository} (${String(manifest.short)} ${String(manifest.version)})`)
  }

  return repositories
}

async function main(): Promise<void> {
  const deploymentUrl = process.env.DEPLOYMENT_URL?.trim()
  if (!deploymentUrl)
    throw new Error('DEPLOYMENT_URL is required')
  await prewarmThemes(deploymentUrl, process.env.ALLOWED_GITHUB_REPOSITORIES, {
    expectedBackgroundEnabled: /^(?:1|true|yes|on)$/i.test(process.env.ACG_BACKGROUND_ENABLED?.trim() ?? ''),
  })
}

if (import.meta.main)
  await main()
