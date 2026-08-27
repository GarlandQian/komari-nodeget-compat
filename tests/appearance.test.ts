import { describe, expect, it } from 'bun:test'
import {
  applyThemeAppearanceToConfig,
  applyThemeAppearanceToManifest,
  nodeGetBrandText,
  rewriteThemeAppearanceText,
} from '../src/converter/appearance'

describe('NodeGet theme appearance', () => {
  it('rebrands visible standalone Komari text without renaming technical identifiers', () => {
    expect(nodeGetBrandText('Komari Monitor · Komari Glassmorphism')).toBe('NodeGet Monitor · NodeGet Glassmorphism')
    expect(nodeGetBrandText('KomariRpc komari-theme')).toBe('KomariRpc komari-theme')
    expect(nodeGetBrandText('NodeGet Komari Monitor')).toBe('NodeGet Monitor')
  })

  it('rewrites favicon literals to the repository-managed NodeGet logo', () => {
    const source = '<link href="/favicon.ico"><script>const brand="Komari Monitor",icon=\'/favicon.ico\'</script>'
    expect(rewriteThemeAppearanceText(source, { logoUrl: 'https://adapter.example/nodeget-logo.png' })).toBe(
      '<link href="https://adapter.example/nodeget-logo.png"><script>const brand="NodeGet Monitor",icon=\'https://adapter.example/nodeget-logo.png\'</script>',
    )
  })

  it('keeps repository URLs intact while rebranding surrounding display text', () => {
    const source = '<a href="https://github.com/shanyang242/Komari-Theme-LuminaPlus">Komari Theme</a>'
    expect(rewriteThemeAppearanceText(source)).toBe(
      '<a href="https://github.com/shanyang242/Komari-Theme-LuminaPlus">NodeGet Theme</a>',
    )
  })

  it('injects ACG defaults into both config and preference form', () => {
    const appearance = { backgroundUrl: 'https://adapter.example/api/acg-background' }
    const config = applyThemeAppearanceToConfig({
      user_preferences: { site_name: 'Komari Monitor', backgroundEnabled: false },
      site_tokens: [],
    }, appearance)
    expect(config.user_preferences).toMatchObject({
      site_name: 'NodeGet Monitor',
      backgroundEnabled: true,
      backgroundType: 'image',
      lightBackgroundUrl: appearance.backgroundUrl,
      darkBackgroundUrl: appearance.backgroundUrl,
      backgroundMediaType: 'image',
      backgroundImage: appearance.backgroundUrl,
      backgroundImageMobile: appearance.backgroundUrl,
    })

    const manifest = applyThemeAppearanceToManifest({
      name: 'NodeGet Komari Theme',
      description: 'Komari theme for operators',
      repository: 'https://github.com/shanyang242/Komari-Theme-LuminaPlus',
      dist_page: 'https://adapter.example/themes/github/example/Komari-Theme/latest',
      user_preferences_form: {
        items: [
          { key: 'site_name', name: 'Komari 站点', type: 'string', default: 'Komari Monitor' },
          { key: 'backgroundEnabled', name: '背景', type: 'switch', default: false },
          { key: 'lightBackgroundUrl', name: '地址', type: 'string', default: '' },
        ],
      },
    }, appearance)
    expect(manifest.name).toBe('NodeGet Theme')
    expect(manifest.description).toBe('NodeGet theme for operators')
    expect(manifest.repository).toBe('https://github.com/shanyang242/Komari-Theme-LuminaPlus')
    expect(manifest.dist_page).toBe('https://adapter.example/themes/github/example/Komari-Theme/latest')
    expect(manifest.user_preferences_form).toMatchObject({
      items: [
        { key: 'site_name', name: 'NodeGet 站点', default: 'NodeGet Monitor' },
        { key: 'backgroundEnabled', default: true },
        { key: 'lightBackgroundUrl', default: appearance.backgroundUrl },
      ],
    })
  })
})
