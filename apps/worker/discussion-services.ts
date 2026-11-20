import type { AssessDiscussion } from '@ricajs/contracts/discussion-selection'
import type { PrismaClient } from '@ricajs/persistence/prisma'
import type { PluginWorkerServices } from '@ricajs/plugin-host/sdk'

export function workerDiscussionServices(db: PrismaClient, platform: string, isEnabled: () => Promise<boolean>,
  assessDiscussion: AssessDiscussion, shutdown: AbortSignal): NonNullable<PluginWorkerServices['discussion']> {
  return {
    isEnabled,
    async assess(input, profile, { characterId, identityId }, capture) {
      const activeBinding = () => db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE rica_admin_api`
        const [binding] = await tx.$queryRaw<{ active: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM public.platform_accounts a
            JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
            JOIN public.characters c ON c.id = a.character_id
            WHERE a.character_id = ${characterId}::uuid AND a.identity_id = ${identityId}::uuid AND a.platform = ${platform}
              AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
          ) AS active`
        return binding?.active === true
      })
      if (shutdown.aborted || !await isEnabled() || !await activeBinding() || shutdown.aborted) return
      return assessDiscussion(input, profile, { characterId, identityId, platform }, async (prompt, model) => {
        shutdown.throwIfAborted()
        if (!await isEnabled() || !await activeBinding()) throw new Error('Discussion model or binding is unavailable')
        shutdown.throwIfAborted()
        await capture(prompt, model)
      })
    },
  }
}
