import type { CompatManifest } from '../types'
import { isRecord, localizedText } from '../shared/utils'
import type { ThemeAppearance } from './appearance'
import { applyThemeAppearanceToConfig, applyThemeAppearanceToManifest } from './appearance'

export interface KomariConfigurationItem {
  key?: string
  name?: unknown
  required?: boolean
  type?: string
  options?: unknown
  default?: unknown
  help?: unknown
}

export interface KomariThemeManifest {
  name: unknown
  short: string
  description?: unknown
  version?: string
  author?: unknown
  url?: string
  preview?: string
  configuration?: {
    type?: string
    data?: unknown
  }
}

export interface NodeGetPreferenceItem {
  key?: string
  name: string
  type: 'string' | 'number' | 'select' | 'switch' | 'title'
  required?: boolean
  options?: string
  default?: unknown
  help?: string
}

export interface ConvertedManifests {
  nodeget: Record<string, unknown>
  compat: CompatManifest
  defaultConfig: Record<string, unknown>
  warnings: string[]
}

export interface ConvertManifestOptions {
  appearance?: ThemeAppearance
  distPage?: string
}

const STANDARD_KEYS = new Set(['site_name', 'site_title', 'site_description', 'footer'])
const DIRECT_TYPES = new Set(['string', 'number', 'select', 'switch', 'title'])
const ARRAY_TYPES = new Set(['nodes', 'pingtasks'])

