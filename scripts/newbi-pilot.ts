import 'dotenv/config'
import { runNewbiPilot } from '@rica/plugin-newbi/pilot'
import { observationError, reportPluginResult } from '../apps/plugin-observation.js'

await runNewbiPilot((service, error) => reportPluginResult(process.env.REDIS_URL, service,
  error ? observationError(error, 'OPERATION_FAILED') : process.exitCode ? 'OPERATION_FAILED' : undefined))
