import { open } from 'node:fs/promises'
import { deploymentPlugins } from './deployment-plugin-contracts.js'
import { pluginReleaseManifest, type PluginMetadata, type PluginReleaseView, type PluginService } from '../packages/contracts/plugin-status.js'

type ServiceCatalog = { service: PluginService; catalog: PluginMetadata[] }
const maxManifestBytes = 64 * 1024

function compareVersions(a: string, b: string) {
  const [major, minor, patch] = a.split('.').map(Number)
  const [otherMajor, otherMinor, otherPatch] = b.split('.').map(Number)
  return major - otherMajor || minor - otherMinor || patch - otherPatch
}

async function readManifest(path: string) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxManifestBytes) throw new Error('Invalid release manifest file')
    const bytes = await file.readFile()
    if (bytes.length > maxManifestBytes) throw new Error('Release manifest is too large')
    return pluginReleaseManifest.parse(JSON.parse(bytes.toString('utf8')))
  } finally {
    await file.close()
  }
}

export async function readPluginRelease(path: string | undefined, services: ServiceCatalog[]): Promise<PluginReleaseView> {
  if (!path) return { status: 'UNCONFIGURED' }
  try {
    const manifest = await readManifest(path)
    const upgrades: Extract<PluginReleaseView, { status: 'AVAILABLE' }>['upgrades'] = []
    const aligned: typeof upgrades = []
    for (const { id, ownsComponent } of deploymentPlugins) {
      const deployed = services.flatMap(({ service, catalog }) => catalog.filter((component) => ownsComponent(service, component))
        .map((current) => ({ service, current })))
      const components = deployed.map(({ service, current }) => {
        const target = manifest.components.find((item) => item.id === current.id && item.kind === current.kind) ?? null
        const problem = !target ? 'MISSING_COMPONENT'
          : target.contractVersion !== current.contractVersion ? 'INCOMPATIBLE_CONTRACT'
            : compareVersions(target.version, current.version) < 0 ? 'DOWNGRADE' : null
        return { service, current, target, problem } as const
      })
      if (!components.length) continue
      if (components.some(({ target, current }) => !target
        || target.version !== current.version || target.contractVersion !== current.contractVersion)) upgrades.push({ id, components })
      else aligned.push({ id, components })
    }
    return { status: 'AVAILABLE', ricaVersion: manifest.ricaVersion, releaseUrl: manifest.releaseUrl, upgrades, aligned }
  } catch {
    return { status: 'UNAVAILABLE' }
  }
}
