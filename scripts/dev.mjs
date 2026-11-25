import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const targets = new Map([
  ['api', ['watch', 'apps/api/main.ts']],
  ['worker', ['watch', 'apps/worker/main.ts']],
  ['simulation', ['apps/worker/simulation.ts']],
  ['admin', ['--config', 'apps/admin/vite.config.ts']],
])
const [target, ...args] = process.argv.slice(2)
const options = targets.get(target)

if (options) {
  const cli = target === 'admin'
    ? join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')
    : require.resolve('tsx/cli')
  const result = spawnSync(process.execPath, [cli, ...options, ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  console.log('Usage: pnpm dev <api|worker|admin|simulation>')
  process.exitCode = target && target !== '--help' && target !== '-h' ? 1 : 0
}
