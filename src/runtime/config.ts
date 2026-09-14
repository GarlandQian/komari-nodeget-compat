import type { CompatManifest, NodeGetThemeConfig } from '../types'
import { isRecord, normalizeWebSocketUrl } from '../shared/utils'

const UNSAFE_SETTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SETTING_VALUE_TYPES = new Set(['string', 'array', 'object', 'number', 'boolean', 'any'])

export interface LoadedRuntimeConfig {
  config: NodeGetThemeConfig
  manifest: CompatManifest
}

async function loadJson(fetchImpl: typeof fetch, url: URL): Promise<unknown> {
  const response = await fetchImpl(url, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`Failed to load ${url.pathname}: HTTP ${response.status}`)
  return response.json()
}

function validateThemeConfig(value: unknown): NodeGetThemeConfig {
  if (!isRecord(value))
    throw new TypeError('config.json must contain a JSON object')
  if (value.user_preferences !== undefined && !isRecord(value.user_preferences))
    throw new TypeError('config.json user_preferences must be an object')
  const siteTokens = value.site_tokens
  if (!Array.isArray(siteTokens) || siteTokens.length === 0)
    throw new TypeError('config.json must contain at least one NodeGet site_tokens entry')
  for (const [index, entry] of siteTokens.entries()) {
    if (!isRecord(entry))
      throw new TypeError(`config.json site_tokens[${index}] must be an object`)
    if (typeof entry.backend_url !== 'string' || !entry.backend_url.trim())
      throw new TypeError(`config.json site_tokens[${index}].backend_url is required`)
    normalizeWebSocketUrl(entry.backend_url)
    if (typeof entry.token !== 'string' || !entry.token.trim())
      throw new TypeError(`config.json site_tokens[${index}].token is required`)
    if (entry.name !== undefined && typeof entry.name !== 'string')
      throw new TypeError(`config.json site_tokens[${index}].name must be a string`)
  }
  return {
    ...(isRecord(value.user_preferences) ? { user_preferences: { ...value.user_preferences } } : {}),
    site_tokens: siteTokens.map(entry => ({
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      backend_url: entry.backend_url as string,
      token: entry.token as string,
    })),
  }
}

function validateCompatManifest(value: unknown): CompatManifest {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.source))
    throw new TypeError('komari-compat.json has an unsupported schema')
  if (typeof value.source.name !== 'string'
    || typeof value.source.short !== 'string'
    || typeof value.source.version !== 'string') {
    throw new TypeError('komari-compat.json source metadata is invalid')
  }
  if (!isRecord(value.themeSettingsDefaults) || !Array.isArray(value.themeSettingKeys))
    throw new TypeError('komari-compat.json theme settings metadata is invalid')
  if (!Array.isArray(value.themeSettingArrayKeys))
    throw new TypeError('komari-compat.json array settings metadata is invalid')
  if (!value.themeSettingKeys.every(key => typeof key === 'string')
    || !value.themeSettingArrayKeys.every(key => typeof key === 'string')) {
    throw new TypeError('komari-compat.json theme setting keys must be strings')
  }
  if ([...Object.keys(value.themeSettingsDefaults), ...value.themeSettingKeys, ...value.themeSettingArrayKeys]
    .some(key => UNSAFE_SETTING_KEYS.has(key))) {
    throw new TypeError('komari-compat.json contains an unsafe theme setting key')
  }
  if (value.themeSettingValueTypes !== undefined) {
    if (!isRecord(value.themeSettingValueTypes))
      throw new TypeError('komari-compat.json theme setting value types must be an object')
    for (const [key, type] of Object.entries(value.themeSettingValueTypes)) {
      if (UNSAFE_SETTING_KEYS.has(key))
        throw new TypeError('komari-compat.json contains an unsafe theme setting value type key')
      if (typeof type !== 'string' || !SETTING_VALUE_TYPES.has(type))
        throw new TypeError(`komari-compat.json theme setting value type for "${key}" is invalid`)
    }
  }
  return value as unknown as CompatManifest
}

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch,
  baseUrl: URL,
): Promise<LoadedRuntimeConfig> {
  const [config, manifest] = await Promise.all([
    loadJson(fetchImpl, new URL('config.json', baseUrl)),
    loadJson(fetchImpl, new URL('komari-compat.json', baseUrl)),
  ])
  return {
    config: validateThemeConfig(config),
    manifest: validateCompatManifest(manifest),
  }
}
