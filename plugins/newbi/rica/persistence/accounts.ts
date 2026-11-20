import { Prisma } from '@ricajs/persistence/prisma'
import { ManagementError, type PlatformAccountHooks } from '@ricajs/persistence/management'

type NewbiProfile = { username: string | null; avatarUrl: string | null }
type AccountKey = { endpoint: string; agentId: string }

export async function saveNewbiCredential(tx: Prisma.TransactionClient, account: NewbiProfile & AccountKey, credential: string) {
  const { endpoint, agentId, username, avatarUrl } = account
  await tx.$executeRaw`
    INSERT INTO rica_plugin_newbi.credentials (endpoint, agent_id, credential, username, avatar_url)
    VALUES (${endpoint}, ${agentId}::uuid, ${credential}, ${username}, ${avatarUrl})
    ON CONFLICT (endpoint, agent_id) DO UPDATE
      SET credential = EXCLUDED.credential, username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url`
}

export async function readNewbiCredential(tx: Prisma.TransactionClient, { endpoint, agentId }: AccountKey) {
  const [saved] = await tx.$queryRaw<{ credential: string }[]>`
    SELECT credential FROM rica_plugin_newbi.credentials WHERE endpoint = ${endpoint} AND agent_id = ${agentId}::uuid`
  return saved?.credential
}

export async function refreshNewbiProfile(tx: Prisma.TransactionClient, account: AccountKey & NewbiProfile, credential: string) {
  await tx.$executeRaw`
    UPDATE rica_plugin_newbi.credentials SET username = ${account.username}, avatar_url = ${account.avatarUrl}
    WHERE endpoint = ${account.endpoint} AND agent_id = ${account.agentId}::uuid AND credential = ${credential}`
}

export async function newbiProfiles(tx: Prisma.TransactionClient, accounts: { platform: string; instanceKey: string; remoteAccountId: string }[]) {
  const key = (endpoint: string, agentId: string) => JSON.stringify([endpoint, agentId])
  const requested = accounts.flatMap(({ platform, instanceKey, remoteAccountId }) =>
    platform === 'newbi' ? [{ endpoint: instanceKey, agentId: remoteAccountId }] : [])
  const rows = requested.length ? await tx.$queryRaw<(NewbiProfile & AccountKey)[]>`
    SELECT endpoint, agent_id AS "agentId", username, avatar_url AS "avatarUrl"
    FROM rica_plugin_newbi.account_profiles
    WHERE (endpoint, agent_id) IN (${Prisma.join(requested.map(({ endpoint, agentId }) => Prisma.sql`(${endpoint}, ${agentId}::uuid)`))})` : []
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
      await tx.$executeRaw`
        DELETE FROM rica_plugin_newbi.credentials WHERE endpoint = ${instanceKey} AND agent_id = ${remoteAccountId}::uuid`
    },
    async verifyResume(tx, { instanceKey, remoteAccountId }) {
      if (!await verify(instanceKey, remoteAccountId, tx)) {
        throw new ManagementError(409, 'CONNECTOR_VERIFICATION_FAILED', 'Connector read identity could not be verified')
      }
    },
  }
}
