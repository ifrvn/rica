import { randomUUID } from 'node:crypto'
import type { z } from '@hono/zod-openapi'
import type { planInput, planView } from '../contracts/plans.js'
import { Prisma, type PrismaClient } from './generated/client.js'
import { authorize, makePage, ManagementError, pageArgs, scheduleTiming, type Page, type Scope } from './management.js'

type Plan = z.infer<typeof planInput>
type Tx = Prisma.TransactionClient

export async function savePlan(tx: Tx, scope: Scope, input: Plan, edit?: { id: string; expected: number }) {
  const { characterId } = scope
  const current = edit && await tx.simulationPlan.findFirst({
    where: { id: edit.id, characterId },
    include: { participants: true },
  })
  if (edit && !current) throw new ManagementError(404, 'NOT_FOUND', 'Plan is unavailable')
  if (edit && current?.version !== edit.expected) throw new ManagementError(412, 'VERSION_CONFLICT', 'Plan version has changed')

  const accounts = await tx.platformAccount.findMany({
    where: { characterId, id: { in: input.participants.map(({ accountId }) => accountId) }, status: { not: 'REVOKED' } },
    select: { id: true, identityId: true, platform: true },
  })
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  if (input.participants.some(({ identityId, accountId }) => accountsById.get(accountId)?.identityId !== identityId)) {
    throw new ManagementError(409, 'PLAN_BINDING_CHANGED', 'Select a current platform account for each identity')
  }

  const { nextAt, ...timing } = await scheduleTiming(tx, input)
  const timingChanged = !current || current.zone !== timing.zone || current.kind !== timing.kind
    || current.localTime !== timing.localTime || current.dueAt?.getTime() !== timing.dueAt?.getTime() || current.enabled !== timing.enabled
  const plan = current
    ? await tx.simulationPlan.update({
      where: { id: current.id }, data: { ...timing, title: input.title, version: { increment: 1 } }, select: { id: true, version: true },
    })
    : await tx.simulationPlan.create({ data: { ...timing, characterId, title: input.title }, select: { id: true, version: true } })
  const previous = new Map(current ? current.participants.map((item) => [item.accountId, item]) : [])
  for (const { accountId, scheduleId, included } of previous.values()) {
    if (!included || accountsById.has(accountId)) continue
    if (scheduleId) {
      await tx.simulationSchedule.update({ where: { id: scheduleId },
        data: { enabled: false, nextAt: null, version: { increment: 1 } } })
    }
    await tx.simulationPlanParticipant.update({
      where: { planId_accountId: { planId: plan.id, accountId } }, data: { included: false },
    })
  }

  for (const { accountId, identityId, task } of input.participants) {
    const prior = previous.get(accountId)
    if (prior) {
      if (prior.scheduleId && (timingChanged || !prior.included || prior.task !== task)) {
        await tx.simulationSchedule.update({
          where: { id: prior.scheduleId }, data: {
            ...(timingChanged || !prior.included ? { ...timing, nextAt } : {}), version: { increment: 1 },
          },
        })
      }
      if (!prior.included || prior.task !== task) {
        await tx.simulationPlanParticipant.update({
          where: { planId_accountId: { planId: plan.id, accountId } }, data: { task, included: true },
        })
      }
      continue
    }
    const platform = accountsById.get(accountId)!.platform
    let scheduleId: string | undefined
    if (platform === 'mock-a' || platform === 'mock-b') {
      const [created] = await tx.$queryRaw<{ id: string | null }[]>`
        SELECT public.rica_create_plan_conversation(${characterId}::uuid, ${identityId}::uuid, ${accountId}::uuid) AS id
      `
      if (!created?.id) throw new ManagementError(409, 'PLAN_BINDING_CHANGED', 'Plan binding changed')
      const schedule = await tx.simulationSchedule.create({
        data: { ...timing, nextAt, characterId, identityId, accountId, conversationId: created.id, scheduleKey: 'plan:' + randomUUID() },
        select: { id: true },
      })
      scheduleId = schedule.id
    }
    await tx.simulationPlanParticipant.create({ data: { planId: plan.id, characterId, identityId, accountId, task, scheduleId } })
  }
  return plan
}

export async function listPlans(db: PrismaClient, scope: Scope, page: Page) {
  return db.$transaction(async (tx) => {
    await authorize(tx, scope, ['ADMIN'])
    const where = { characterId: scope.characterId }
    const args = await pageArgs(page, (id) => tx.simulationPlan.findFirst({ where: { ...where, id }, select: { id: true } }))
    const rows = await tx.simulationPlan.findMany({
      ...args, where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { participants: { where: { included: true }, orderBy: { identityId: 'asc' },
        include: { account: { select: { platform: true, status: true } }, schedule: { select: { nextAt: true } } } } },
    })
    const latest = rows.length ? await tx.$queryRaw<{ scheduleId: string; runId: string }[]>`
      SELECT * FROM public.rica_latest_plan_runs(${scope.characterId}::uuid, ARRAY[${Prisma.join(rows.map(({ id }) => id))}]::uuid[])
    ` : []
    const runs = new Map(latest.map(({ scheduleId, runId }) => [scheduleId, runId]))
    return makePage(rows, page, (plan): z.infer<typeof planView> => ({
      id: plan.id, version: plan.version, title: plan.title, zone: plan.zone, enabled: plan.enabled,
      source: plan.source === 'AI' ? 'AI' : 'MANUAL', humanEdited: plan.source === 'AI' && plan.version > 1,
      rule: plan.kind === 'DAILY' ? { kind: 'DAILY', localTime: plan.localTime! }
        : { kind: 'REMINDER', dueAt: plan.dueAt!.toISOString() },
      participants: plan.participants.map(({ identityId, accountId, task, account, scheduleId, schedule }) => ({
        identityId, accountId, task, platform: account.platform, accountStatus: account.status,
        nextAt: schedule?.nextAt?.toISOString() ?? null, lastRunId: scheduleId ? runs.get(scheduleId) ?? null : null,
      })),
    }))
  }, { isolationLevel: 'RepeatableRead' })
}

export async function setPlanEnabled(tx: Tx, scope: Scope, id: string, expected: number, enabled: boolean) {
  const current = await tx.simulationPlan.findFirst({
    where: { id, characterId: scope.characterId },
    include: { participants: { where: { included: true }, include: { account: { select: { status: true } } } } },
  })
  if (!current) throw new ManagementError(404, 'NOT_FOUND', 'Plan is unavailable')
  if (current.version !== expected) throw new ManagementError(412, 'VERSION_CONFLICT', 'Plan version has changed')
  if (current.enabled === enabled) return { id, version: current.version }
  if (enabled && current.participants.some(({ account }) => account.status === 'REVOKED')) {
    throw new ManagementError(409, 'PLAN_BINDING_CHANGED', 'Select current platform accounts before resuming')
  }
  const rule = current.kind === 'DAILY' ? { kind: 'DAILY' as const, localTime: current.localTime! }
    : { kind: 'REMINDER' as const, dueAt: current.dueAt!.toISOString() }
  const { nextAt } = await scheduleTiming(tx, { enabled, zone: current.zone, rule })
  await tx.simulationSchedule.updateMany({
    where: { characterId: scope.characterId, planParticipant: { planId: id, included: true } },
    data: { enabled, nextAt, version: { increment: 1 } },
  })
  return tx.simulationPlan.update({
    where: { id }, data: { enabled, version: { increment: 1 } }, select: { id: true, version: true },
  })
}