export function parseKomariManifest(text: string): KomariThemeManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch (error) {
    throw new SyntaxError(`Invalid komari-theme.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(value))
    throw new TypeError('komari-theme.json must contain an object')
  if (typeof value.short !== 'string' || !value.short.trim())
    throw new TypeError('komari-theme.json short must be a non-empty string')
  if (typeof value.name !== 'string' && !isRecord(value.name))
    throw new TypeError('komari-theme.json name must be a string or localized object')
  return value as unknown as KomariThemeManifest
}

export function convertManifests(
  manifest: KomariThemeManifest,
  options: ConvertManifestOptions = {},
): ConvertedManifests {
  const sourceName = localizedText(manifest.name, manifest.short)
  const sourceDescription = localizedText(manifest.description, `Converted Komari theme ${sourceName}`)
  const sourceAuthor = localizedText(manifest.author, 'Unknown')
  const version = manifest.version?.trim() || '0.0.0'
  const warnings: string[] = []
  const configurationType = manifest.configuration?.type?.trim().toLowerCase() || 'managed'
  const rawItems = configurationType === 'managed' && Array.isArray(manifest.configuration?.data)
    ? manifest.configuration.data
    : []

  if (configurationType !== 'managed')
    warnings.push(`Komari configuration type "${configurationType}" is not executable on NodeGet; defaults only will be used.`)

  const convertedItems: NodeGetPreferenceItem[] = [
    { name: 'NodeGet 站点', type: 'title' },
    { key: 'site_name', name: '站点标题', type: 'string', default: sourceName, help: '公开页面站点名称' },
    { key: 'site_title', name: '页面标题', type: 'string', default: sourceName, help: '浏览器标签页标题' },
    { key: 'site_description', name: '站点描述', type: 'string', default: sourceDescription },
    { key: 'footer', name: '页脚文本', type: 'string', default: 'Powered by NodeGet' },
  ]
  const themeSettingsDefaults: Record<string, unknown> = {}
  const themeSettingKeys: string[] = []
  const themeSettingArrayKeys: string[] = []
  const seenKeys = new Set(STANDARD_KEYS)

  if (rawItems.length)
    convertedItems.push({ name: `${sourceName} 主题设置`, type: 'title' })

  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) {
      warnings.push('Ignored a non-object Komari configuration item.')
      continue
    }
    const item = rawItem as KomariConfigurationItem
    const sourceType = item.type?.trim().toLowerCase() || 'string'
    const name = localizedText(item.name, item.key || 'Theme setting')
    if (sourceType === 'title') {
      convertedItems.push({ name, type: 'title' })
      continue
    }
    const key = item.key?.trim()
    if (!key) {
      warnings.push(`Ignored configuration item "${name}" because it has no key.`)
      continue
    }
    if (seenKeys.has(key)) {
      warnings.push(`Ignored duplicate or reserved configuration key "${key}".`)
      continue
    }
    seenKeys.add(key)
    themeSettingKeys.push(key)
    if (ARRAY_TYPES.has(sourceType))
      themeSettingArrayKeys.push(key)
    if (item.default !== undefined)
      themeSettingsDefaults[key] = item.default

    const targetType = DIRECT_TYPES.has(sourceType)
      ? sourceType as NodeGetPreferenceItem['type']
      : 'string'
    if (targetType !== sourceType)
      warnings.push(`Configuration key "${key}" (${sourceType}) was downgraded to a string field.`)
    const defaultValue = ARRAY_TYPES.has(sourceType) && Array.isArray(item.default)
      ? item.default.join(',')
      : item.default
    const options = targetType === 'select' ? convertOptions(item.options) : undefined
    if (targetType === 'select' && !options) {
      warnings.push(`Configuration key "${key}" has no usable select options and was downgraded to string.`)
      convertedItems.push(compactPreference({
        key,
        name,
        type: 'string',
        ...(item.required === undefined ? {} : { required: item.required }),
        default: defaultValue,
        help: localizedText(item.help, ''),
      }))
      continue
    }
    convertedItems.push(compactPreference({
      key,
      name,
      type: targetType,
      ...(item.required === undefined ? {} : { required: item.required }),
      ...(options === undefined ? {} : { options }),
      default: defaultValue,
      help: localizedText(item.help, ''),
    }))
  }

  const short = nodeGetShort(manifest.short)
  const compat: CompatManifest = {
    schema: 1,
    source: {
      name: sourceName,
      short: manifest.short,
      version,
      ...(manifest.url ? { url: manifest.url } : {}),
    },
    themeSettingsDefaults,
    themeSettingKeys,
    themeSettingArrayKeys,
  }
  const nodeget = {
    name: `NodeGet ${sourceName}`,
    short,
    description: `${sourceDescription} (Komari compatibility package)`,
    author: sourceAuthor,
    ...(manifest.url ? { repository: manifest.url } : {}),
    ...(options.distPage ? { dist_page: options.distPage } : {}),
    version,
    license: '',
    preview: previewOutputName(manifest.preview),
    user_preferences_form: {
      version: '1.0.0',
      items: convertedItems,
    },
  }
  const defaultPreferences = Object.fromEntries(convertedItems.flatMap((item) => {
    if (!item.key || item.default === undefined)
      return []
    return [[item.key, item.default]]
  }))
  const defaultConfig = {
    user_preferences: defaultPreferences,
    site_tokens: [],
  }
  return {
    nodeget: applyThemeAppearanceToManifest(nodeget, options.appearance),
    compat,
    defaultConfig: applyThemeAppearanceToConfig(defaultConfig, options.appearance),
    warnings,
  }
}

export function previewOutputName(preview: string | undefined): string {
  if (!preview)
    return 'preview.png'
  const clean = preview.replaceAll('\\', '/').split('/').at(-1)?.trim()
  return clean || 'preview.png'
}

function nodeGetShort(sourceShort: string): string {
  const safe = sourceShort.replaceAll(/[^A-Za-z0-9_-]/g, '-').replaceAll(/-+/g, '-').replace(/^-|-$/g, '')
  return `NG-${safe || 'KomariTheme'}`
}

function convertOptions(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value.trim() || undefined
  if (!Array.isArray(value))
    return undefined
  const options = value.flatMap((item): string[] => {
    if (typeof item === 'string' || typeof item === 'number')
      return [String(item)]
    if (!isRecord(item))
      return []
    const optionValue = item.value ?? item.key ?? item.label ?? item.name
    return optionValue == null ? [] : [String(optionValue)]
  })
  return options.length ? options.join(',') : undefined
}

function compactPreference(item: NodeGetPreferenceItem): NodeGetPreferenceItem {
  return {
    ...(item.key ? { key: item.key } : {}),
    name: item.name,
    type: item.type,
    ...(item.required ? { required: true } : {}),
    ...(item.options ? { options: item.options } : {}),
    ...(item.default === undefined ? {} : { default: item.default }),
    ...(item.help ? { help: item.help } : {}),
  }
}
