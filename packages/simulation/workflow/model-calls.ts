import type { PrismaClient } from '@ricajs/persistence/prisma'

export async function recordRunModelCall(db: PrismaClient, runId: string, stage: 'DECISION' | 'WRITING' | 'REVIEW',
  model: string, systemPrompt: string,
) {
  const [record] = await db.$queryRaw<{ saved: boolean }[]>`
    SELECT public.rica_record_run_model_call(${runId}::uuid, ${stage}, ${model}, ${systemPrompt}) AS saved
  `
  if (!record.saved) throw new Error('Run no longer accepts this model call')
}
