import { describe, expect, it } from 'bun:test'
import { convertManifests, parseKomariManifest } from '../src/converter/manifest'
import { NodeGetMonitorProvider } from '../src/nodeget/provider'
import type { NodeGetThemeConfig } from '../src/types'

// Match NodeGet ThemeDetail's save contract: a non-empty form projects only its
// fields, while the native JSON editor preserves the complete preference object.
function saveInNodeGet(converted: ReturnType<typeof convertManifests>, values: Record<string, unknown>) {
  const form = converted.nodeget.user_preferences_form as { items: Array<{ key?: string, type: string }> }
  return form.items.length
    ? Object.fromEntries(form.items.filter(item => item.type !== 'title' && item.key).map(item => [item.key!, values[item.key!]]))
    : JSON.parse(JSON.stringify(values)) as Record<string, unknown>
}

describe('manifest conversion', () => {
  it('maps localized metadata and managed settings', () => {
    const source = parseKomariManifest(JSON.stringify({
      name: { 'zh-CN': '测试主题', en: 'Test Theme' },
      short: 'Test-Theme',
      version: '1.2.3',
      author: 'Tester',
      url: 'https://example.com/theme',
      configuration: {
        type: 'managed',
        data: [
          { type: 'title', name: '显示' },
          { key: 'dense', type: 'switch', name: '紧凑', default: true },
          { key: 'nodes', type: 'nodes', name: '节点', default: ['a', 'b'] },
          { key: 'palette', type: 'select', name: '配色', options: ['blue', 'green'], default: 'blue' },
        ],
      },
    }))
    const converted = convertManifests(source, { distPage: 'https://adapter.example/themes/github/test/theme/latest' })
    expect(converted.nodeget.name).toBe('NodeGet 测试主题')
    expect(converted.nodeget.short).toBe('NG-Test-Theme')
    expect(converted.nodeget.dist_page).toBe('https://adapter.example/themes/github/test/theme/latest')
    expect(converted.compat.themeSettingsDefaults).toEqual({ dense: true, nodes: ['a', 'b'], palette: 'blue' })
    expect(converted.compat.themeSettingArrayKeys).toEqual(['nodes'])
    expect(converted.defaultConfig.user_preferences).toMatchObject({ nodes: ['a', 'b'], dense: true })
    expect(converted.nodeget.user_preferences_form).toMatchObject({ items: [] })
    expect(converted.warnings.some(warning => warning.includes('nodes'))).toBe(true)
  })

  it('does not expose reserved or duplicate keys', () => {
    const converted = convertManifests({
      name: 'Test',
      short: 'Test',
      configuration: {
        data: [
          { key: 'site_name', type: 'string', name: 'Override' },
          { key: 'same', type: 'string', name: 'One' },
          { key: 'same', type: 'string', name: 'Two' },
        ],
      },
    })
    expect(converted.compat.themeSettingKeys).toEqual(['same'])
    expect(converted.warnings).toHaveLength(2)
  })

  it('rejects prototype-mutating theme setting keys', () => {
    const converted = convertManifests({
      name: 'Test',
      short: 'Test',
      configuration: {
        data: [
          { key: '__proto__', type: 'string', name: 'Unsafe', default: { polluted: true } },
          { key: 'constructor', type: 'string', name: 'Unsafe 2', default: 'x' },
        ],
      },
    })
    expect(converted.compat.themeSettingKeys).toEqual([])
    expect(converted.warnings.filter(warning => warning.includes('unsafe'))).toHaveLength(2)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps a native form for losslessly editable scalar settings without adding ineffective fields', () => {
    const converted = convertManifests({
      name: 'Scalar theme', short: 'Scalar',
      configuration: { type: 'managed', data: [
        { key: 'dense', type: 'switch', name: 'Dense', default: false },
        { key: 'columns', type: 'number', name: 'Columns', default: 3 },
        { key: 'mode', type: 'select', name: 'Mode', options: 'auto,light,dark', default: 'auto' },
        { key: 'heading', type: 'string', name: 'Heading', default: 'Hello' },
      ] },
    })
    const form = converted.nodeget.user_preferences_form as { items: Array<{ key?: string }> }
    expect(form.items.flatMap(item => item.key ?? [])).toEqual([
      'site_name', 'site_description', 'dense', 'columns', 'mode', 'heading',
    ])
    expect(converted.defaultConfig.user_preferences).not.toHaveProperty('site_title')
    expect(converted.defaultConfig.user_preferences).not.toHaveProperty('footer')
    expect(converted.warnings).toEqual([])
  })

  it('preserves background and custom structured settings when a schema-free theme is saved', async () => {
    const converted = convertManifests({ name: 'Schema-free', short: 'SchemaFree' }, {
      appearance: { backgroundUrl: 'https://adapter.example/api/acg-background' },
    })
    const preferences = {
      ...converted.defaultConfig.user_preferences as Record<string, unknown>,
      showOverview: false,
      selectedTasks: [42, 43],
      homepagePingBindings: { 42: ['example-node'] },
      announcement: 'First line\nSecond line',
    }
    const saved = saveInNodeGet(converted, preferences)
    expect(saved).toEqual(preferences)
    expect(saved.backgroundImage).toBe('https://adapter.example/api/acg-background')
    const provider = new NodeGetMonitorProvider({ user_preferences: saved, site_tokens: [] }, converted.compat)
    expect((await provider.getPublicInfo()).theme_settings).toMatchObject({
      showOverview: false,
      selectedTasks: [42, 43],
      homepagePingBindings: { 42: ['example-node'] },
      announcement: 'First line\nSecond line',
      backgroundImage: 'https://adapter.example/api/acg-background',
    })
    expect(converted.warnings.some(warning => warning.includes('JSON editor'))).toBe(true)
  })

  it('preserves multi-line and object settings instead of exposing a destructive partial form', async () => {
    const defaults = { cards: 'memory\ndisk\ntotalTraffic', palette: { accent: '#00aaff' }, tasks: [42, 43] }
    const converted = convertManifests({
      name: 'Structured theme', short: 'Structured', configuration: { data: [
        { key: 'cards', type: 'richtext', name: 'Cards', default: defaults.cards },
        { key: 'palette', type: 'string', name: 'Palette', default: defaults.palette },
        { key: 'tasks', type: 'pingtasks', name: 'Tasks', default: defaults.tasks },
        { key: 'enabled', type: 'switch', name: 'Enabled', default: true },
      ] },
    })
    const config = converted.defaultConfig as unknown as NodeGetThemeConfig
    const saved = saveInNodeGet(converted, { ...config.user_preferences, enabled: false })
    expect(saved).toMatchObject({ ...defaults, enabled: false })
    const provider = new NodeGetMonitorProvider({ ...config, user_preferences: saved }, converted.compat)
    expect((await provider.getPublicInfo()).theme_settings).toEqual({ ...defaults, enabled: false })
  })

  it('uses JSON for multiline string defaults and unknown controls, retaining their original values', () => {
    for (const field of [
      { key: 'message', type: 'string', default: 'line1\r\nline2' },
      { key: 'custom', type: 'future-control', default: { enabled: false } },
      { key: 'numericChoice', type: 'select', options: [1, 2], default: 1 },
      { key: 'numericChoiceWithoutDefault', type: 'select', options: [1, 2] },
      { key: 'commaChoice', type: 'select', options: ['a,b', 'c'], default: 'a,b' },
      { key: 'objectChoice', type: 'select', options: [{ value: { nested: true } }] },
    ]) {
      const converted = convertManifests({ name: 'Future', short: 'Future', configuration: { data: [field] } })
      expect(converted.nodeget.user_preferences_form).toMatchObject({ items: [] })
      expect(saveInNodeGet(converted, converted.defaultConfig.user_preferences as Record<string, unknown>)[field.key]).toEqual(field.default)
    }
  })

  it('preserves a footer actually declared by a theme', () => {
    const converted = convertManifests({ name: 'Footer', short: 'Footer', configuration: { data: [
      { key: 'footer', type: 'string', name: 'Footer', default: 'Custom footer' },
    ] } })
    expect(converted.compat.themeSettingsDefaults.footer).toBe('Custom footer')
    expect(converted.compat.themeSettingKeys).toEqual(['footer'])
  })
})
