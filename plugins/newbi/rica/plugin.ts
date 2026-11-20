import type { RicaPlugin } from '@ricajs/plugin-host/sdk'
import { createNewbiWorker } from './worker.js'

export const ricaPlugin = {
  id: 'newbi',
  sdkVersion: 1,
  activity: { view: 'run_activity' },
  retention: { sweep: 'sweep_retention' },
  worker: (_config, context) => createNewbiWorker(context),
  workerServices: { discussion: true },
} satisfies RicaPlugin
