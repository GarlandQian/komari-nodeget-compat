import { chmod, mkdir, rm } from 'node:fs/promises'

async function buildFile(
  entrypoint: string,
  outputPath: string,
  options: { target: 'browser' | 'bun', format: 'iife' | 'esm', minify?: boolean, banner?: string },
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: options.target,
    format: options.format,
    minify: options.minify ?? false,
    sourcemap: 'external',
  })

  if (!result.success) {
    for (const log of result.logs)
      console.error(log)
    throw new Error(`Failed to build ${entrypoint}`)
  }

  const output = result.outputs.find(file => file.kind === 'entry-point')
  if (!output)
    throw new Error(`No entry-point output produced for ${entrypoint}`)

  const code = `${options.banner ?? ''}${await output.text()}`
  await Bun.write(outputPath, code)

  const sourceMap = result.outputs.find(file => file.kind === 'sourcemap')
  if (sourceMap)
    await Bun.write(`${outputPath}.map`, sourceMap)
}

async function copyFile(sourcePath: string, outputPath: string): Promise<void> {
  const source = Bun.file(sourcePath)
  if (!await source.exists())
    throw new Error(`Build input does not exist: ${sourcePath}`)
  await Bun.write(outputPath, source)
}

await rm('dist', { recursive: true, force: true })
await mkdir('dist/web/assets', { recursive: true })

await buildFile('src/runtime/entry.ts', 'dist/komari-nodeget-runtime.js', {
  target: 'browser',
  format: 'iife',
  minify: true,
})

await buildFile('src/cli.ts', 'dist/cli.js', {
  target: 'bun',
  format: 'esm',
  banner: '#!/usr/bin/env bun\n',
})

await buildFile('src/web/app.ts', 'dist/web/assets/app.js', {
  target: 'browser',
  format: 'esm',
  minify: true,
})

await buildFile('src/web/converter-worker.ts', 'dist/web/assets/converter-worker.js', {
  target: 'browser',
  format: 'esm',
  minify: true,
})

await Promise.all([
  copyFile('src/web/index.html', 'dist/web/index.html'),
  copyFile('src/web/nodeget-logo.png', 'dist/web/nodeget-logo.png'),
  copyFile('src/web/styles.css', 'dist/web/assets/styles.css'),
  copyFile('src/web/_headers', 'dist/web/_headers'),
  copyFile('src/web/robots.txt', 'dist/web/robots.txt'),
  copyFile('dist/komari-nodeget-runtime.js', 'dist/web/komari-nodeget-runtime.js'),
  copyFile('dist/komari-nodeget-runtime.js.map', 'dist/web/komari-nodeget-runtime.js.map'),
])

await chmod('dist/cli.js', 0o755)
console.log('Built runtime, converter CLI, and Cloudflare web app in dist/')
