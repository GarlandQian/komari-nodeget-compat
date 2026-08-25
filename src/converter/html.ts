import type { DefaultTreeAdapterMap } from 'parse5'
import { defaultTreeAdapter, parse, parseFragment, serialize } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type ParentNode = DefaultTreeAdapterMap['parentNode']

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
  if (/^\/(favicon\.(ico|png|svg)|manifest\.webmanifest)$/.test(normalized))
    return `.${normalized}`
  return normalized
}

export function injectCompatibilityRuntime(html: string, themeShort: string): string {
  const document = parse(html)
  const head = findElement(document, 'head')
  const body = findElement(document, 'body')
  if (!head || !body)
    throw new Error('Theme dist/index.html must contain head and body elements')

  walkElements(document, (element) => {
    if (!['script', 'link', 'img', 'source', 'video', 'audio'].includes(element.tagName))
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
    const runtimeScript = fragmentElement('<script src="./komari-nodeget-runtime.js" data-komari-nodeget-compat></script>')
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
