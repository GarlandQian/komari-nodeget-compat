import type { ConversionMetadata } from '../converter/archive'
import { convertThemeEntries } from '../converter/archive'

export const REMOTE_THEME_INPUT_LIMIT = 32 * 1024 * 1024
export const REMOTE_THEME_EXPANDED_LIMIT = 72 * 1024 * 1024
export const REMOTE_THEME_FILE_LIMIT = 5_000

const DEFAULT_RELEASE_CHECK_TTL_SECONDS = 300
const MIN_RELEASE_CHECK_TTL_SECONDS = 60
const MAX_RELEASE_CHECK_TTL_SECONDS = 86_400
const ROUTE_PREFIX = '/themes/github/'

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>
}

export interface R2ObjectBody {
  readonly body: ReadableStream<Uint8Array>
  readonly etag: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export interface ThemeCacheBucket {
  get(
    key: string,
    options?: { range?: { offset: number, length: number } },
  ): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    },
  ): Promise<unknown>
}

export interface RemoteThemeEnvironment {
  ASSETS: AssetFetcher
  THEME_CACHE?: ThemeCacheBucket
  ALLOWED_GITHUB_REPOSITORIES?: string
  RELEASE_CHECK_TTL_SECONDS?: string
  GITHUB_API_TOKEN?: string
}

interface RemoteThemeDependencies {
  fetcher?: typeof fetch
  now?: () => number
}

interface RemoteThemeRoute {
  owner: string
  repo: string
  repository: string
  filePath: string
  basePath: string
}

interface GitHubAsset {
  id: number
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  id: number
  tag_name: string
  published_at: string
  assets: GitHubAsset[]
}

interface BundleAlias {
  schema: 1
  checkedAt: number
  repository: string
  release: {
    id: number
    tag: string
    publishedAt: string
  }
  asset: GitHubAsset
  bundle: {
    packKey: string
    indexKey: string
  }
}

interface PackedFile {
  offset: number
  length: number
  contentType: string
}

interface BundleIndex {
  schema: 1
  repository: string
  release: BundleAlias['release']
  asset: GitHubAsset
  metadata: ConversionMetadata
  totalBytes: number
  files: Record<string, PackedFile>
}

interface ThemePack {
  body: Blob
  totalBytes: number
  files: Record<string, PackedFile>
}

class RemoteThemeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const aliasMemory = new Map<string, BundleAlias>()
const indexMemory = new Map<string, BundleIndex>()
const activeBuilds = new Map<string, Promise<BundleAlias>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonHeaders(): Headers {
  return new Headers({
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  })
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: jsonHeaders() })
}

function errorResponse(error: unknown): Response {
  if (error instanceof RemoteThemeError) {
    return jsonResponse({
      status: 'error',
      code: error.code,
      message: error.message,
    }, error.status)
  }
  return jsonResponse({
    status: 'error',
    code: 'remote_theme_failed',
    message: error instanceof Error ? error.message : String(error),
  }, 502)
}

function decodedSegment(value: string | undefined, label: string): string {
  if (!value)
    throw new RemoteThemeError(404, 'invalid_theme_route', `Missing GitHub ${label}`)
  try {
    return decodeURIComponent(value)
  }
  catch {
    throw new RemoteThemeError(400, 'invalid_theme_route', `Invalid GitHub ${label}`)
  }
}

function validRepositoryPart(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..'
}

export function parseRemoteThemeRoute(pathname: string): RemoteThemeRoute | null {
  if (!pathname.startsWith(ROUTE_PREFIX))
    return null
  const segments = pathname.split('/')
  if (segments[1] !== 'themes' || segments[2] !== 'github' || segments[5] !== 'latest')
    throw new RemoteThemeError(404, 'invalid_theme_route', 'Remote theme route must end with /latest')

  const owner = decodedSegment(segments[3], 'owner')
  const repo = decodedSegment(segments[4], 'repository')
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo))
    throw new RemoteThemeError(400, 'invalid_repository', 'GitHub owner or repository name is invalid')

  const fileSegments = segments.slice(6).map((segment) => {
    const decoded = decodedSegment(segment, 'file path')
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0'))
      throw new RemoteThemeError(400, 'invalid_file_path', 'Remote theme file path is invalid')
    return decoded
  })
  const filePath = fileSegments.join('/')
  const basePath = `${ROUTE_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/latest`
  return {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    filePath,
    basePath,
  }
}

