import type { ConversionMetadata } from '../converter/archive'
import type { DefaultTreeAdapterMap } from 'parse5'
import { parseFragment } from 'parse5'
import { convertThemeEntries } from '../converter/archive'
import type { ThemeAppearance } from '../converter/appearance'
import {
  applyThemeAppearanceToConfig,
  applyThemeAppearanceToManifest,
  rewriteThemeAppearanceText,
} from '../converter/appearance'
import { rewriteRemoteTextAssetReferences, rewriteRemoteThemeAssets } from '../converter/html'
import { environmentFlagEnabled, isRecord } from '../shared/utils'
import {
  REMOTE_ASSET_VERSION,
  REMOTE_BUNDLE_SCHEMA,
  REMOTE_CONVERSION_VERSION,
} from '../version'

export const REMOTE_THEME_INPUT_LIMIT = 32 * 1024 * 1024
export const REMOTE_THEME_EXPANDED_LIMIT = 72 * 1024 * 1024
export const REMOTE_THEME_FILE_LIMIT = 5_000

const DEFAULT_RELEASE_CHECK_TTL_SECONDS = 300
const MIN_RELEASE_CHECK_TTL_SECONDS = 60
const MAX_RELEASE_CHECK_TTL_SECONDS = 86_400
const DEFAULT_NODEGET_DASHBOARD_URL = 'https://dash.nodeget.com'
const GITHUB_RELEASE_PAGE_LIMIT = 1024 * 1024
const ROUTE_PREFIX = '/themes/github/'
const REMOTE_INSTALL_FILES = [
  'nodeget-theme.json',
  'nodeget-theme-files.json',
  'index.html',
  'komari-nodeget-runtime.js',
  'komari-compat.json',
  'config.json',
  'custom.css',
  'custom.js',
]
const REMOTE_TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.svg',
  '.webmanifest',
  '.xml',
])

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
  ACG_BACKGROUND_ENABLED?: string
  ASSETS: AssetFetcher
  THEME_CACHE?: ThemeCacheBucket
  ALLOWED_GITHUB_REPOSITORIES?: string
  RELEASE_CHECK_TTL_SECONDS?: string
  GITHUB_API_TOKEN?: string
  NODEGET_DASHBOARD_URL?: string
}

export function nodeGetDashboardUrl(value: string | undefined): string {
  try {
    const url = new URL(value?.trim() || DEFAULT_NODEGET_DASHBOARD_URL)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      return DEFAULT_NODEGET_DASHBOARD_URL
    url.hash = ''
    url.search = ''
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${pathname === '/' ? '' : pathname}`
  }
  catch {
    return DEFAULT_NODEGET_DASHBOARD_URL
  }
}

function nodeGetImportUrl(themeUrl: string, configuredDashboard: string | undefined): string {
  return `${nodeGetDashboardUrl(configuredDashboard)}/#/dashboard/theme-management?add=${encodeURIComponent(themeUrl)}`
}

function themeAppearance(request: Request, env: RemoteThemeEnvironment): ThemeAppearance {
  const origin = new URL(request.url).origin
  return {
    logoUrl: `${origin}/nodeget-logo.png`,
    ...(environmentFlagEnabled(env.ACG_BACKGROUND_ENABLED)
      ? { backgroundUrl: `${origin}/api/acg-background` }
      : {}),
  }
}

interface RemoteThemeDependencies {
  fetcher?: typeof fetch
  now?: () => number
}

interface RemoteThemeRouteBase {
  owner: string
  repo: string
  repository: string
  filePath: string
  basePath: string
}

type RemoteThemeRoute = RemoteThemeRouteBase & (
  | { channel: 'latest' }
  | { channel: 'release', assetId: number, assetVersion: typeof REMOTE_ASSET_VERSION }
)

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

type HtmlNode = DefaultTreeAdapterMap['node']
type HtmlElement = DefaultTreeAdapterMap['element']
type HtmlParentNode = DefaultTreeAdapterMap['parentNode']

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && 'attrs' in node
}

function isHtmlParent(node: HtmlNode): node is HtmlParentNode {
  return 'childNodes' in node
}

function htmlAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find(attribute => attribute.name === name)?.value
}

function htmlText(node: HtmlNode): string {
  if ('value' in node && typeof node.value === 'string')
    return node.value
  if (!isHtmlParent(node))
    return ''
  return node.childNodes.map(htmlText).join(' ')
}

