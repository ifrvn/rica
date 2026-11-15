import 'dotenv/config'
import { runNewbiPilot } from '@rica/plugin-newbi/pilot'
import { observationError, reportPluginResult } from '../apps/plugin-observation.js'
import { createDeploymentPluginStore } from '../apps/deployment-plugins.js'
import { modelSettingsDirectory } from '../packages/runtime/model-settings-store.js'
import { runtimeDatabaseUrl } from '../packages/runtime/config.js'

await runNewbiPilot({
  openNewbi(credential, endpoint) {
    return createDeploymentPluginStore(modelSettingsDirectory(runtimeDatabaseUrl())).openNewbi(credential, endpoint)
  },
}, (service, error) => reportPluginResult(process.env.REDIS_URL, service,
  error ? observationError(error, 'OPERATION_FAILED') : process.exitCode ? 'OPERATION_FAILED' : undefined))
