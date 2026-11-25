#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const locate = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const source = existsSync(locate('../apps/api/main.ts'))
const commands = new Map([
  ['api', '../apps/api/main'],
  ['worker', '../apps/worker/main'],
  ['simulation', '../apps/worker/simulation'],
  ['retention', '../apps/worker/retention'],
  ['admin-user', '../scripts/admin-user'],
  ['release-manifest', '../scripts/plugin-release-manifest'],
  ['migrate', '../scripts/migrate'],
])
const command = process.argv[2]
if (command === 'admin-path') {
  console.log(locate(source ? '../apps/admin/dist/' : '../admin/'))
} else if (commands.has(command)) {
  const entry = new URL(commands.get(command) + (source ? '.ts' : '.js'), import.meta.url)
  process.argv.splice(1, 2, fileURLToPath(entry))
  await import(entry.href)
} else {
  console.log('Usage: rica <api|worker|simulation|retention|admin-user|release-manifest|migrate|admin-path>')
  process.exitCode = command && command !== '--help' && command !== '-h' ? 1 : 0
}
