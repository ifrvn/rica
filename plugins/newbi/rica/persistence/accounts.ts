import type { Prisma } from '../../../../packages/persistence/generated/client.js'
import { ManagementError, type PlatformAccountHooks } from '../../../../packages/persistence/management.js'

type NewbiProfile = { username: string | null; avatarUrl: string | null }

export async function saveNewbiCredential(tx: Prisma.TransactionClient, account: NewbiProfile & { endpoint: string; agentId: string }, credential: string) {
  const { endpoint, agentId, username, avatarUrl } = account
  await tx.newbiCredential.upsert({ where: { endpoint_agentId: { endpoint, agentId } },
    create: { endpoint, agentId, credential, username, avatarUrl }, update: { credential, username, avatarUrl } })
}

export async function newbiProfiles(tx: Prisma.TransactionClient, accounts: { platform: string; instanceKey: string; remoteAccountId: string }[]) {
  const key = (endpoint: string, agentId: string) => JSON.stringify([endpoint, agentId])
  const requested = accounts.flatMap(({ platform, instanceKey, remoteAccountId }) =>
    platform === 'newbi' ? [{ endpoint: instanceKey, agentId: remoteAccountId }] : [])
  const rows = requested.length ? await tx.newbiCredential.findMany({
    where: { OR: requested }, select: { endpoint: true, agentId: true, username: true, avatarUrl: true },
  }) : []
  const profiles = new Map(rows.map(({ endpoint, agentId, username, avatarUrl }) =>
    [key(endpoint, agentId), { agentId, username, avatarUrl }] as const))
  return (account: typeof accounts[number]) => account.platform === 'newbi'
    ? { newbiProfile: profiles.get(key(account.instanceKey, account.remoteAccountId))
      ?? { agentId: account.remoteAccountId, username: null, avatarUrl: null } }
    : {}
}

export function newbiAccountHooks(verify: (endpoint: string, agentId: string, tx: Prisma.TransactionClient) => Promise<boolean>): PlatformAccountHooks {
  return {
    platform: 'newbi',
    profiles: newbiProfiles,
    async remove(tx, { instanceKey, remoteAccountId }) {
      await tx.newbiCredential.deleteMany({ where: { endpoint: instanceKey, agentId: remoteAccountId } })
    },
    async verifyResume(tx, { instanceKey, remoteAccountId }) {
      if (!await verify(instanceKey, remoteAccountId, tx)) {
        throw new ManagementError(409, 'CONNECTOR_VERIFICATION_FAILED', 'Connector read identity could not be verified')
      }
    },
  }
}
