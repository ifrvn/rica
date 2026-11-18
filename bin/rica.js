#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const locate = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const commands = new Map([
  ['api', '../apps/api/main.js'],
  ['worker', '../apps/worker/main.js'],
  ['simulation', '../apps/worker/simulation.js'],
  ['retention', '../apps/worker/retention.js'],
  ['admin-user', '../scripts/admin-user.js'],
  ['release-manifest', '../scripts/plugin-release-manifest.js'],
])
const [command, ...args] = process.argv.slice(2)
if (command === 'admin-path') {
  console.log(locate('../admin/'))
} else if (command === 'migrate') {
  const manifest = createRequire(import.meta.url).resolve('prisma/package.json')
  const prisma = resolve(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.prisma)
  const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--config', locate('../prisma.config.js'), ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else if (commands.has(command)) {
  const entry = new URL(commands.get(command), import.meta.url)
  process.argv.splice(1, 2, fileURLToPath(entry))
  await import(entry.href)
} else {
  console.log('Usage: rica <api|worker|simulation|retention|admin-user|release-manifest|migrate|admin-path>')
  process.exitCode = command && command !== '--help' && command !== '-h' ? 1 : 0
}