function descendantAttribute(node: HtmlNode, tagName: string, attributeName: string): string | undefined {
  if (isHtmlElement(node) && node.tagName === tagName) {
    const value = htmlAttribute(node, attributeName)
    if (value)
      return value
  }
  if (!isHtmlParent(node))
    return undefined
  for (const child of node.childNodes) {
    const value = descendantAttribute(child, tagName, attributeName)
    if (value)
      return value
  }
  return undefined
}

interface BundleAlias {
  schema: typeof REMOTE_BUNDLE_SCHEMA
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
  schema: typeof REMOTE_BUNDLE_SCHEMA
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
  if (segments[1] !== 'themes' || segments[2] !== 'github')
    throw new RemoteThemeError(404, 'invalid_theme_route', 'Remote theme route is invalid')

  const owner = decodedSegment(segments[3], 'owner')
  const repo = decodedSegment(segments[4], 'repository')
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo))
    throw new RemoteThemeError(400, 'invalid_repository', 'GitHub owner or repository name is invalid')

  let channel: RemoteThemeRoute['channel']
  let assetId: number | undefined
  let fileStart: number
  if (segments[5] === 'latest') {
    channel = 'latest'
    fileStart = 6
  }
  else if (segments[5] === 'releases') {
    const asset = decodedSegment(segments[6], 'release asset ID')
    if (!/^\d+$/.test(asset) || !Number.isSafeInteger(Number(asset)) || Number(asset) <= 0)
      throw new RemoteThemeError(400, 'invalid_release_asset', 'GitHub release asset ID is invalid')
    if (segments[7] !== REMOTE_ASSET_VERSION)
      throw new RemoteThemeError(404, 'unsupported_asset_version', 'Remote theme asset protocol version is unsupported')
    channel = 'release'
    assetId = Number(asset)
    fileStart = 8
  }
  else {
    throw new RemoteThemeError(404, 'invalid_theme_route', 'Remote theme route must contain /latest or /releases/<asset-id>')
  }

  const fileSegments = segments.slice(fileStart).map((segment) => {
    const decoded = decodedSegment(segment, 'file path')
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0'))
      throw new RemoteThemeError(400, 'invalid_file_path', 'Remote theme file path is invalid')
    return decoded
  })
  const filePath = fileSegments.join('/')
  const repositoryPath = `${ROUTE_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const basePath = channel === 'latest'
    ? `${repositoryPath}/latest`
    : `${repositoryPath}/releases/${assetId}/${REMOTE_ASSET_VERSION}`
  const base = {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    filePath,
    basePath,
  }
  return channel === 'latest'
    ? { ...base, channel }
    : { ...base, channel, assetId: assetId!, assetVersion: REMOTE_ASSET_VERSION }
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
  const prefix = `bundles/github/${route.owner.toLowerCase()}/${route.repo.toLowerCase()}/${assetId}/${REMOTE_CONVERSION_VERSION}`
  return {
    packKey: `${prefix}/theme.pack`,
    indexKey: `${prefix}/index.json`,
  }
}

function releaseBasePath(route: RemoteThemeRoute, assetId: number): string {
  return `${ROUTE_PREFIX}${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/releases/${assetId}/${REMOTE_ASSET_VERSION}`
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
  if (!isRecord(value) || value.schema !== REMOTE_BUNDLE_SCHEMA || !isRecord(value.release) || !isRecord(value.bundle))
    return false
  return typeof value.checkedAt === 'number'
    && typeof value.repository === 'string'
    && Number.isSafeInteger(value.release.id)
    && typeof value.release.tag === 'string'
    && typeof value.release.publishedAt === 'string'
    && validGitHubAsset(value.asset)
    && typeof value.bundle.packKey === 'string'
    && typeof value.bundle.indexKey === 'string'
    && value.bundle.packKey.includes(`/${REMOTE_CONVERSION_VERSION}/`)
    && value.bundle.indexKey.includes(`/${REMOTE_CONVERSION_VERSION}/`)
}

function validBundleIndex(value: unknown): value is BundleIndex {
  if (!isRecord(value)
    || value.schema !== REMOTE_BUNDLE_SCHEMA
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

function stableNumericId(value: string): number {
  let high = 0x811c9dc5
  let low = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    high = Math.imul(high ^ code, 0x01000193) >>> 0
    low = Math.imul(low ^ (code + index), 0x85ebca6b) >>> 0
  }
  return ((high & 0x1fffff) * 0x1_0000_0000 + low) || 1
}

function displayedAssetSize(text: string): number {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(bytes?|kib|mib|gib|kb|mb|gb)\b/i)
  if (!match)
    return 1
  const value = Number.parseFloat(match[1]!)
  const unit = match[2]!.toLowerCase()
  const powers: Record<string, number> = {
    byte: 1,
    bytes: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
  }
  const size = Math.ceil(value * (powers[unit] ?? 1))
  return Number.isSafeInteger(size) && size > 0 ? size : 1
}

function releaseAssetUrl(
  href: string,
  route: RemoteThemeRoute,
  releaseTag: string,
): { name: string, url: string } | null {
  try {
    const url = new URL(href, 'https://github.com')
    if (url.protocol !== 'https:' || url.hostname !== 'github.com')
      return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 6
      || decodeURIComponent(parts[0]!).toLowerCase() !== route.owner.toLowerCase()
      || decodeURIComponent(parts[1]!).toLowerCase() !== route.repo.toLowerCase()
      || parts[2] !== 'releases'
      || parts[3] !== 'download') {
      return null
    }
    const name = decodeURIComponent(parts.at(-1)!)
    const tag = decodeURIComponent(parts.slice(4, -1).join('/'))
    if (tag !== releaseTag || !name.toLowerCase().endsWith('.zip') || name.includes('/') || name.includes('\\'))
      return null
    url.hash = ''
    url.search = ''
    return { name, url: url.href }
  }
  catch {
    return null
  }
}

function releaseAssetsFromHtml(html: string, route: RemoteThemeRoute, releaseTag: string): GitHubAsset[] {
  const fragment = parseFragment(html)
  const assets: GitHubAsset[] = []

  function visit(node: HtmlNode, listItem?: HtmlElement): void {
    const currentItem = isHtmlElement(node) && node.tagName === 'li' ? node : listItem
    if (isHtmlElement(node) && node.tagName === 'a') {
      const href = htmlAttribute(node, 'href')
      const asset = href ? releaseAssetUrl(href, route, releaseTag) : null
      if (asset) {
        assets.push({
          id: stableNumericId(`asset:${asset.url}`),
          name: asset.name,
          browser_download_url: asset.url,
          size: displayedAssetSize(currentItem ? htmlText(currentItem) : htmlText(node)),
        })
      }
    }
    if (!isHtmlParent(node))
      return
    for (const child of node.childNodes)
      visit(child, currentItem)
  }

  visit(fragment)
  return assets
}

async function limitedGitHubHtml(response: Response): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > GITHUB_RELEASE_PAGE_LIMIT)
    throw new RemoteThemeError(502, 'github_release_page_too_large', 'GitHub release page exceeds the safety limit')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > GITHUB_RELEASE_PAGE_LIMIT)
    throw new RemoteThemeError(502, 'github_release_page_too_large', 'GitHub release page exceeds the safety limit')
  return new TextDecoder().decode(bytes)
}

function releaseTagFromLocation(location: string, route: RemoteThemeRoute): string | null {
  try {
    const url = new URL(location, 'https://github.com')
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || parts.length < 5
      || decodeURIComponent(parts[0]!).toLowerCase() !== route.owner.toLowerCase()
      || decodeURIComponent(parts[1]!).toLowerCase() !== route.repo.toLowerCase()
      || parts[2] !== 'releases'
      || parts[3] !== 'tag') {
      return null
    }
    const tag = decodeURIComponent(parts.slice(4).join('/'))
    return tag && tag.length <= 255 && !/[\u0000-\u001f]/.test(tag) ? tag : null
  }
  catch {
    return null
  }
}

async function fetchLatestReleaseFromPages(
  route: RemoteThemeRoute,
  fetcher: typeof fetch,
): Promise<GitHubRelease> {
  const headers = {
    accept: 'text/html',
    'user-agent': 'komari-nodeget-theme-adapter',
  }
  const latestResponse = await fetcher(`https://github.com/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/releases/latest`, {
    headers,
    redirect: 'manual',
  })
  if (latestResponse.status === 404)
    throw new RemoteThemeError(404, 'github_release_not_found', 'GitHub repository has no published release')
  const tag = releaseTagFromLocation(latestResponse.headers.get('location') ?? '', route)
  if (!tag)
    throw new RemoteThemeError(502, 'github_release_page_invalid', `GitHub latest release page returned HTTP ${latestResponse.status} without a valid release redirect`)

  const assetsResponse = await fetcher(`https://github.com/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/releases/expanded_assets/${encodeURIComponent(tag)}`, { headers })
  if (!assetsResponse.ok)
    throw new RemoteThemeError(502, 'github_release_assets_failed', `GitHub release assets request failed with HTTP ${assetsResponse.status}`)
  const html = await limitedGitHubHtml(assetsResponse)
  const assets = releaseAssetsFromHtml(html, route, tag)
  const parsed = parseFragment(html)
  const publishedCandidate = descendantAttribute(parsed, 'relative-time', 'datetime')
  const publishedAt = publishedCandidate && Number.isFinite(Date.parse(publishedCandidate))
    ? new Date(publishedCandidate).toISOString()
    : new Date(0).toISOString()
  return {
    id: stableNumericId(`release:${route.repository.toLowerCase()}:${tag}`),
    tag_name: tag,
    published_at: publishedAt,
    assets,
  }
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
  let release: GitHubRelease
  if (!response.ok) {
    if (response.status === 403 || response.status === 429 || response.status >= 500)
      release = await fetchLatestReleaseFromPages(route, fetcher)
    else {
      const code = response.status === 404 ? 'github_release_not_found' : 'github_release_failed'
      throw new RemoteThemeError(response.status === 404 ? 404 : 502, code, `GitHub latest release request failed with HTTP ${response.status}`)
    }
  }
  else {
    const value: unknown = await response.json()
    if (!isRecord(value)
      || !Number.isSafeInteger(value.id)
      || typeof value.tag_name !== 'string'
      || typeof value.published_at !== 'string'
      || !Array.isArray(value.assets)) {
      throw new RemoteThemeError(502, 'github_release_invalid', 'GitHub latest release response is invalid')
    }
    release = {
      id: value.id as number,
      tag_name: value.tag_name,
      published_at: value.published_at,
      assets: value.assets.filter(validGitHubAsset),
    }
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
  forceRebuild = false,
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
    schema: REMOTE_BUNDLE_SCHEMA,
    checkedAt: now,
    repository: route.repository,
    release: releaseMeta,
    asset,
    bundle,
  }

  if (!forceRebuild) {
    const existing = await readBundleIndex(bucket, bundle.indexKey)
    if (existing) {
      await writeAlias(bucket, key, alias)
      return alias
    }
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
    schema: REMOTE_BUNDLE_SCHEMA,
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
      conversion: REMOTE_CONVERSION_VERSION,
    },
  })
  await bucket.put(bundle.indexKey, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
  indexMemory.set(bundle.indexKey, index)
  await writeAlias(bucket, key, alias)
  return alias
}

