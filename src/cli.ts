import { existsSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import process from 'node:process'
import { convertThemeArchive } from './converter/archive'

interface CliOptions {
  input: string
  output: string
  runtime: string
  force: boolean
}

function usage(): string {
  return `Usage: komari-nodeget-convert <komari-theme.zip> [-o output.zip] [--runtime runtime.js] [--force]

Converts a Komari public theme package into a NodeGet compatibility package.`
}

function defaultRuntimePath(): string {
  const candidates = [
    resolve(import.meta.dir, 'komari-nodeget-runtime.js'),
    resolve(import.meta.dir, '../dist/komari-nodeget-runtime.js'),
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

function outputName(input: string): string {
  const extension = extname(input)
  const stem = basename(input, extension)
  return resolve(dirname(input), `${stem}-nodeget.zip`)
}

function parseArgs(args: string[]): CliOptions | null {
  if (args.includes('-h') || args.includes('--help'))
    return null
  let input = ''
  let output = ''
  let runtime = ''
  let force = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '-o' || argument === '--output') {
      output = args[++index] ?? ''
      continue
    }
    if (argument === '--runtime') {
      runtime = args[++index] ?? ''
      continue
    }
    if (argument === '--force') {
      force = true
      continue
    }
    if (argument.startsWith('-'))
      throw new Error(`Unknown option: ${argument}`)
    if (input)
      throw new Error(`Unexpected argument: ${argument}`)
    input = argument
  }
  if (!input)
    throw new Error('Missing input Komari theme ZIP')
  return {
    input: resolve(input),
    output: resolve(output || outputName(input)),
    runtime: resolve(runtime || defaultRuntimePath()),
    force,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    console.log(usage())
    return
  }
  if (!existsSync(options.input))
    throw new Error(`Input theme not found: ${options.input}`)
  if (!existsSync(options.runtime))
    throw new Error(`Runtime bundle not found: ${options.runtime}. Run bun run build first.`)
  if (existsSync(options.output) && !options.force)
    throw new Error(`Output already exists: ${options.output}. Pass --force to replace it.`)

  const [input, runtime] = await Promise.all([
    Bun.file(options.input).bytes(),
    Bun.file(options.runtime).bytes(),
  ])
  const result = convertThemeArchive(input, { runtime })
  await Bun.write(options.output, result.archive)
  console.log(`Converted ${result.sourceShort} -> ${result.outputShort}`)
  console.log(`Wrote ${options.output}`)
  for (const warning of result.warnings)
    console.warn(`Warning: ${warning}`)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage())
  process.exitCode = 1
})
