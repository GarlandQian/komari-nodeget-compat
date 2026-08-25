import type { IconNode } from 'lucide'
import {
  Archive,
  Check,
  CircleCheck,
  CircleX,
  Copy,
  createElement,
  Download,
  ExternalLink,
  FileArchive,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Moon,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sun,
  TriangleAlert,
  UploadCloud,
  X,
} from 'lucide'

const MAX_BROWSER_INPUT_BYTES = 64 * 1024 * 1024
const CONVERSION_TIMEOUT_MS = 120_000
const BACKGROUND_REFRESH_COOLDOWN_MS = 3_000
const THEME_KEY = 'komari-nodeget-color-theme'

interface ConvertSuccess {
  id: number
  ok: true
  archive: ArrayBuffer
  warnings: string[]
  sourceName: string
  sourceShort: string
  sourceVersion: string
  outputShort: string
  inputFileCount: number
  outputFileCount: number
}

interface ConvertFailure {
  id: number
  ok: false
  error: string
}

type ConvertResponse = ConvertSuccess | ConvertFailure
type ViewState = 'empty' | 'busy' | 'error' | 'result'

interface PublicConfig {
  acg_background_enabled?: boolean
  remote_theme_enabled?: boolean
  remote_theme_repositories?: string[]
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!(value instanceof HTMLElement))
    throw new Error(`Missing UI element #${id}`)
  return value as T
}

