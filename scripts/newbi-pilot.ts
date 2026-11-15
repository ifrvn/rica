import 'dotenv/config'
import { runNewbiPilot } from '@rica/plugin-newbi/pilot'
import { connectNewbiSettings } from '@rica/plugin-newbi/settings'
import { observationError, reportPluginResult } from '../apps/plugin-observation.js'
import { createDeploymentPluginStore } from '../apps/deployment-plugins.js'
import { modelSettingsDirectory } from '../packages/runtime/settings-directory.js'
import { runtimeDatabaseUrl } from '../packages/runtime/config.js'

await runNewbiPilot({
  openNewbi(credential, endpoint) {
    const store = createDeploymentPluginStore(modelSettingsDirectory(runtimeDatabaseUrl()))
    return connectNewbiSettings(store.readConfiguration).openNewbi(credential, endpoint)
  },
}, (service, error) => reportPluginResult(process.env.REDIS_URL, service,
  error ? observationError(error, 'OPERATION_FAILED') : process.exitCode ? 'OPERATION_FAILED' : undefined))