async function runBundleBuild(
  route: RemoteThemeRoute,
  env: RemoteThemeEnvironment,
  release: GitHubRelease,
  asset: GitHubAsset,
  dependencies: Required<RemoteThemeDependencies>,
  now: number,
  requestOrigin: string,
  forceRebuild = false,
): Promise<BundleAlias> {
  const buildKey = `${REMOTE_CONVERSION_VERSION}:${route.repository.toLowerCase()}:${asset.id}`
  const active = activeBuilds.get(buildKey)
  if (active) {
    if (!forceRebuild)
      return active
    try {
      return await active
    }
    catch {
      // A forced repair gets its own attempt after an earlier build fails.
    }
  }

  if (forceRebuild)
    indexMemory.delete(bundleKeys(route, asset.id).indexKey)

  const build = buildBundle(
    route,
    env,
    release,
    asset,
    dependencies.fetcher,
    now,
    requestOrigin,
    forceRebuild,
  ).finally(() => {
    if (activeBuilds.get(buildKey) === build)
      activeBuilds.delete(buildKey)
  })
  activeBuilds.set(buildKey, build)
  return build
}

function releaseFromAlias(alias: BundleAlias): GitHubRelease {
  return {
    id: alias.release.id,
    tag_name: alias.release.tag,
    published_at: alias.release.publishedAt,
    assets: [alias.asset],
  }
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

  return runBundleBuild(
    route,
    env,
    latest.release,
    latest.asset,
    dependencies,
    now,
    requestOrigin,
  )
}

