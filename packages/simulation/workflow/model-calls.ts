import type { PrismaClient } from '@ricajs/persistence/prisma'

export async function recordRunModelCall(db: PrismaClient, runId: string, stage: 'DECISION' | 'WRITING' | 'REVIEW',
  model: string, systemPrompt: string,
) {
  const [record] = await db.$queryRaw<{ id: string | null }[]>`
    SELECT public.rica_record_run_model_call(${runId}::uuid, ${stage}, ${model}, ${systemPrompt}) AS id
  `
  if (!record.id) throw new Error('Run no longer accepts this model call')
  const id = record.id
  return async (output: string) => {
    await db.$queryRaw`SELECT public.rica_record_run_model_output(${runId}::uuid, ${id}::uuid, ${output.replaceAll('\0', '\uFFFD')})`
  }
}