export function allowedGitHubRepositories(value: string | undefined): string[] {
  return [...new Set((value ?? '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(item => item && item.toLowerCase() !== 'none'))]
}

function repositoryAllowed(repository: string, configured: string | undefined): boolean {
  const allowed = allowedGitHubRepositories(configured).map(item => item.toLowerCase())
  return allowed.includes('*') || allowed.includes(repository.toLowerCase())
}

function releaseCheckTtl(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed))
    return DEFAULT_RELEASE_CHECK_TTL_SECONDS
  return Math.min(MAX_RELEASE_CHECK_TTL_SECONDS, Math.max(MIN_RELEASE_CHECK_TTL_SECONDS, parsed))
}

function aliasKey(route: RemoteThemeRoute): string {
  return `aliases/github/${route.owner.toLowerCase()}/${route.repo.toLowerCase()}/latest.json`
}

function bundleKeys(route: RemoteThemeRoute, assetId: number): BundleAlias['bundle'] {
  const prefix = `bundles/github/${route.owner.toLowerCase()}/${route.repo.toLowerCase()}/${assetId}`
  return {
    packKey: `${prefix}/theme.pack`,
    indexKey: `${prefix}/index.json`,
  }
}

function validGitHubAsset(value: unknown): value is GitHubAsset {
  if (!isRecord(value))
    return false
  return Number.isSafeInteger(value.id)
    && typeof value.name === 'string'
    && typeof value.browser_download_url === 'string'
    && Number.isSafeInteger(value.size)
}

function validAlias(value: unknown): value is BundleAlias {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.release) || !isRecord(value.bundle))
    return false
  return typeof value.checkedAt === 'number'
    && typeof value.repository === 'string'
    && Number.isSafeInteger(value.release.id)
    && typeof value.release.tag === 'string'
    && typeof value.release.publishedAt === 'string'
    && validGitHubAsset(value.asset)
    && typeof value.bundle.packKey === 'string'
    && typeof value.bundle.indexKey === 'string'
}

function validBundleIndex(value: unknown): value is BundleIndex {
  if (!isRecord(value)
    || value.schema !== 1
    || typeof value.repository !== 'string'
    || !isRecord(value.release)
    || !validGitHubAsset(value.asset)
    || !isRecord(value.metadata)
    || typeof value.totalBytes !== 'number'
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 0
    || !isRecord(value.files)) {
    return false
  }
  const totalBytes = value.totalBytes
  return Object.entries(value.files).every(([path, file]) => {
    if (!path || !isRecord(file))
      return false
    const offset = file.offset
    const length = file.length
    return typeof offset === 'number'
      && typeof length === 'number'
      && Number.isSafeInteger(offset)
      && Number.isSafeInteger(length)
      && offset >= 0
      && length >= 0
      && offset + length <= totalBytes
      && typeof file.contentType === 'string'
  })
}

async function readAlias(bucket: ThemeCacheBucket, key: string): Promise<BundleAlias | null> {
  const memory = aliasMemory.get(key)
  if (memory)
    return memory
  const object = await bucket.get(key)
  if (!object)
    return null
  try {
    const parsed: unknown = JSON.parse(await object.text())
    if (!validAlias(parsed))
      return null
    aliasMemory.set(key, parsed)
    return parsed
  }
  catch {
    return null
  }
}