async function resolvePinnedBundle(
  route: RemoteThemeRoute & { channel: 'release' },
  env: RemoteThemeEnvironment,
  now: number,
): Promise<{ alias: BundleAlias, index: BundleIndex }> {
  const bucket = env.THEME_CACHE
  if (!bucket)
    throw new RemoteThemeError(503, 'theme_cache_unavailable', 'R2 theme cache binding is not configured')

  const bundle = bundleKeys(route, route.assetId)
  const index = await readBundleIndex(bucket, bundle.indexKey)
  if (!index
    || index.asset.id !== route.assetId
    || index.repository.toLowerCase() !== route.repository.toLowerCase()) {
    throw new RemoteThemeError(404, 'release_not_cached', 'Requested theme release is not available in the remote cache')
  }
  return {
    index,
    alias: {
      schema: REMOTE_BUNDLE_SCHEMA,
      checkedAt: now,
      repository: index.repository,
      release: index.release,
      asset: index.asset,
      bundle,
    },
  }
}

function fileHeaders(route: RemoteThemeRoute, alias: BundleAlias, file: PackedFile): Headers {
  return new Headers({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Length, ETag, X-Komari-Release',
    'cache-control': route.channel === 'release'
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'content-length': String(file.length),
    'content-type': file.contentType,
    etag: `"${alias.asset.id}-${REMOTE_CONVERSION_VERSION}-${file.offset}-${file.length}"`,
    'last-modified': new Date(alias.release.publishedAt).toUTCString(),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-komari-release': alias.release.tag,
    'x-remote-theme': route.repository,
  })
}

