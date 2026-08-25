import { convertThemeArchive } from '../converter/archive'

interface ConvertRequest {
  id: number
  input: ArrayBuffer
  runtime: ArrayBuffer
}

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

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<ConvertRequest>) => void): void
  postMessage(message: ConvertSuccess | ConvertFailure, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope

scope.addEventListener('message', (event) => {
  const { id, input, runtime } = event.data
  try {
    const result = convertThemeArchive(new Uint8Array(input), {
      runtime: new Uint8Array(runtime),
    })
    const archive = result.archive.slice().buffer as ArrayBuffer
    scope.postMessage({
      id,
      ok: true,
      archive,
      warnings: result.warnings,
      sourceName: result.sourceName,
      sourceShort: result.sourceShort,
      sourceVersion: result.sourceVersion,
      outputShort: result.outputShort,
      inputFileCount: result.inputFileCount,
      outputFileCount: result.outputFileCount,
    }, [archive])
  }
  catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
