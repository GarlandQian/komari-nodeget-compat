import type { KomariFacade } from '../komari/facade'
import { KomariFacade as Facade } from '../komari/facade'
import { NodeGetMonitorProvider } from '../nodeget/provider'
import { publicErrorMessage } from '../shared/utils'
import { loadRuntimeConfig } from './config'
import { installWebSocketFacade } from './virtual-websocket'

export interface CompatibilityRuntimeHandle {
  version: string
  ready: Promise<void>
  close(): void
}

declare global {
  interface Window {
    __KOMARI_NODEGET_COMPAT__?: CompatibilityRuntimeHandle
  }
}

function requestFromFetchInput(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request)
    return new Request(input, init)
  return new Request(new URL(String(input), window.location.href), init)
}

function unavailableResponse(error: unknown): Response {
  return new Response(JSON.stringify({
    status: 'error',
    message: publicErrorMessage(error),
    data: null,
  }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function runtimeBaseUrl(): URL {
  const currentScript = document.currentScript
  if (currentScript instanceof HTMLScriptElement && currentScript.src)
    return new URL('.', currentScript.src)
  return new URL('.', document.baseURI)
}

export function installCompatibilityRuntime(): CompatibilityRuntimeHandle {
  if (window.__KOMARI_NODEGET_COMPAT__)
    return window.__KOMARI_NODEGET_COMPAT__

  const nativeFetch = window.fetch.bind(window)
  const baseUrl = runtimeBaseUrl()
  let facade: KomariFacade | null = null
  const facadePromise = loadRuntimeConfig(nativeFetch, baseUrl).then(({ config, manifest }) => {
    facade = new Facade(new NodeGetMonitorProvider(config, manifest))
    return facade
  })

  const compatibleFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = requestFromFetchInput(input, init)
    const url = new URL(request.url)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/'))
      return nativeFetch(input, init)
    try {
      const response = await (await facadePromise).handleHttp(request)
      return response ?? nativeFetch(input, init)
    }
    catch (error) {
      return unavailableResponse(error)
    }
  }
  window.fetch = compatibleFetch as typeof window.fetch

  const NativeWebSocket = installWebSocketFacade(window, facadePromise)
  const handle: CompatibilityRuntimeHandle = {
    version: '0.3.2',
    ready: facadePromise.then(() => undefined),
    close() {
      window.fetch = nativeFetch
      window.WebSocket = NativeWebSocket
      facade?.close()
      delete window.__KOMARI_NODEGET_COMPAT__
    },
  }
  window.__KOMARI_NODEGET_COMPAT__ = handle
  return handle
}
