import { isRecord } from '../shared/utils'

export interface ThemeAppearance {
  backgroundUrl?: string
  logoUrl?: string
}

const CONFIG_BRAND_KEYS = ['site_name', 'site_title', 'site_description', 'footer'] as const

export function nodeGetBrandText(value: string): string {
  return value
    .replace(/(^|[^A-Za-z0-9_$])Komari(?=$|[^A-Za-z0-9_$])/g, '$1NodeGet')
    .replace(/(^|[^A-Za-z0-9_$])KOMARI(?=$|[^A-Za-z0-9_$])/g, '$1NODEGET')
    .replace(/\bNodeGet(?:\s+NodeGet)+\b/g, 'NodeGet')
}

export function rewriteThemeAppearanceText(
  source: string,
  appearance: ThemeAppearance = {},
): string {
  let output = brandTextOutsideUrls(source)
  if (!appearance.logoUrl)
    return output

  output = output.replace(/(["'])(?:\.\/|\/)favicon\.ico\1/g, (_match, quote: string) => (
    `${quote}${appearance.logoUrl}${quote}`
  ))
  return output.replace(/url\(\s*(["']?)(?:\.\/|\/)favicon\.ico\1\s*\)/gi, (_match, quote: string) => (
    `url(${quote}${appearance.logoUrl}${quote})`
  ))
}

function brandTextOutsideUrls(value: string): string {
  const urlPattern = /(?:https?:)?\/\/[^\s"'`<>()]+/gi
  let output = ''
  let offset = 0
  for (const match of value.matchAll(urlPattern)) {
    const index = match.index ?? offset
    output += nodeGetBrandText(value.slice(offset, index))
    output += match[0]
    offset = index + match[0].length
  }
  return output + nodeGetBrandText(value.slice(offset))
}

function preferenceOverrides(appearance: ThemeAppearance): Record<string, unknown> {
  if (!appearance.backgroundUrl)
    return {}
  return {
    backgroundEnabled: true,
    backgroundType: 'image',
    lightBackgroundUrl: appearance.backgroundUrl,
    darkBackgroundUrl: appearance.backgroundUrl,
    backgroundMediaType: 'image',
    backgroundImage: appearance.backgroundUrl,
    backgroundImageMobile: appearance.backgroundUrl,
  }
}

export function applyThemeAppearanceToConfig(
  source: Record<string, unknown>,
  appearance: ThemeAppearance = {},
): Record<string, unknown> {
  const preferences = isRecord(source.user_preferences)
    ? { ...source.user_preferences }
    : {}
  for (const key of CONFIG_BRAND_KEYS) {
    const value = preferences[key]
    if (typeof value === 'string')
      preferences[key] = nodeGetBrandText(value)
  }
  Object.assign(preferences, preferenceOverrides(appearance))
  return { ...source, user_preferences: preferences }
}

export function applyThemeAppearanceToManifest(
  source: Record<string, unknown>,
  appearance: ThemeAppearance = {},
): Record<string, unknown> {
  const manifest = { ...source }
  for (const key of ['name', 'description'] as const) {
    if (typeof manifest[key] === 'string')
      manifest[key] = nodeGetBrandText(manifest[key] as string)
  }
  const form = isRecord(manifest.user_preferences_form)
    ? { ...manifest.user_preferences_form }
    : null
  if (!form || !Array.isArray(form.items))
    return manifest

  const overrides = preferenceOverrides(appearance)
  form.items = form.items.map((entry) => {
    if (!isRecord(entry))
      return entry
    const converted = { ...entry }
    if (typeof converted.name === 'string')
      converted.name = nodeGetBrandText(converted.name)
    if (typeof converted.help === 'string')
      converted.help = nodeGetBrandText(converted.help)
    if (typeof converted.key === 'string'
      && CONFIG_BRAND_KEYS.includes(converted.key as typeof CONFIG_BRAND_KEYS[number])
      && typeof converted.default === 'string') {
      converted.default = nodeGetBrandText(converted.default)
    }
    if (typeof converted.key === 'string' && converted.key in overrides)
      converted.default = overrides[converted.key]
    return converted
  })
  manifest.user_preferences_form = form
  return manifest
}

export function isThemeTextAsset(path: string): boolean {
  return /\.(?:css|html|js|json|mjs|svg|webmanifest|xml)$/i.test(path)
}