async function writeAlias(bucket: ThemeCacheBucket, key: string, alias: BundleAlias): Promise<void> {
  await bucket.put(key, JSON.stringify(alias), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
  aliasMemory.set(key, alias)
}

function selectReleaseAsset(release: GitHubRelease): GitHubAsset {
  const candidates = release.assets.filter(asset => asset.name.toLowerCase().endsWith('.zip'))
  if (candidates.length === 0)
    throw new RemoteThemeError(422, 'release_zip_missing', 'Latest GitHub release has no uploaded ZIP asset')
  if (candidates.length === 1)
    return candidates[0]!

  const scored = candidates.map((asset) => {
    const normalized = asset.name.toLowerCase()
    const score = (normalized.includes('komari') ? 8 : 0)
      + (normalized.includes('theme') ? 4 : 0)
      + (normalized.includes('build') ? 2 : 0)
    return { asset, score }
  }).sort((left, right) => right.score - left.score || left.asset.name.localeCompare(right.asset.name))

  if (scored[0]?.score === scored[1]?.score) {
    throw new RemoteThemeError(
      409,
      'release_zip_ambiguous',
      `Latest release contains multiple ZIP assets: ${candidates.map(asset => asset.name).join(', ')}`,
    )
  }
  return scored[0]!.asset
}

async function fetchLatestRelease(
  route: RemoteThemeRoute,
  env: RemoteThemeEnvironment,
  fetcher: typeof fetch,
): Promise<{ release: GitHubRelease, asset: GitHubAsset }> {
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': 'komari-nodeget-theme-adapter',
    'x-github-api-version': '2022-11-28',
  })
  if (env.GITHUB_API_TOKEN)
    headers.set('authorization', `Bearer ${env.GITHUB_API_TOKEN}`)

  const response = await fetcher(`https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/releases/latest`, {
    headers,
  })
  if (!response.ok) {
    const code = response.status === 404 ? 'github_release_not_found' : 'github_release_failed'
    throw new RemoteThemeError(response.status === 404 ? 404 : 502, code, `GitHub latest release request failed with HTTP ${response.status}`)
  }
  const value: unknown = await response.json()
  if (!isRecord(value)
    || !Number.isSafeInteger(value.id)
    || typeof value.tag_name !== 'string'
    || typeof value.published_at !== 'string'
    || !Array.isArray(value.assets)) {
    throw new RemoteThemeError(502, 'github_release_invalid', 'GitHub latest release response is invalid')
  }
  const release: GitHubRelease = {
    id: value.id as number,
    tag_name: value.tag_name,
    published_at: value.published_at,
    assets: value.assets.filter(validGitHubAsset),
  }
  const asset = selectReleaseAsset(release)
  if (asset.size <= 0 || asset.size > REMOTE_THEME_INPUT_LIMIT) {
    throw new RemoteThemeError(
      413,
      'release_zip_too_large',
      `Release ZIP must be between 1 byte and ${REMOTE_THEME_INPUT_LIMIT / 1024 / 1024} MiB`,
    )
  }
  const downloadUrl = new URL(asset.browser_download_url)
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com')
    throw new RemoteThemeError(502, 'github_asset_url_invalid', 'GitHub release asset URL is invalid')
  return { release, asset }
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }
  return types[extension] ?? 'application/octet-stream'
}

export function createThemePack(entries: Record<string, Uint8Array>): ThemePack {
  const files = Object.create(null) as Record<string, PackedFile>
  const parts: BlobPart[] = []
  let offset = 0
  for (const path of Object.keys(entries).sort()) {
    const bytes = entries[path]!
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    files[path] = {
      offset,
      length: bytes.byteLength,
      contentType: contentType(path),
    }
    parts.push(body)
    offset += bytes.byteLength
  }
  return { body: new Blob(parts), totalBytes: offset, files }
}

async function readBundleIndex(bucket: ThemeCacheBucket, key: string): Promise<BundleIndex | null> {
  const memory = indexMemory.get(key)
  if (memory)
    return memory
  const object = await bucket.get(key)
  if (!object)
    return null
  try {
    const parsed: unknown = JSON.parse(await object.text())
    if (!validBundleIndex(parsed))
      return null
    indexMemory.set(key, parsed)
    return parsed
  }
  catch {
    return null
  }
}

async function downloadReleaseZip(asset: GitHubAsset, fetcher: typeof fetch): Promise<Uint8Array> {
  const response = await fetcher(asset.browser_download_url, {
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'komari-nodeget-theme-adapter',
    },
    redirect: 'follow',
  })
  if (!response.ok)
    throw new RemoteThemeError(502, 'release_zip_download_failed', `Release ZIP download failed with HTTP ${response.status}`)
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > REMOTE_THEME_INPUT_LIMIT)
    throw new RemoteThemeError(413, 'release_zip_too_large', 'Release ZIP exceeds the remote conversion size limit')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > REMOTE_THEME_INPUT_LIMIT)
    throw new RemoteThemeError(413, 'release_zip_too_large', 'Release ZIP exceeds the remote conversion size limit')
  return bytes
}

