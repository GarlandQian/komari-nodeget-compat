import type { CompatManifest } from '../types'
import { isRecord, localizedText } from '../shared/utils'
import type { ThemeAppearance } from './appearance'
import { applyThemeAppearanceToConfig, applyThemeAppearanceToManifest } from './appearance'
import { formCanStorePreference, formSelectOptions } from './preferences'

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

const STANDARD_KEYS = new Set(['site_name', 'site_title', 'site_description'])
const UNSAFE_SETTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
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
    warnings.push(`Komari configuration type "${configurationType}" is not executed on NodeGet; use the native JSON settings editor.`)

  const convertedItems: NodeGetPreferenceItem[] = [
    { name: 'NodeGet 站点', type: 'title' },
    { key: 'site_name', name: '站点标题', type: 'string', default: sourceName, help: '公开页面站点名称' },
    { key: 'site_description', name: '站点描述', type: 'string', default: sourceDescription },
  ]
  const themeSettingsDefaults: Record<string, unknown> = {}
  const themeSettingKeys: string[] = []
  const themeSettingArrayKeys: string[] = []
  const seenKeys = new Set(STANDARD_KEYS)
  let requiresJsonEditor = false

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
    if (UNSAFE_SETTING_KEYS.has(key)) {
      warnings.push(`Ignored unsafe configuration key "${key}".`)
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

    const targetType = sourceType as NodeGetPreferenceItem['type']
    const options = targetType === 'select' ? formSelectOptions(item.options) : undefined
    if (!DIRECT_TYPES.has(sourceType) || !formCanStorePreference({ type: targetType, options }, item.default)
      || (targetType === 'select' && !options)) {
      requiresJsonEditor = true
      warnings.push(`Configuration key "${key}" (${sourceType}) requires the native NodeGet JSON editor to preserve its value.`)
      continue
    }
    convertedItems.push(compactPreference({
      key,
      name,
      type: targetType,
      ...(item.required === undefined ? {} : { required: item.required }),
      ...(options === undefined ? {} : { options }),
      default: item.default,
      help: localizedText(item.help, ''),
    }))
  }

  if (!themeSettingKeys.length) {
    requiresJsonEditor = true
    warnings.push('No managed theme setting fields are available; NodeGet will use its native JSON editor.')
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
      // NodeGet saves only fields present in a non-empty form. Never expose a
      // partial form: it would hide the JSON editor and delete unlisted values.
      items: requiresJsonEditor ? [] : convertedItems,
    },
  }
  const defaultPreferences = {
    site_name: sourceName,
    site_description: sourceDescription,
    ...themeSettingsDefaults,
  }
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
