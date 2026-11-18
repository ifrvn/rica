import type { PrismaClient } from '../../../../packages/persistence/generated/client.js'
import type { RecordHostedUsage } from '../../providers/usage.js'
import { usageView, type UsageQuery, type UsageRow } from '../management/usage-contracts.js'

export function hostedUsageRecorder(db: Pick<PrismaClient, '$executeRaw'>): RecordHostedUsage {
  return async ({ day, provider, model, attribution, purpose, outcome, sentBytes, receivedBytes, elapsedMs, tokens }) => {
    await db.$executeRaw`
      SELECT public.rica_record_hosted_model_usage(${day}::date, ${provider}, ${model},
        ${attribution?.characterId ?? ''}, ${attribution?.identityId ?? ''}, ${attribution?.platform ?? ''}, ${purpose}, ${outcome},
        ${sentBytes}::bigint, ${receivedBytes}::bigint, ${elapsedMs}::bigint,
        ${tokens?.inputTokens ?? null}::bigint, ${tokens?.outputTokens ?? null}::bigint, ${tokens?.totalTokens ?? null}::bigint)
    `
  }
}

const counters = ['requests', 'tokenReports', 'sentBytes', 'receivedBytes', 'elapsedMs', 'inputTokens', 'outputTokens', 'totalTokens'] as const
type Counter = typeof counters[number]

export async function readHostedUsage(db: Pick<PrismaClient, '$queryRaw'>, { from, through }: UsageQuery) {
  const rows = await db.$queryRaw<(Omit<UsageRow, Counter> & Record<Counter, bigint>)[]>`
    SELECT to_char(u.day, 'YYYY-MM-DD') AS day, u.provider, u.model, u.character_id AS "characterId", u.identity_id AS "identityId", u.platform,
      coalesce(nullif(cv.hard_profile->>'name', ''), c.slug, u.character_id) AS character,
      coalesce(nullif(iv.role_profile->>'displayName', ''), i.slug, u.identity_id) AS identity,
      u.purpose, u.outcome, u.requests, u.token_reports AS "tokenReports", u.sent_bytes AS "sentBytes",
      u.received_bytes AS "receivedBytes", u.elapsed_ms AS "elapsedMs", u.input_tokens AS "inputTokens",
      u.output_tokens AS "outputTokens", u.total_tokens AS "totalTokens"
    FROM public.hosted_model_usage_daily u
    LEFT JOIN public.characters c ON c.id = nullif(u.character_id, '')::uuid
    LEFT JOIN public.identities i ON i.character_id = c.id AND i.id = nullif(u.identity_id, '')::uuid
    LEFT JOIN public.core_versions cv ON (cv.character_id, cv.version) = (c.id, c.active_core_version)
    LEFT JOIN public.identity_versions iv ON (iv.character_id, iv.identity_id, iv.version) = (i.character_id, i.id, i.active_version)
    WHERE u.day BETWEEN ${from}::date AND ${through}::date
    ORDER BY u.day, u.provider, u.model, u.character_id, u.identity_id, u.platform, u.purpose, u.outcome
  `
  return usageView.parse({ rows: rows.map(row => ({ ...row,
    ...Object.fromEntries(counters.map(key => [key, Number(row[key])])) })) })
}