async function buildBundle(
  route: RemoteThemeRoute,
  env: RemoteThemeEnvironment,
  release: GitHubRelease,
  asset: GitHubAsset,
  fetcher: typeof fetch,
  now: number,
  requestOrigin: string,
): Promise<BundleAlias> {
  const bucket = env.THEME_CACHE
  if (!bucket)
    throw new RemoteThemeError(503, 'theme_cache_unavailable', 'R2 theme cache binding is not configured')
  const key = aliasKey(route)
  const bundle = bundleKeys(route, asset.id)
  const releaseMeta = {
    id: release.id,
    tag: release.tag_name,
    publishedAt: release.published_at,
  }
  const alias: BundleAlias = {
    schema: 1,
    checkedAt: now,
    repository: route.repository,
    release: releaseMeta,
    asset,
    bundle,
  }

  const existing = await readBundleIndex(bucket, bundle.indexKey)
  if (existing) {
    await writeAlias(bucket, key, alias)
    return alias
  }

  const [source, runtimeResponse] = await Promise.all([
    downloadReleaseZip(asset, fetcher),
    env.ASSETS.fetch(new Request(new URL('/komari-nodeget-runtime.js', requestOrigin))),
  ])
  if (!runtimeResponse.ok)
    throw new RemoteThemeError(500, 'runtime_unavailable', `Compatibility runtime is unavailable (HTTP ${runtimeResponse.status})`)
  const runtime = new Uint8Array(await runtimeResponse.arrayBuffer())
  const converted = convertThemeEntries(source, {
    runtime,
    scanSourceWarnings: false,
    limits: {
      maxInputBytes: REMOTE_THEME_INPUT_LIMIT,
      maxUncompressedBytes: REMOTE_THEME_EXPANDED_LIMIT,
      maxFiles: REMOTE_THEME_FILE_LIMIT,
    },
  })
  const { entries, ...metadata } = converted
  const pack = createThemePack(entries)
  if (pack.totalBytes > REMOTE_THEME_EXPANDED_LIMIT)
    throw new RemoteThemeError(413, 'converted_theme_too_large', 'Converted theme exceeds the remote cache size limit')

  const index: BundleIndex = {
    schema: 1,
    repository: route.repository,
    release: releaseMeta,
    asset,
    metadata,
    totalBytes: pack.totalBytes,
    files: pack.files,
  }
  await bucket.put(bundle.packKey, pack.body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      repository: route.repository,
      release: release.tag_name,
      asset_id: String(asset.id),
    },
  })
  await bucket.put(bundle.indexKey, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
  indexMemory.set(bundle.indexKey, index)
  await writeAlias(bucket, key, alias)
  return alias
}

async function resolveBundle(
  route: RemoteThemeRoute,
  env: RemoteThemeEnvironment,
  dependencies: Required<RemoteThemeDependencies>,
  requestOrigin: string,
): Promise<BundleAlias> {
  const bucket = env.THEME_CACHE
  if (!bucket)
    throw new RemoteThemeError(503, 'theme_cache_unavailable', 'R2 theme cache binding is not configured')

  const key = aliasKey(route)
  const now = dependencies.now()
  const cached = await readAlias(bucket, key)
  if (cached && now - cached.checkedAt < releaseCheckTtl(env.RELEASE_CHECK_TTL_SECONDS) * 1000)
    return cached

  let latest: { release: GitHubRelease, asset: GitHubAsset }
  try {
    latest = await fetchLatestRelease(route, env, dependencies.fetcher)
  }
  catch (error) {
    if (cached)
      return cached
    throw error
  }

  if (cached?.asset.id === latest.asset.id) {
    const refreshed: BundleAlias = {
      ...cached,
      checkedAt: now,
      release: {
        id: latest.release.id,
        tag: latest.release.tag_name,
        publishedAt: latest.release.published_at,
      },
      asset: latest.asset,
    }
    await writeAlias(bucket, key, refreshed)
    return refreshed
  }

  const buildKey = `${route.repository.toLowerCase()}:${latest.asset.id}`
  const active = activeBuilds.get(buildKey)
  if (active)
    return active

  const build = buildBundle(
    route,
    env,
    latest.release,
    latest.asset,
    dependencies.fetcher,
    now,
    requestOrigin,
  ).finally(() => {
    if (activeBuilds.get(buildKey) === build)
      activeBuilds.delete(buildKey)
  })
  activeBuilds.set(buildKey, build)
  return build
}

