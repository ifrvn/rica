import type { RicaPlugin } from '@ricajs/plugin-host/sdk'

export const ricaPlugin = {
  id: 'newbi',
  sdkVersion: 1,
  activity: { view: 'run_activity' },
  retention: { sweep: 'sweep_retention' },
} satisfies RicaPlugin
