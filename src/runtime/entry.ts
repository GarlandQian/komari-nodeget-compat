import { installCompatibilityRuntime } from './install'

const runtime = installCompatibilityRuntime()
runtime.ready.catch((error) => {
  console.error('[komari-nodeget-compat] Failed to initialize:', error)
})
