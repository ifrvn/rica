import { readFile } from 'node:fs/promises'
import { pluginReleaseManifest } from '../packages/contracts/plugin-status.js'
import { readPluginStatus } from '../apps/plugin-observation.js'

const [releaseUrl, ...extra] = process.argv.slice(2)
if (!releaseUrl || extra.length) {
  console.error('Usage: pnpm exec tsx scripts/plugin-release-manifest.ts <HTTPS release URL>')
  process.exit(1)
}

const { version: ricaVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const { services } = await readPluginStatus()
const components = services.flatMap(({ catalog }) => catalog.filter(({ kind, id }) =>
  kind === 'platform-reader' || kind === 'platform-reply-executor' || (kind === 'model' && id !== 'simulated')))
const manifest = pluginReleaseManifest.safeParse({ schemaVersion: 1, ricaVersion, releaseUrl, components })
if (!manifest.success) {
  console.error('Invalid HTTPS release URL or plugin catalog.')
  process.exit(1)
}
console.log(JSON.stringify(manifest.data, null, 2))