function setIcon(id: string, icon: IconNode): void {
  const slot = element(id)
  slot.replaceChildren(createElement(icon, {
    width: 18,
    height: 18,
    'stroke-width': 2,
    'aria-hidden': 'true',
  }))
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`
}

function outputFileName(inputName: string): string {
  const stem = inputName.replace(/\.zip$/i, '') || 'komari-theme'
  return `${stem}-nodeget.zip`
}

function isZipHeader(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4)
    return false
  const bytes = new Uint8Array(buffer, 0, 4)
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

const views: Record<ViewState, HTMLElement> = {
  empty: element('empty-state'),
  busy: element('busy-state'),
  error: element('error-state'),
  result: element('result-state'),
}
const dropZone = element('drop-zone')
const fileInput = document.getElementById('file-input') as HTMLInputElement
const selectedFile = element('selected-file')
const downloadButton = document.getElementById('download-button') as HTMLAnchorElement
const backgroundMedia = element('background-media')
const backgroundRefresh = element<HTMLButtonElement>('background-refresh')
const themeToggle = element<HTMLButtonElement>('theme-toggle')
const remoteDistribution = element('remote-distribution')
const remoteRepository = document.getElementById('remote-repository') as HTMLSelectElement
const remoteThemeUrl = document.getElementById('remote-theme-url') as HTMLInputElement
const copyRemoteUrl = element<HTMLButtonElement>('copy-remote-url')
const nodeGetImportLink = document.getElementById('nodeget-import-link') as HTMLAnchorElement

let activeWorker: Worker | null = null
let activeDownloadUrl: string | null = null
let conversionId = 0
let dragDepth = 0
let lastBackgroundRefresh = 0
let backgroundAvailable = false

function setView(state: ViewState): void {
  for (const [name, view] of Object.entries(views))
    view.hidden = name !== state
}

function releaseDownload(): void {
  if (activeDownloadUrl)
    URL.revokeObjectURL(activeDownloadUrl)
  activeDownloadUrl = null
  downloadButton.removeAttribute('href')
}

function cancelConversion(): void {
  activeWorker?.terminate()
  activeWorker = null
  conversionId += 1
}

function resetConverter(): void {
  cancelConversion()
  releaseDownload()
  fileInput.value = ''
  selectedFile.hidden = true
  element('selected-file-name').textContent = ''
  element('selected-file-size').textContent = ''
  element('warning-list').replaceChildren()
  setView('empty')
  dropZone.focus()
}

function showSelectedFile(file: File, state: string): void {
  selectedFile.hidden = false
  element('selected-file-name').textContent = file.name
  element('selected-file-size').textContent = formatBytes(file.size)
  element('selected-file-state').textContent = state
}

function runtimeBytes(): Promise<Uint8Array> {
  return fetch(new URL('../komari-nodeget-runtime.js', import.meta.url), { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok)
        throw new Error(`兼容运行时加载失败（HTTP ${response.status}）`)
      return response.arrayBuffer()
    })
    .then(buffer => new Uint8Array(buffer))
}

function convertInWorker(input: ArrayBuffer, runtime: ArrayBuffer, id: number): Promise<ConvertSuccess> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./converter-worker.js', import.meta.url), { type: 'module' })
    activeWorker = worker
    const timeout = window.setTimeout(() => {
      worker.terminate()
      if (activeWorker === worker)
        activeWorker = null
      reject(new Error('转换超时，请检查主题包大小或结构'))
    }, CONVERSION_TIMEOUT_MS)

    worker.addEventListener('message', (event: MessageEvent<ConvertResponse>) => {
      if (event.data.id !== id)
        return
      window.clearTimeout(timeout)
      worker.terminate()
      if (activeWorker === worker)
        activeWorker = null
      if (event.data.ok)
        resolve(event.data)
      else
        reject(new Error(event.data.error))
    })
    worker.addEventListener('error', (event) => {
      window.clearTimeout(timeout)
      worker.terminate()
      if (activeWorker === worker)
        activeWorker = null
      reject(new Error(event.message || '浏览器转换线程异常'))
    })
    worker.postMessage({ id, input, runtime }, [input, runtime])
  })
}

function renderResult(file: File, result: ConvertSuccess): void {
  const archiveBlob = new Blob([result.archive], { type: 'application/zip' })
  activeDownloadUrl = URL.createObjectURL(archiveBlob)
  downloadButton.href = activeDownloadUrl
  downloadButton.download = outputFileName(file.name)

  element('result-name').textContent = result.sourceName
  element('result-version').textContent = result.sourceVersion
  element('result-short').textContent = result.outputShort
  element('result-files').textContent = `${result.inputFileCount} → ${result.outputFileCount}`
  element('result-size').textContent = formatBytes(result.archive.byteLength)

  const warningsPanel = element('warnings-panel')
  const warningList = element('warning-list')
  warningList.replaceChildren()
  warningsPanel.hidden = result.warnings.length === 0
  element('warning-count').textContent = String(result.warnings.length)
  for (const warning of result.warnings) {
    const item = document.createElement('li')
    item.textContent = warning
    warningList.append(item)
  }

  showSelectedFile(file, '转换完成')
  setView('result')
}

function showError(message: string): void {
  element('error-message').textContent = message
  element('selected-file-state').textContent = '转换失败'
  setView('error')
}

async function processFile(file: File): Promise<void> {
  cancelConversion()
  releaseDownload()
  const id = ++conversionId
  showSelectedFile(file, '检查中')
  setView('busy')
  element('busy-message').textContent = '正在检查主题包结构'

  try {
    if (!file.name.toLowerCase().endsWith('.zip'))
      throw new Error('请选择 ZIP 格式的 Komari 主题包')
    if (file.size === 0)
      throw new Error('主题包为空')
    if (file.size > MAX_BROWSER_INPUT_BYTES)
      throw new Error(`主题包超过 ${formatBytes(MAX_BROWSER_INPUT_BYTES)} 的浏览器转换限制`)

    const [input, runtime] = await Promise.all([file.arrayBuffer(), runtimeBytes()])
    if (id !== conversionId)
      return
    if (!isZipHeader(input))
      throw new Error('文件不是有效的 ZIP 主题包')

    showSelectedFile(file, '转换中')
    element('busy-message').textContent = '正在生成 NodeGet 兼容主题包'
    const result = await convertInWorker(input, runtime.slice().buffer as ArrayBuffer, id)
    if (id !== conversionId)
      return
    renderResult(file, result)
  }
  catch (error) {
    if (id !== conversionId)
      return
    showError(error instanceof Error ? error.message : String(error))
  }
}

function selectedUpload(): void {
  fileInput.click()
}

function firstDroppedFile(event: DragEvent): File | null {
  return event.dataTransfer?.files.item(0) ?? null
}

function updateThemeIcon(): void {
  const dark = document.documentElement.dataset.theme === 'dark'
  setIcon('icon-theme', dark ? Sun : Moon)
  themeToggle.setAttribute('aria-label', dark ? '切换到浅色' : '切换到深色')
  themeToggle.title = dark ? '切换到浅色' : '切换到深色'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111715' : '#f4f7f5')
}

function initializeTheme(): void {
  const saved = localStorage.getItem(THEME_KEY)
  const dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  updateThemeIcon()
}

function updateBackgroundControls(): void {
  backgroundRefresh.hidden = !backgroundAvailable
  element('background-attribution').hidden = !backgroundAvailable
  backgroundRefresh.disabled = !backgroundAvailable
}

function validRepository(value: string): boolean {
  const [owner, repo, ...extra] = value.split('/')
  return extra.length === 0
    && /^[A-Za-z0-9_.-]+$/.test(owner ?? '')
    && /^[A-Za-z0-9_.-]+$/.test(repo ?? '')
}

function updateRemoteUrl(): void {
  const repository = remoteRepository.value
  if (!validRepository(repository)) {
    remoteThemeUrl.value = ''
    nodeGetImportLink.removeAttribute('href')
    return
  }
  const [owner, repo] = repository.split('/') as [string, string]
  const themeUrl = new URL(`/themes/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/latest`, location.origin).href
  remoteThemeUrl.value = themeUrl
  nodeGetImportLink.href = `https://dash.nodeget.com/#/dashboard/theme-management?add=${encodeURIComponent(themeUrl)}`
}

