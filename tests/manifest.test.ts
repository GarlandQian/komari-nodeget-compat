import { describe, expect, it } from 'bun:test'
import { convertManifests, parseKomariManifest } from '../src/converter/manifest'

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
    const converted = convertManifests(source)
    expect(converted.nodeget.name).toBe('NodeGet 测试主题')
    expect(converted.nodeget.short).toBe('NG-Test-Theme')
    expect(converted.compat.themeSettingsDefaults).toEqual({ dense: true, nodes: ['a', 'b'], palette: 'blue' })
    expect(converted.compat.themeSettingArrayKeys).toEqual(['nodes'])
    expect(converted.defaultConfig.user_preferences).toMatchObject({ nodes: 'a,b', dense: true })
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
})
