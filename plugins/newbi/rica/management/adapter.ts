import { createDatabase } from '@ricajs/persistence/client'
import type { ManagementAdapter } from '@ricajs/persistence/management-http'
import { connectNewbiSettings } from '../deployment/settings.js'
import { createNewbiDatabase } from '../persistence/client.js'
import { checkNewbiReader, scopedNewbiDatabase } from '../persistence/database.js'
import { createNewbiOperations } from './operations.js'
import { createNewbiManagement } from './routes.js'

export const ricaManagement = {
  id: 'newbi',
  hostApiVersion: 1,
  async start({ databaseUrl, readDeployment, reviewReply, assessDiscussion, reportConnectorOperation }) {
    const management = createDatabase(databaseUrl, 'rica_admin_api')
    const newbi = createNewbiDatabase(databaseUrl)
    const runtime = createDatabase(databaseUrl)
    const stop = async () => { await Promise.all([management.$disconnect(), newbi.$disconnect(), runtime.$disconnect()]) }
    try {
      await Promise.all([
        newbi.reply.findFirst({ select: { id: true } }),
        checkNewbiReader(runtime),
        scopedNewbiDatabase(runtime, 'executor').$queryRaw`
          SELECT (SELECT endpoint FROM rica_plugin_newbi.send_connection(NULL::uuid)),
            rica_plugin_newbi.execution_target(NULL::uuid, NULL::text)
        `,
      ])
      const settings = connectNewbiSettings(readDeployment)
      const plugin = createNewbiManagement({ host: management, newbi }, settings, {
        ...createNewbiOperations(runtime, settings), reviewReply, assessDiscussion, reportConnectorOperation,
      })
      return { plugin, stop }
    } catch (error) {
      await stop()
      throw error
    }
  },
} satisfies ManagementAdapter
