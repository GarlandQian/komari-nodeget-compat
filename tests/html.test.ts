import { describe, expect, it } from 'bun:test'
import {
  injectCompatibilityRuntime,
  rewriteLocalThemeAssetReferences,
  rewriteRemoteTextAssetReferences,
  rewriteRemoteThemeAssets,
} from '../src/converter/html'

const remoteBase = 'https://adapter.example/themes/github/owner/theme/releases/42'

describe('remote theme asset rewriting', () => {
  it('pins source HTML assets while keeping compatibility files local', () => {
    const html = rewriteRemoteThemeAssets(`<!doctype html><html><head>
      <script src="./komari-nodeget-runtime.js" data-komari-nodeget-compat></script>
      <script type="module" src="./assets/app.js"></script>
      <link rel="stylesheet" href="/assets/app.css">
      <link rel="stylesheet" href="./custom.css">
    </head><body>
      <img src="/images/logo.png" srcset="/images/logo.png 1x, ./images/logo@2x.png 2x">
      <img src="https://cdn.example/images/external.png">
      <img src="data:image/png;base64,AAAA">
      <script src="./custom.js"></script>
      <div style="background:url('/images/background.webp')"></div>
    </body></html>`, remoteBase, 'Fixture')

    expect(html).toContain(`src="${remoteBase}/assets/app.js"`)
    expect(html).toContain(`href="${remoteBase}/assets/app.css"`)
    expect(html).toContain(`src="${remoteBase}/images/logo.png"`)
    expect(html).toContain(`${remoteBase}/images/logo.png 1x, ${remoteBase}/images/logo@2x.png 2x`)
    expect(html).toContain(`url('${remoteBase}/images/background.webp')`)
    expect(html).toContain('src="./komari-nodeget-runtime.js"')
    expect(html).toContain('href="./custom.css"')
    expect(html).toContain('src="./custom.js"')
    expect(html).toContain('src="https://cdn.example/images/external.png"')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
  })

  it('uses the latest remote runtime while keeping runtime config relative to NodeGet', () => {
    const latestBase = 'https://adapter.example/themes/github/owner/theme/latest'
    const html = rewriteRemoteThemeAssets(`<!doctype html><html><head>
      <script src="./komari-nodeget-runtime.js" data-komari-nodeget-compat></script>
      <script type="module" src="./assets/app.js"></script>
    </head><body></body></html>`, remoteBase, 'Fixture', latestBase)

    expect(html).toContain(`src="${latestBase}/komari-nodeget-runtime.js"`)
    expect(html).toContain('data-komari-nodeget-config-base="./"')
    expect(html).toContain(`src="${remoteBase}/assets/app.js"`)
  })

  it('rewrites root and Komari theme paths in JS and CSS without touching APIs or external URLs', () => {
    const source = `const image="/images/flag.svg";const preload="assets/chunk.css";const relative='./fonts/font.woff2';const api='/api/public';const external="https://cdn.example/images/x.png";const legacy='/themes/Fixture/dist/assets/app.js';const pattern=(/images/);const rel="modulepreload",assetUrl=function(e){return"/"+e};.hero{background:url(/fonts/font.woff2)}`
    const rewritten = rewriteRemoteTextAssetReferences(source, remoteBase, 'Fixture')
    expect(rewritten).toContain(`image="${remoteBase}/images/flag.svg"`)
    expect(rewritten).toContain(`legacy='${remoteBase}/assets/app.js'`)
    expect(rewritten).toContain(`preload="${remoteBase}/assets/chunk.css"`)
    expect(rewritten).toContain(`relative='${remoteBase}/fonts/font.woff2'`)
    expect(rewritten).toContain(`url(${remoteBase}/fonts/font.woff2)`)
    expect(rewritten).toContain("api='/api/public'")
    expect(rewritten).toContain('external="https://cdn.example/images/x.png"')
    expect(rewritten).toContain('pattern=(/images/)')
    expect(rewritten).toContain('assetUrl=function(e){return e.startsWith("http://")||e.startsWith("https://")||e.startsWith("//")?e:"/"+e}')
  })

  it('normalizes Komari theme paths for locally imported JS and CSS', () => {
    const source = `const lazy="/themes/Fixture/dist/assets/lazy.js";const api="/api/public";.hero{background:url(/themes/Fixture/dist/images/bg.webp)}`
    const rewritten = rewriteLocalThemeAssetReferences(source, 'Fixture')

    expect(rewritten).toContain('lazy="/assets/lazy.js"')
    expect(rewritten).toContain('url(/images/bg.webp)')
    expect(rewritten).toContain('api="/api/public"')
  })

  it('normalizes a root-relative JSON web app manifest for local NodeGet imports', () => {
    const output = injectCompatibilityRuntime(
      '<!doctype html><html><head><link rel="manifest" href="/manifest.json"></head><body></body></html>',
      'LuminaPlus',
    )
    expect(output).toContain('href="./manifest.json"')
    expect(output).toContain('data-komari-nodeget-config-base="./"')
  })
})