function initializeRemoteDistribution(config: PublicConfig): void {
  const repositories = config.remote_theme_enabled
    ? (config.remote_theme_repositories ?? []).filter(validRepository)
    : []
  remoteRepository.replaceChildren()
  for (const repository of repositories) {
    const option = document.createElement('option')
    option.value = repository
    option.textContent = repository
    remoteRepository.append(option)
  }
  remoteDistribution.hidden = repositories.length === 0
  if (repositories.length > 0)
    updateRemoteUrl()
}

async function initializePublicFeatures(): Promise<void> {
  let config: PublicConfig = {}
  try {
    const response = await fetch('/api/config', { cache: 'no-store' })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
    config = await response.json() as PublicConfig
    backgroundAvailable = config.acg_background_enabled === true
  }
  catch {
    backgroundAvailable = false
  }

  initializeRemoteDistribution(config)
  updateBackgroundControls()
  if (backgroundAvailable)
    refreshBackground()
}

async function copyRemoteThemeUrl(): Promise<void> {
  if (!remoteThemeUrl.value)
    return
  try {
    await navigator.clipboard.writeText(remoteThemeUrl.value)
  }
  catch {
    remoteThemeUrl.focus()
    remoteThemeUrl.select()
    document.execCommand('copy')
  }
  setIcon('icon-copy-remote', Check)
  copyRemoteUrl.title = '已复制'
  copyRemoteUrl.setAttribute('aria-label', '已复制主题地址')
  window.setTimeout(() => {
    setIcon('icon-copy-remote', Copy)
    copyRemoteUrl.title = '复制主题地址'
    copyRemoteUrl.setAttribute('aria-label', '复制主题地址')
  }, 1_500)
}

function backgroundEndpoint(): string {
  const portrait = window.innerHeight > window.innerWidth
  return `https://api.yppp.net/${portrait ? 'pe.php' : 'pc.php'}?komari-nodeget=${Date.now()}`
}

function refreshBackground(): void {
  if (!backgroundAvailable)
    return
  const now = Date.now()
  if (now - lastBackgroundRefresh < BACKGROUND_REFRESH_COOLDOWN_MS)
    return
  lastBackgroundRefresh = now
  backgroundRefresh.disabled = true
  backgroundMedia.classList.remove('ready')
  const url = backgroundEndpoint()
  const preload = new window.Image()
  preload.referrerPolicy = 'no-referrer'
  preload.addEventListener('load', () => {
    if (!backgroundAvailable)
      return
    backgroundMedia.style.backgroundImage = `url("${url}")`
    backgroundMedia.classList.add('ready')
  }, { once: true })
  preload.addEventListener('error', () => {
    backgroundMedia.classList.remove('ready')
  }, { once: true })
  preload.src = url
  window.setTimeout(() => {
    backgroundRefresh.disabled = !backgroundAvailable
  }, BACKGROUND_REFRESH_COOLDOWN_MS)
}

setIcon('icon-shield', ShieldCheck)
setIcon('icon-background-refresh', RefreshCw)
setIcon('icon-upload', UploadCloud)
setIcon('icon-file', FileArchive)
setIcon('icon-lock', LockKeyhole)
setIcon('icon-empty', Archive)
setIcon('icon-loader', LoaderCircle)
setIcon('icon-cancel', X)
setIcon('icon-error', CircleX)
setIcon('icon-error-reset', RotateCcw)
setIcon('icon-success', CircleCheck)
setIcon('icon-check-manifest', Check)
setIcon('icon-check-runtime', Check)
setIcon('icon-check-token', Check)
setIcon('icon-warning', TriangleAlert)
setIcon('icon-reset', RotateCcw)
setIcon('icon-download', Download)
setIcon('icon-remote-link', Link2)
setIcon('icon-copy-remote', Copy)
setIcon('icon-open-nodeget', ExternalLink)
setIcon('icon-remote-update', RefreshCw)
initializeTheme()
updateBackgroundControls()
void initializePublicFeatures()

dropZone.addEventListener('click', selectedUpload)
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectedUpload()
  }
})
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.item(0)
  if (file)
    void processFile(file)
})

for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  document.addEventListener(eventName, event => event.preventDefault())
}
dropZone.addEventListener('dragenter', () => {
  dragDepth += 1
  dropZone.classList.add('dragging')
})
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0)
    dropZone.classList.remove('dragging')
})
dropZone.addEventListener('drop', (event) => {
  dragDepth = 0
  dropZone.classList.remove('dragging')
  const file = firstDroppedFile(event)
  if (file)
    void processFile(file)
})

element('cancel-button').addEventListener('click', resetConverter)
element('error-reset-button').addEventListener('click', resetConverter)
element('reset-button').addEventListener('click', resetConverter)
themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  updateThemeIcon()
})
backgroundRefresh.addEventListener('click', refreshBackground)
remoteRepository.addEventListener('change', updateRemoteUrl)
copyRemoteUrl.addEventListener('click', () => void copyRemoteThemeUrl())