function fileHeaders(route: RemoteThemeRoute, alias: BundleAlias, file: PackedFile): Headers {
  return new Headers({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Length, ETag, X-Komari-Release',
    'cache-control': 'no-cache',
    'content-length': String(file.length),
    'content-type': file.contentType,
    etag: `"${alias.asset.id}-${file.offset}-${file.length}"`,
    'last-modified': new Date(alias.release.publishedAt).toUTCString(),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-komari-release': alias.release.tag,
    'x-remote-theme': route.repository,
  })
}

async function servePackedFile(
  request: Request,
  route: RemoteThemeRoute,
  env: RemoteThemeEnvironment,
  alias: BundleAlias,
  index: BundleIndex,
): Promise<Response> {
  const file = Object.hasOwn(index.files, route.filePath)
    ? index.files[route.filePath]
    : undefined
  if (!file)
    throw new RemoteThemeError(404, 'theme_file_not_found', `Theme file not found: ${route.filePath}`)

  const headers = fileHeaders(route, alias, file)
  const bucket = env.THEME_CACHE!
  if (route.filePath === 'nodeget-theme.json') {
    const object = await bucket.get(alias.bundle.packKey, {
      range: { offset: file.offset, length: file.length },
    })
    if (!object)
      throw new RemoteThemeError(503, 'theme_cache_incomplete', 'Cached theme data is missing')
    const value: unknown = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()))
    if (!isRecord(value))
      throw new RemoteThemeError(502, 'theme_manifest_invalid', 'Converted NodeGet theme manifest is invalid')
    value.dist_page = `${new URL(request.url).origin}${route.basePath}`
    const body = `${JSON.stringify(value, null, 2)}\n`
    headers.set('content-length', String(new TextEncoder().encode(body).byteLength))
    headers.set('cache-control', 'no-store')
    headers.delete('etag')
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
  }

  if (request.headers.get('if-none-match') === headers.get('etag'))
    return new Response(null, { status: 304, headers })
  if (request.method === 'HEAD')
    return new Response(null, { status: 200, headers })

  if (file.length === 0)
    return new Response(new Uint8Array(), { status: 200, headers })
  const object = await bucket.get(alias.bundle.packKey, {
    range: { offset: file.offset, length: file.length },
  })
  if (!object)
    throw new RemoteThemeError(503, 'theme_cache_incomplete', 'Cached theme data is missing')
  return new Response(object.body, { status: 200, headers })
}

export async function handleRemoteTheme(
  request: Request,
  env: RemoteThemeEnvironment,
  dependencies: RemoteThemeDependencies = {},
): Promise<Response | null> {
  let route: RemoteThemeRoute | null
  try {
    route = parseRemoteThemeRoute(new URL(request.url).pathname)
  }
  catch (error) {
    return errorResponse(error)
  }
  if (!route)
    return null

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-headers': 'Content-Type',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-origin': '*',
        'access-control-max-age': '86400',
      },
    })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return jsonResponse({ status: 'error', code: 'method_not_allowed', message: 'Method not allowed' }, 405)
  if (!repositoryAllowed(route.repository, env.ALLOWED_GITHUB_REPOSITORIES)) {
    return jsonResponse({
      status: 'error',
      code: 'repository_not_allowed',
      message: `GitHub repository is not enabled: ${route.repository}`,
    }, 403)
  }

  const url = new URL(request.url)
  const baseUrl = `${url.origin}${route.basePath}`
  if (!route.filePath) {
    return jsonResponse({
      status: 'ok',
      repository: route.repository,
      channel: 'latest',
      theme_url: baseUrl,
      nodeget_import_url: `https://dash.nodeget.com/#/dashboard/theme-management?add=${encodeURIComponent(baseUrl)}`,
      update_mode: 'manual-remote-update',
    })
  }

  const resolvedDependencies: Required<RemoteThemeDependencies> = {
    fetcher: dependencies.fetcher ?? fetch,
    now: dependencies.now ?? Date.now,
  }
  try {
    const alias = await resolveBundle(route, env, resolvedDependencies, url.origin)
    const index = await readBundleIndex(env.THEME_CACHE!, alias.bundle.indexKey)
    if (!index)
      throw new RemoteThemeError(503, 'theme_cache_incomplete', 'Cached theme index is missing')
    return await servePackedFile(request, route, env, alias, index)
  }
  catch (error) {
    return errorResponse(error)
  }
}

export function resetRemoteThemeMemoryForTests(): void {
  aliasMemory.clear()
  indexMemory.clear()
  activeBuilds.clear()
}
