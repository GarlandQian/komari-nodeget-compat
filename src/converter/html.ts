import type { DefaultTreeAdapterMap } from 'parse5'
import { defaultTreeAdapter, parse, parseFragment, serialize } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type ParentNode = DefaultTreeAdapterMap['parentNode']

const ASSET_ELEMENTS = new Set(['script', 'link', 'img', 'source', 'video', 'audio'])
const COMPAT_LOCAL_ASSETS = new Set([
  './komari-nodeget-runtime.js',
  './custom.css',
  './custom.js',
])

function isParentNode(node: Node): node is ParentNode {
  return 'childNodes' in node
}

function isElement(node: Node): node is Element {
  return 'tagName' in node && 'attrs' in node
}

function findElement(node: Node, tagName: string): Element | null {
  if (isElement(node) && node.tagName === tagName)
    return node
  if (!isParentNode(node))
    return null
  for (const child of node.childNodes) {
    const match = findElement(child, tagName)
    if (match)
      return match
  }
  return null
}

function fragmentElement(html: string): Element {
  const fragment = parseFragment(html)
  const element = fragment.childNodes.find(isElement)
  if (!element)
    throw new Error(`Failed to create injected HTML element: ${html}`)
  return element
}

function hasAttribute(element: Element, name: string, value?: string): boolean {
  return element.attrs.some(attribute => attribute.name === name && (value === undefined || attribute.value === value))
}

function setAttribute(element: Element, name: string, value: string): void {
  const current = element.attrs.find(attribute => attribute.name === name)
  if (current)
    current.value = value
  else
    element.attrs.push({ name, value })
}

function walkElements(node: Node, visitor: (element: Element) => void): void {
  if (isElement(node))
    visitor(node)
  if (!isParentNode(node))
    return
  for (const child of node.childNodes)
    walkElements(child, visitor)
}

