import { createDatabase } from '@ricajs/persistence/client'
import type { ManagementAdapter } from '@ricajs/persistence/management-http'
import { connectNewbiSettings } from '../deployment/settings.js'
import { checkNewbiReader, scopedNewbiDatabase } from '../persistence/database.js'
import { createNewbiOperations } from './operations.js'
import { createNewbiManagement } from './routes.js'

export const ricaManagement = {
  id: 'newbi',
  hostApiVersion: 1,
  async start({ databaseUrl, readDeployment, reviewReply, assessDiscussion, reportConnectorOperation }) {
    const management = createDatabase(databaseUrl, 'rica_admin_api')
    const runtime = createDatabase(databaseUrl)
    const stop = async () => { await Promise.all([management.$disconnect(), runtime.$disconnect()]) }
    try {
      await Promise.all([
        management.$queryRaw`SELECT id FROM rica_plugin_newbi.replies LIMIT 0`,
        checkNewbiReader(runtime),
        scopedNewbiDatabase(runtime, 'executor').$queryRaw`SELECT endpoint FROM public.rica_newbi_send_connection(NULL::uuid)`,
      ])
      const settings = connectNewbiSettings(readDeployment)
      const plugin = createNewbiManagement(management, settings, {
        ...createNewbiOperations(runtime, settings), reviewReply, assessDiscussion, reportConnectorOperation,
      })
      return { plugin, stop }
    } catch (error) {
      await stop()
      throw error
    }
  },
} satisfies ManagementAdapter
