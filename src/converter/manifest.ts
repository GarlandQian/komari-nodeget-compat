import type { CompatManifest, ThemeSettingValueType } from '../types'
import { isRecord, localizedText } from '../shared/utils'
import type { ThemeAppearance } from './appearance'
import { applyThemeAppearanceToConfig, applyThemeAppearanceToManifest } from './appearance'
import { EXTRA_THEME_SETTINGS_KEY, formCanStorePreference, formSelectOptions, preferenceValueType } from './preferences'

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

const STANDARD_KEYS = new Set(['site_name', 'site_title', 'site_description', EXTRA_THEME_SETTINGS_KEY])
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
    warnings.push(`Komari configuration type "${configurationType}" is not executed on NodeGet; use the additional theme settings field for undeclared options.`)

  const convertedItems: NodeGetPreferenceItem[] = [
    { name: 'NodeGet 站点', type: 'title' },
    { key: 'site_name', name: '站点标题', type: 'string', default: sourceName, help: '公开页面站点名称' },
    { key: 'site_description', name: '站点描述', type: 'string', default: sourceDescription },
  ]
  const themeSettingsDefaults: Record<string, unknown> = {}
  const themeSettingKeys: string[] = []
  const themeSettingArrayKeys: string[] = []
  const themeSettingValueTypes: Record<string, ThemeSettingValueType> = {}
  const formDefaults: Record<string, unknown> = {
    site_name: sourceName,
    site_description: sourceDescription,
    [EXTRA_THEME_SETTINGS_KEY]: '{}',
  }
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
      themeSettingValueTypes[key] = preferenceValueType(item.default, sourceType)
      const encodedDefault = item.default === undefined ? undefined : JSON.stringify(item.default)
      if (encodedDefault !== undefined)
        formDefaults[key] = encodedDefault
      const formatHelp = themeSettingValueTypes[key] === 'string'
        ? '此项单独用 JSON 字符串填写，保留外层双引号；换行写 \\n，例如 "第一行\\n第二行"。'
        : '此项单独填写 JSON 值：数组用 ["a","b"]，对象用 {"key":"value"}，数字和布尔值不加引号。'
      convertedItems.push(compactPreference({
        key,
        name,
        type: 'string',
        ...(item.required === undefined ? {} : { required: item.required }),
        default: encodedDefault,
        help: [localizedText(item.help, ''), formatHelp].filter(Boolean).join(' '),
      }))
      warnings.push(`Configuration key "${key}" (${sourceType}) uses an individual JSON text field because NodeGet has no matching native control.`)
      continue
    }
    if (item.default !== undefined)
      formDefaults[key] = item.default
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
    warnings.push('This theme does not declare managed settings. Basic controls remain available; enter undeclared options in the additional theme settings field.')
  }

  convertedItems.push(
    { name: '高级配置', type: 'title' },
    {
      key: EXTRA_THEME_SETTINGS_KEY,
      name: '额外主题设置',
      type: 'string',
      default: '{}',
      help: '仅填写表单未列出的主题设置，例如 {"customOption":true}。普通表单字段优先；旧配置中的额外字段请先移入这里再保存。',
    },
  )

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
    themeSettingValueTypes,
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
  const defaultConfig = {
    user_preferences: formDefaults,
    site_tokens: [],
  }
  // Deployment appearance replaces these defaults with scalar values and native
  // controls, so an upstream complex-field codec must not reinterpret them.
  const appearanceDefaults = applyThemeAppearanceToConfig({}, options.appearance).user_preferences as Record<string, unknown>
  for (const key of Object.keys(appearanceDefaults)) {
    delete themeSettingValueTypes[key]
    const index = themeSettingArrayKeys.indexOf(key)
    if (index >= 0)
      themeSettingArrayKeys.splice(index, 1)
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
