import { z } from '@hono/zod-openapi'
import type { PluginStage } from '@ricajs/contracts/deployment-plugins'
import { newbiEndpoint } from '../../agent-api/connection.js'
import type { NewbiConnectionStore } from '../persistence/database.js'

const newbiDeploymentChange = z.strictObject({ action: z.literal('CONFIGURE_NEWBI'), endpoint: newbiEndpoint, backgroundAssessments: z.boolean().optional() })
const newbiStoredConfig = newbiDeploymentChange.omit({ action: true })
const newbiConfigView = z.object({ endpoint: z.string().nullable(), backgroundAssessments: z.boolean().optional() })

export type NewbiDeploymentView = { plugins: { newbi: PluginStage }; newbi: z.infer<typeof newbiConfigView> }

export function createNewbiSettings(readConfig: () => Promise<{ installed: boolean; endpoint?: string; backgroundAssessments?: boolean }>) {
  async function readNewbi() {
    const { endpoint } = await readConfig()
    return endpoint ? { endpoint } : undefined
  }

  async function readBackground() {
    const { endpoint, backgroundAssessments } = await readConfig()
    return backgroundAssessments ? endpoint : undefined
  }

  async function openNewbi(credential: string, expectedEndpoint?: string) {
    const current = await readNewbi()
    if (!current || (expectedEndpoint && expectedEndpoint !== current.endpoint)) return
    return {
      connection: { endpoint: current.endpoint, credential },
      async beforeRequest() {
        const latest = await readNewbi()
        if (latest?.endpoint !== current.endpoint) {
          throw new Error('Newbi configuration changed')
        }
      },
    }
  }

  return { readNewbi, readBackground, openNewbi, async isInstalled() { return (await readConfig()).installed } } satisfies NewbiConnectionStore & {
    readNewbi(): Promise<{ endpoint: string } | undefined>; readBackground(): Promise<string | undefined>; isInstalled(): Promise<boolean>
  }
}

export const newbiConfiguration = {
  id: 'newbi',
  change: newbiDeploymentChange,
  stored: newbiStoredConfig,
  public: newbiConfigView,
  view(config?: z.infer<typeof newbiStoredConfig>) {
    return { endpoint: config?.endpoint ?? null, backgroundAssessments: config?.backgroundAssessments }
  },
  apply({ endpoint, backgroundAssessments }: z.infer<typeof newbiDeploymentChange>) { return { endpoint, backgroundAssessments } },
  connect(read: () => Promise<{ stage?: PluginStage; config?: z.infer<typeof newbiStoredConfig> }>) {
    return createNewbiSettings(async () => {
      const { stage, config } = await read()
      return { installed: stage === 'ENABLED' || stage === 'INSTALLED', endpoint: stage === 'ENABLED' ? config?.endpoint : undefined,
        backgroundAssessments: config?.backgroundAssessments }
    })
  },
} as const

export function connectNewbiSettings(read: (id: string) => Promise<{ stage?: PluginStage; config: unknown }>) {
  return newbiConfiguration.connect(async () => {
    const { stage, config } = await read(newbiConfiguration.id)
    return { stage, config: newbiConfiguration.stored.optional().parse(config) }
  })
}