async function readPackedFileBytes(
  bucket: ThemeCacheBucket,
  alias: BundleAlias,
  file: PackedFile,
): Promise<Uint8Array> {
  if (file.length === 0)
    return new Uint8Array()
  const object = await bucket.get(alias.bundle.packKey, {
    range: { offset: file.offset, length: file.length },
  })
  if (!object)
    throw new RemoteThemeError(503, 'theme_cache_incomplete', 'Cached theme data is missing')
  return new Uint8Array(await object.arrayBuffer())
}

function textResponse(
  request: Request,
  headers: Headers,
  body: string,
  cacheMode: 'latest' | 'release',
): Response {
  headers.set('content-length', String(new TextEncoder().encode(body).byteLength))
  if (cacheMode === 'latest') {
    headers.set('cache-control', 'no-store')
    headers.delete('etag')
  }
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
}

async function readNodeGetManifest(
  bucket: ThemeCacheBucket,
  alias: BundleAlias,
  index: BundleIndex,
): Promise<Record<string, unknown>> {
  const file = Object.hasOwn(index.files, 'nodeget-theme.json')
    ? index.files['nodeget-theme.json']
    : undefined
  if (!file)
    throw new RemoteThemeError(502, 'theme_manifest_invalid', 'Converted NodeGet theme manifest is missing')
  const value: unknown = JSON.parse(new TextDecoder().decode(await readPackedFileBytes(bucket, alias, file)))
  if (!isRecord(value))
    throw new RemoteThemeError(502, 'theme_manifest_invalid', 'Converted NodeGet theme manifest is invalid')
  return value
}

async function remoteInstallFileList(
  bucket: ThemeCacheBucket,
  alias: BundleAlias,
  index: BundleIndex,
): Promise<string[]> {
  const manifest = await readNodeGetManifest(bucket, alias, index)
  const preview = typeof manifest.preview === 'string' ? manifest.preview : ''
  return [...new Set([...REMOTE_INSTALL_FILES, preview])]
    .filter(path => path && Object.hasOwn(index.files, path))
}

function remoteTextFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot >= 0 && REMOTE_TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

function notModifiedResponse(headers: Headers): Response {
  headers.delete('content-length')
  return new Response(null, { status: 304, headers })
}

