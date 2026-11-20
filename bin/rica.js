#!/usr/bin/env node
import { fileURLToPath } from 'node:url'

const locate = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const commands = new Map([
  ['api', '../apps/api/main.js'],
  ['worker', '../apps/worker/main.js'],
  ['simulation', '../apps/worker/simulation.js'],
  ['retention', '../apps/worker/retention.js'],
  ['admin-user', '../scripts/admin-user.js'],
  ['release-manifest', '../scripts/plugin-release-manifest.js'],
  ['migrate', '../scripts/migrate.js'],
])
const command = process.argv[2]
if (command === 'admin-path') {
  console.log(locate('../admin/'))
} else if (commands.has(command)) {
  const entry = new URL(commands.get(command), import.meta.url)
  process.argv.splice(1, 2, fileURLToPath(entry))
  await import(entry.href)
} else {
  console.log('Usage: rica <api|worker|simulation|retention|admin-user|release-manifest|migrate|admin-path>')
  process.exitCode = command && command !== '--help' && command !== '-h' ? 1 : 0
}
