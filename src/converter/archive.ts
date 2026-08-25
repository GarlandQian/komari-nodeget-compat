import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { injectCompatibilityRuntime } from './html'
import { convertManifests, parseKomariManifest, previewOutputName } from './manifest'

export const MAX_INPUT_BYTES = 100 * 1024 * 1024
export const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
export const MAX_ARCHIVE_FILES = 10_000

export interface ConvertArchiveOptions {
  runtime: Uint8Array
}

export interface ConvertArchiveResult {
  archive: Uint8Array
  warnings: string[]
  sourceName: string
  sourceShort: string
  sourceVersion: string
  outputShort: string
  inputFileCount: number
  outputFileCount: number
}

function safeArchivePath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path.includes('\0'))
    throw new Error(`Unsafe archive path: ${path}`)
  const segments = path.split('/')
  if (segments.some(segment => segment === '..'))
    throw new Error(`Unsafe archive path: ${path}`)
  return segments.filter(segment => segment && segment !== '.').join('/')
}

function normalizeEntries(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const normalized: Record<string, Uint8Array> = {}
  let totalBytes = 0
  let fileCount = 0
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith('/') || path.endsWith('\\'))
      continue
    const safePath = safeArchivePath(path)
    if (!safePath || safePath.startsWith('__MACOSX/') || safePath.endsWith('/.DS_Store'))
      continue
    if (safePath in normalized)
      throw new Error(`Theme contains duplicate archive path: ${safePath}`)
    totalBytes += content.byteLength
    if (totalBytes > MAX_UNCOMPRESSED_BYTES)
      throw new Error(`Theme expands beyond ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MiB safety limit`)
    normalized[safePath] = content
    fileCount += 1
    if (fileCount > MAX_ARCHIVE_FILES)
      throw new Error(`Theme contains more than ${MAX_ARCHIVE_FILES} files`)
  }
  return normalized
}

function prettyJson(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`)
}

function sourceWarnings(entries: Record<string, Uint8Array>, themeShort: string): string[] {
  const warnings: string[] = []
  const textExtensions = new Set(['.html', '.js', '.mjs', '.css', '.json'])
  for (const [path, content] of Object.entries(entries)) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    if (!textExtensions.has(extension) || content.byteLength > 10 * 1024 * 1024)
      continue
    const text = strFromU8(content)
    if (text.includes(`/themes/${themeShort}/`))
      warnings.push(`${path} contains an absolute /themes/${themeShort}/ path that may need theme-specific rewriting.`)
    if (text.includes('/api/admin/') || text.includes('admin:'))
      warnings.push(`${path} references Komari administrative APIs; those features will remain disabled.`)
  }
  if (Object.keys(entries).some(path => /(^|\/)(service-worker|sw)\.[cm]?js$/i.test(path)))
    warnings.push('The theme contains a Service Worker. Verify cache scope and updates after conversion.')
  return [...new Set(warnings)]
}

export function convertThemeArchive(
  input: Uint8Array,
  options: ConvertArchiveOptions,
): ConvertArchiveResult {
  if (input.byteLength > MAX_INPUT_BYTES)
    throw new Error(`Input theme exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MiB safety limit`)
  if (!options.runtime.byteLength)
    throw new Error('Compatibility runtime bundle is empty')

  const sourceEntries = normalizeEntries(unzipSync(input))
  const manifestBytes = sourceEntries['komari-theme.json']
  if (!manifestBytes)
    throw new Error('Komari theme ZIP must contain komari-theme.json at its root')
  const indexBytes = sourceEntries['dist/index.html']
  if (!indexBytes)
    throw new Error('Komari theme ZIP must contain dist/index.html')

  const manifest = parseKomariManifest(strFromU8(manifestBytes))
  const converted = convertManifests(manifest)
  const output: Record<string, Uint8Array> = {}

  for (const [path, content] of Object.entries(sourceEntries)) {
    if (path.startsWith('dist/')) {
      const outputPath = path.slice('dist/'.length)
      if (outputPath)
        output[outputPath] = content
      continue
    }
    if (path !== 'komari-theme.json')
      output[path] = content
  }

  output['index.html'] = strToU8(injectCompatibilityRuntime(strFromU8(indexBytes), manifest.short))
  output['komari-nodeget-runtime.js'] = options.runtime
  output['nodeget-theme.json'] = prettyJson(converted.nodeget)
  output['komari-compat.json'] = prettyJson(converted.compat)
  output['config.json'] = prettyJson(converted.defaultConfig)
  output['custom.css'] ??= strToU8('/* NodeGet theme overrides */\n')
  output['custom.js'] ??= strToU8('/* NodeGet theme overrides */\n')

  const previewName = previewOutputName(manifest.preview)
  const sourcePreview = manifest.preview ? sourceEntries[safeArchivePath(manifest.preview)] : undefined
  if (sourcePreview)
    output[previewName] = sourcePreview
  else if (!output[previewName])
    converted.warnings.push(`Preview asset "${manifest.preview ?? 'preview.png'}" was not found in the source package.`)

  const fileNames = [...new Set([...Object.keys(output), 'nodeget-theme-files.json'])].sort()
  output['nodeget-theme-files.json'] = prettyJson(fileNames)
  const warnings = [
    ...converted.warnings,
    ...sourceWarnings(sourceEntries, manifest.short),
  ]
  const archive = zipSync(output, { level: 9 })
  return {
    archive,
    warnings,
    sourceName: converted.compat.source.name,
    sourceShort: manifest.short,
    sourceVersion: converted.compat.source.version,
    outputShort: String(converted.nodeget.short),
    inputFileCount: Object.keys(sourceEntries).length,
    outputFileCount: Object.keys(output).length,
  }
}