async function serveLatestRuntime(
  request: Request,
  env: RemoteThemeEnvironment,
  headers: Headers,
): Promise<Response> {
  const runtimeResponse = await env.ASSETS.fetch(new Request(
    new URL('/komari-nodeget-runtime.js', request.url),
  ))
  if (!runtimeResponse.ok)
    throw new RemoteThemeError(500, 'runtime_unavailable', `Compatibility runtime is unavailable (HTTP ${runtimeResponse.status})`)

  const bytes = new Uint8Array(await runtimeResponse.arrayBuffer())
  headers.set('cache-control', 'no-store')
  headers.set('content-length', String(bytes.byteLength))
  headers.set('content-type', runtimeResponse.headers.get('content-type') ?? 'text/javascript; charset=utf-8')
  headers.delete('etag')
  headers.delete('last-modified')
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers })
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
  if (route.channel === 'latest' && route.filePath === 'komari-nodeget-runtime.js')
    return serveLatestRuntime(request, env, headers)

  if (route.channel === 'latest' && route.filePath === 'nodeget-theme.json') {
    const value = applyThemeAppearanceToManifest(
      await readNodeGetManifest(bucket, alias, index),
      themeAppearance(request, env),
    )
    value.dist_page = `${new URL(request.url).origin}${route.basePath}`
    const body = `${JSON.stringify(value, null, 2)}\n`
    return textResponse(request, headers, body, 'latest')
  }

  if (route.channel === 'latest' && route.filePath === 'nodeget-theme-files.json') {
    const body = `${JSON.stringify(await remoteInstallFileList(bucket, alias, index), null, 2)}\n`
    return textResponse(request, headers, body, 'latest')
  }

  if (route.channel === 'latest' && route.filePath === 'config.json') {
    const value: unknown = JSON.parse(new TextDecoder().decode(await readPackedFileBytes(bucket, alias, file)))
    if (!isRecord(value))
      throw new RemoteThemeError(502, 'theme_config_invalid', 'Converted NodeGet theme config is invalid')
    const body = `${JSON.stringify(applyThemeAppearanceToConfig(value, themeAppearance(request, env)), null, 2)}\n`
    return textResponse(request, headers, body, 'latest')
  }

  if (remoteTextFile(route.filePath)) {
    if (route.channel === 'release' && request.headers.get('if-none-match') === headers.get('etag'))
      return notModifiedResponse(headers)
    const source = new TextDecoder().decode(await readPackedFileBytes(bucket, alias, file))
    const remoteBase = `${new URL(request.url).origin}${releaseBasePath(route, alias.asset.id)}`
    const branded = rewriteThemeAppearanceText(source, themeAppearance(request, env))
    const body = route.filePath === 'index.html'
      ? rewriteRemoteThemeAssets(branded, remoteBase, index.metadata.sourceShort)
      : rewriteRemoteTextAssetReferences(branded, remoteBase, index.metadata.sourceShort)
    return textResponse(request, headers, body, route.channel)
  }

  if (request.headers.get('if-none-match') === headers.get('etag'))
    return notModifiedResponse(headers)
  if (request.method === 'HEAD')
    return new Response(null, { status: 200, headers })

  const bytes = await readPackedFileBytes(bucket, alias, file)
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Response(body, { status: 200, headers })
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
    if (route.channel === 'release') {
      return jsonResponse({
        status: 'ok',
        repository: route.repository,
        channel: 'release',
        asset_id: route.assetId,
        asset_url: baseUrl,
        immutable: true,
      })
    }
    return jsonResponse({
      status: 'ok',
      repository: route.repository,
      channel: 'latest',
      theme_url: baseUrl,
      nodeget_import_url: nodeGetImportUrl(baseUrl, env.NODEGET_DASHBOARD_URL),
      update_mode: 'manual-remote-update',
    })
  }

  const resolvedDependencies: Required<RemoteThemeDependencies> = {
    fetcher: dependencies.fetcher ?? fetch,
    now: dependencies.now ?? Date.now,
  }
  try {
    let alias: BundleAlias
    let index: BundleIndex | null
    if (route.channel === 'latest') {
      alias = await resolveBundle(route, env, resolvedDependencies, url.origin)
      try {
        index = await readBundleIndex(env.THEME_CACHE!, alias.bundle.indexKey)
        if (!index)
          throw new RemoteThemeError(503, 'theme_cache_incomplete', 'Cached theme index is missing')
        return await servePackedFile(request, route, env, alias, index)
      }
      catch (error) {
        if (!(error instanceof RemoteThemeError) || error.code !== 'theme_cache_incomplete')
          throw error
        alias = await runBundleBuild(
          route,
          env,
          releaseFromAlias(alias),
          alias.asset,
          resolvedDependencies,
          resolvedDependencies.now(),
          url.origin,
          true,
        )
        index = await readBundleIndex(env.THEME_CACHE!, alias.bundle.indexKey)
        if (!index)
          throw new RemoteThemeError(503, 'theme_cache_incomplete', 'Rebuilt theme index is missing')
        return await servePackedFile(request, route, env, alias, index)
      }
    }
    else {
      const pinned = await resolvePinnedBundle(route, env, resolvedDependencies.now())
      alias = pinned.alias
      index = pinned.index
    }
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
