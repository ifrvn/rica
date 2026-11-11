import type { z } from '@hono/zod-openapi'
import type { accountView, characterWorkspaceView, identityView } from '../../../../../packages/contracts/management.js'

type Account = z.infer<typeof accountView>
type Identity = z.infer<typeof identityView>
type Character = Pick<z.infer<typeof characterWorkspaceView>, 'status' | 'simulationPlatforms'>

export function simulationAccounts(character: Character | undefined, identities: Identity[], accounts: Account[]) {
  if (character?.status !== 'ACTIVE') return []
  const activeIdentities = new Set(identities.filter(({ status }) => status === 'ACTIVE').map(({ id }) => id))
  return accounts.filter((account) => account.status === 'ACTIVE' && activeIdentities.has(account.identityId)
    && character.simulationPlatforms.some((platform) => platform === account.platform))
}