function rewriteAssetUrl(value: string, themeShort: string): string {
  const normalized = value.replaceAll(`\/themes\/${themeShort}\/dist\/`, './')
    .replaceAll(`\/themes\/${themeShort}\/`, './')
  if (/^\/(assets|images|fonts)\//.test(normalized))
    return `.${normalized}`
  if (/^\/(favicon\.(ico|png|svg)|manifest\.(?:json|webmanifest))$/.test(normalized))
    return `.${normalized}`
  return normalized
}

function normalizedRemoteBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Remote theme asset base must use HTTP or HTTPS')
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

function remoteAssetUrl(value: string, remoteBaseUrl: string): string {
  const trimmed = value.trim()
  if (!trimmed || COMPAT_LOCAL_ASSETS.has(trimmed))
    return value
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(trimmed))
    return value

  const path = trimmed.replace(/^\.\//, '').replace(/^\//, '')
  if (!path || path.startsWith('../'))
    return value
  return `${remoteBaseUrl}/${path}`
}

function rewriteSrcset(value: string, remoteBaseUrl: string): string {
  if (value.trimStart().startsWith('data:'))
    return value
  return value.split(',').map((candidate) => {
    const match = candidate.match(/^(\s*)(\S+)(.*)$/s)
    if (!match)
      return candidate
    return `${match[1]}${remoteAssetUrl(match[2]!, remoteBaseUrl)}${match[3]}`
  }).join(',')
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function viteRemoteAwareResolver(name: string, parameter: string): string {
  const remote = `${parameter}.startsWith("http://")||${parameter}.startsWith("https://")||${parameter}.startsWith("//")`
  return `${name}=function(${parameter}){return ${remote}?${parameter}:"/"+${parameter}}`
}

function rewriteViteAssetResolver(text: string): string {
  if (!text.includes('modulepreload'))
    return text

  const functionResolver = /([A-Za-z_$][\w$]*)\s*=\s*function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s*(["'])\/\3\s*\+\s*\2\s*;?\s*\}/g
  const parenthesizedArrowResolver = /([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*(["'])\/\3\s*\+\s*\2/g
  const arrowResolver = /([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*=>\s*(["'])\/\3\s*\+\s*\2/g
  return text
    .replace(functionResolver, (_match, name: string, parameter: string) => viteRemoteAwareResolver(name, parameter))
    .replace(parenthesizedArrowResolver, (_match, name: string, parameter: string) => viteRemoteAwareResolver(name, parameter))
    .replace(arrowResolver, (_match, name: string, parameter: string) => viteRemoteAwareResolver(name, parameter))
}

export function rewriteRemoteTextAssetReferences(
  text: string,
  remoteBase: string,
  themeShort?: string,
): string {
  const remoteBaseUrl = normalizedRemoteBaseUrl(remoteBase)
  let rewritten = text
  if (themeShort) {
    const themePath = escapedRegExp(themeShort)
    rewritten = rewritten.replace(
      new RegExp(`(["'\\x60])\\/themes\\/${themePath}\\/(?:dist\\/)?`, 'g'),
      `$1${remoteBaseUrl}/`,
    )
    rewritten = rewritten.replace(
      new RegExp(`(url\\(\\s*)\\/themes\\/${themePath}\\/(?:dist\\/)?`, 'gi'),
      `$1${remoteBaseUrl}/`,
    )
  }
  rewritten = rewritten.replace(
    /(["'\x60])(?:\.?\/)?(assets|images|fonts)\//g,
    `$1${remoteBaseUrl}/$2/`,
  )
  rewritten = rewritten.replace(
    /(url\(\s*)(?:\.?\/)?(assets|images|fonts)\//gi,
    `$1${remoteBaseUrl}/$2/`,
  )
  return rewriteViteAssetResolver(rewritten)
}

export function rewriteLocalThemeAssetReferences(text: string, themeShort: string): string {
  const themePath = escapedRegExp(themeShort)
  return text
    .replace(
      new RegExp(`(["'\\x60])\\/themes\\/${themePath}\\/(?:dist\\/)?`, 'g'),
      '$1/',
    )
    .replace(
      new RegExp(`(url\\(\\s*)\\/themes\\/${themePath}\\/(?:dist\\/)?`, 'gi'),
      '$1/',
    )
}

export function rewriteRemoteThemeAssets(
  html: string,
  remoteBase: string,
  themeShort?: string,
  compatibilityRuntimeBase?: string,
): string {
  const remoteBaseUrl = normalizedRemoteBaseUrl(remoteBase)
  const compatibilityRuntimeBaseUrl = compatibilityRuntimeBase
    ? normalizedRemoteBaseUrl(compatibilityRuntimeBase)
    : null
  const document = parse(html)

  walkElements(document, (element) => {
    if (!ASSET_ELEMENTS.has(element.tagName))
      return
    if (hasAttribute(element, 'data-komari-nodeget-compat')) {
      if (element.tagName === 'script' && compatibilityRuntimeBaseUrl) {
        setAttribute(element, 'src', `${compatibilityRuntimeBaseUrl}/komari-nodeget-runtime.js`)
        setAttribute(element, 'data-komari-nodeget-config-base', './')
      }
      return
    }
    for (const attribute of element.attrs) {
      if (attribute.name === 'src' || attribute.name === 'href' || attribute.name === 'poster')
        attribute.value = remoteAssetUrl(attribute.value, remoteBaseUrl)
      else if (attribute.name === 'srcset')
        attribute.value = rewriteSrcset(attribute.value, remoteBaseUrl)
    }
  })

  return rewriteRemoteTextAssetReferences(serialize(document), remoteBaseUrl, themeShort)
}

export function injectCompatibilityRuntime(html: string, themeShort: string): string {
  const document = parse(html)
  const head = findElement(document, 'head')
  const body = findElement(document, 'body')
  if (!head || !body)
    throw new Error('Theme dist/index.html must contain head and body elements')

  walkElements(document, (element) => {
    if (!ASSET_ELEMENTS.has(element.tagName))
      return
    for (const attribute of element.attrs) {
      if (attribute.name === 'src' || attribute.name === 'href' || attribute.name === 'poster')
        attribute.value = rewriteAssetUrl(attribute.value, themeShort)
    }
  })

  const alreadyInjected = head.childNodes.some(node => isElement(node)
    && node.tagName === 'script'
    && hasAttribute(node, 'data-komari-nodeget-compat'))
  if (!alreadyInjected) {
    const runtimeScript = fragmentElement('<script src="./komari-nodeget-runtime.js" data-komari-nodeget-compat data-komari-nodeget-config-base="./"></script>')
    const firstChild = head.childNodes[0]
    if (firstChild)
      defaultTreeAdapter.insertBefore(head, runtimeScript, firstChild)
    else
      defaultTreeAdapter.appendChild(head, runtimeScript)
  }

  const hasCustomStyle = head.childNodes.some(node => isElement(node)
    && node.tagName === 'link'
    && hasAttribute(node, 'href', './custom.css'))
  if (!hasCustomStyle)
    defaultTreeAdapter.appendChild(head, fragmentElement('<link rel="stylesheet" href="./custom.css">'))

  const hasCustomScript = body.childNodes.some(node => isElement(node)
    && node.tagName === 'script'
    && hasAttribute(node, 'src', './custom.js'))
  if (!hasCustomScript)
    defaultTreeAdapter.appendChild(body, fragmentElement('<script src="./custom.js" defer></script>'))

  return serialize(document)
}
