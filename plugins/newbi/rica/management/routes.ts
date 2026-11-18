import { newbiAccountHooks, saveNewbiCredential } from '../persistence/accounts.js'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import * as schema from '../../../../packages/contracts/management.js'
import * as management from '../../../../packages/persistence/management.js'
import type { PrismaClient, Prisma } from '../../../../packages/persistence/generated/client.js'
import { body, character, characterParams, error, errors, security, success, failure, type ManagementEnvironment, type ManagementPlugin } from '../../../../packages/runtime/management-http.js'
import { connectorAccountRegistration, newbiAccountCheckView, newbiAccountInput, newbiAccountPreview, newbiAccountTest, newbiClosureInput, newbiDecisionInput, newbiInboxView, newbiReplyInput, newbiReplyQuery, newbiReplySummary, newbiReviewView } from './contracts.js'
import { autoReviewNewbiReply, bindNewbiAccount, checkNewbiAccount, closeNewbiReply, createNewbiReply, decideNewbiReply, getNewbiInbox, getNewbiReply, listNewbiReplies, readNewbiConnections, readPendingDeliveries } from '../persistence/management.js'
import type { ReviewPublicReply } from '../../../../packages/contracts/auto-review.js'
import { newbiAccountProfile, newbiConnectionsView, newbiPendingDeliveries, newbiPollView, newbiReplyView, newbiSendInput, newbiSendView, newbiThreadView } from './contracts.js'
import type { newbiCatalog } from '../deployment/catalog.js'

export type NewbiManagementOptions = {
  reviewReply?: ReviewPublicReply
  identifyConnector?: (credential: string, endpoint?: string) => Promise<(z.infer<typeof newbiAccountPreview> & { endpoint: string }) | undefined>
  pollConnector?: (accountId: string) => Promise<z.infer<typeof newbiPollView> | undefined>
  sendConnector?: (replyId: string, retry: boolean) => Promise<z.infer<typeof newbiSendView>>
  reportConnectorOperation?: (service: keyof typeof newbiCatalog, succeeded: boolean) => void | Promise<void>
  readConnectorThread?: (target: Pick<z.infer<typeof newbiReplyView>, 'accountId' | 'agentId' | 'endpoint' | 'postId'>) =>
    Promise<z.infer<typeof newbiThreadView> | undefined>
}

export function createNewbiManagement(db: PrismaClient, deploymentPlugins: { readNewbi(): Promise<{ endpoint: string } | undefined>; isInstalled(): Promise<boolean> } | undefined,
  { identifyConnector, pollConnector, sendConnector, readConnectorThread, reportConnectorOperation, reviewReply }: NewbiManagementOptions): ManagementPlugin {
  async function observe<T>(service: keyof typeof newbiCatalog, run: () => Promise<T>, succeeded: (result: T) => boolean) {
    let completed = false
    try {
      const result = await run()
      completed = succeeded(result)
      return result
    } finally {
      if (reportConnectorOperation) void Promise.resolve().then(() => reportConnectorOperation(service, completed)).catch(() => {})
    }
  }

  async function newbiAvailable(endpoint: string) {
    return !deploymentPlugins || (await deploymentPlugins.readNewbi())?.endpoint === endpoint
  }
  async function requireNewbi(endpoint: string) {
    if (!await newbiAvailable(endpoint)) {
      throw new management.ManagementError(409, 'PLUGIN_STATE_CONFLICT', 'Newbi is disabled or its endpoint does not match')
    }
  }
  async function identifyNewbi(credential: string, expectedAgent?: string) {
    const account = await identifyConnector?.(credential)
    if (!account || (expectedAgent && account.agentId !== expectedAgent)) {
      throw new management.ManagementError(409, 'CONNECTOR_VERIFICATION_FAILED', 'Could not verify the Newbi account')
    }
    await requireNewbi(account.endpoint)
    return account
  }

  const verifySavedConnector = async (endpoint: string, agentId: string, tx: Prisma.TransactionClient = db) => {
    const where = { endpoint, agentId }
    const saved = await tx.newbiCredential.findUnique({ where: { endpoint_agentId: where }, select: { credential: true } })
    const profile = saved && await identifyConnector?.(saved.credential, endpoint)
    if (!profile || profile.agentId !== agentId || profile.endpoint !== endpoint) return false
    await tx.newbiCredential.updateMany({
      where: { ...where, credential: saved.credential },
      data: { username: profile.username, avatarUrl: profile.avatarUrl },
    })
    return true
  }

  async function registerAccount(tx: Prisma.TransactionClient, scope: management.Scope, input: z.infer<typeof connectorAccountRegistration>) {
    const account = await identifyNewbi(input.credential, input.agentId)
    const result = await management.registerAccount(tx, scope, { platform: 'newbi', instanceKey: account.endpoint, remoteAccountId: account.agentId })
    await saveNewbiCredential(tx, account, input.credential)
    return result
  }

  async function status(characterId: string) {
    const endpoint = (await deploymentPlugins?.readNewbi())?.endpoint
    const [newbiConnections, pendingDeliveries] = await Promise.all([
      endpoint ? readNewbiConnections(db, characterId, endpoint) : undefined,
      readPendingDeliveries(db, characterId),
    ])
    return { newbiRegistrationAvailable: !!endpoint,
      newbiConnections, newbiPendingDeliveries: pendingDeliveries }
  }

  function registerRoutes(app: OpenAPIHono<ManagementEnvironment>) {
    app.openapi(createRoute({
      method: 'post', path: `${character}/account-pool/newbi/test`, security,
      request: { params: characterParams, body: body(newbiAccountTest) },
      responses: { ...errors, 200: success(newbiAccountPreview) },
    }), async (c) => {
      const scope = { ...c.req.valid('param'), actor: c.get('actor') }
      await db.$transaction((tx) => management.authorize(tx, scope))
      c.header('Cache-Control', 'no-store')
      return c.json(newbiAccountPreview.parse(await identifyNewbi(c.req.valid('json').credential)), 200)
    })

    const newbi = `${character}/newbi` as const
    const newbiReplyParams = characterParams.extend({ replyId: schema.resourceId })
    app.openapi(createRoute({
      method: 'post', path: `${newbi}/accounts`, security,
      request: { params: characterParams, headers: schema.idempotencyHeader, body: body(newbiAccountInput) },
      responses: { ...errors, 201: success(schema.commandResponse) },
    }), async (c) => {
      const scope = { ...c.req.valid('param'), actor: c.get('actor') }
      const input = c.req.valid('json')
      const requestId = c.get('requestId')
      const result = await management.executeManagementCommand(db, {
        ...scope, operation: 'newbi.account.bind', targetScope: scope.characterId, input, requestId,
        key: c.req.valid('header')['idempotency-key'],
      }, async (tx) => {
        const account = await identifyNewbi(input.credential, input.agentId)
        const result = await bindNewbiAccount(tx, scope, { ...input, ...account })
        await saveNewbiCredential(tx, account, input.credential)
        return result
      })
      return c.json({ ...result, requestId }, 201)
    })

    app.openapi(createRoute({
      method: 'get', path: `${newbi}/replies`, security,
      request: { params: characterParams, query: newbiReplyQuery },
      responses: { ...errors, 200: success(schema.pageView(newbiReplySummary)) },
    }), async (c) => {
      const query = c.req.valid('query')
      return c.json(await listNewbiReplies(db, { ...c.req.valid('param'), actor: c.get('actor') },
        management.parsePage(query), query), 200)
    })

    app.openapi(createRoute({
      method: 'post', path: `${newbi}/replies`, security,
      request: { params: characterParams, headers: schema.idempotencyHeader, body: body(newbiReplyInput) },
      responses: { ...errors, 201: success(schema.commandResponse) },
    }), async (c) => {
      const scope = { ...c.req.valid('param'), actor: c.get('actor') }
      const input = c.req.valid('json')
      const requestId = c.get('requestId')
      let created = false
      const result = await management.executeManagementCommand(db, {
        ...scope, operation: 'newbi.reply.create', targetScope: scope.characterId, input, requestId,
        key: c.req.valid('header')['idempotency-key'],
      }, async (tx) => {
        const proposal = await createNewbiReply(tx, scope, input, requireNewbi)
        created = true
        return proposal
      })
      if (created && reviewReply && readConnectorThread) {
        await autoReviewNewbiReply(db, scope.characterId, result.id, requestId, reviewReply, readConnectorThread, requireNewbi)
          .catch(() => { console.warn(JSON.stringify({ service: 'api', event: 'newbi_auto_review_failed', requestId })) })
      }
      return c.json({ ...result, requestId }, 201)
    })

    app.openapi(createRoute({
      method: 'get', path: `${newbi}/replies/{replyId}`, security,
      request: { params: newbiReplyParams }, responses: { ...errors, 200: success(newbiReviewView) },
    }), async (c) => {
      const { characterId, replyId } = c.req.valid('param')
      const reply = await getNewbiReply(db, { characterId, actor: c.get('actor') }, replyId)
      return c.json({ ...reply, connectorAvailable: await newbiAvailable(reply.endpoint) }, 200)
    })

    app.openapi(createRoute({
      method: 'get', path: `${newbi}/replies/{replyId}/thread`, security,
      request: { params: newbiReplyParams },
      responses: { ...errors, 200: success(newbiThreadView), 503: failure },
    }), async (c) => {
      const { characterId, replyId } = c.req.valid('param')
      const { accountId, agentId, endpoint, postId } = await getNewbiReply(db, { characterId, actor: c.get('actor') }, replyId)
      await requireNewbi(endpoint)
      const thread = await readConnectorThread?.({ accountId, agentId, endpoint, postId }).catch(() => undefined)
      if (!thread) return c.json(error(c.get('requestId'), 'CONNECTOR_THREAD_UNAVAILABLE', 'Newbi discussion is unavailable'), 503)
      return c.json(newbiThreadView.parse(thread), 200)
    })

    app.openapi(createRoute({
      method: 'post', path: `${newbi}/replies/{replyId}/decision`, security,
      request: { params: newbiReplyParams, headers: schema.idempotencyHeader, body: body(newbiDecisionInput) },
      responses: { ...errors, 200: success(schema.commandResponse) },
    }), async (c) => {
      const { characterId, replyId } = c.req.valid('param')
      const scope = { characterId, actor: c.get('actor') }
      const input = c.req.valid('json')
      const requestId = c.get('requestId')
      const result = await management.executeManagementCommand(db, {
        ...scope, operation: 'newbi.reply.review', targetScope: characterId + '/' + replyId, input, requestId,
        key: c.req.valid('header')['idempotency-key'],
      }, (tx) => decideNewbiReply(tx, scope, replyId, input, requireNewbi))
      return c.json({ ...result, requestId }, 200)
    })

    app.openapi(createRoute({
      method: 'post', path: `${newbi}/replies/{replyId}/send`, security,
      request: { params: newbiReplyParams, body: body(newbiSendInput) },
      responses: { ...errors, 200: success(newbiSendView) },
    }), async (c) => {
      const { characterId, replyId } = c.req.valid('param')
      const { retry } = c.req.valid('json')
      const reply = await getNewbiReply(db, { characterId, actor: c.get('actor') }, replyId)
      const eligible = retry ? ['UNKNOWN', 'IN_FLIGHT'].includes(reply.status) : reply.status === 'READY'
      if (!eligible) throw new management.ManagementError(409, 'STATE_CONFLICT', 'Newbi reply is not eligible to send')
      await requireNewbi(reply.endpoint)
      await management.executeManagementCommand(db, {
        characterId, actor: c.get('actor'), requestId: c.get('requestId'),
        operation: retry ? 'newbi.reply.retry' : 'newbi.reply.send',
        targetScope: characterId + '/' + replyId, input: { retry },
      }, async () => ({ id: reply.id }))
      const result = await observe('connector-executor', async () =>
        newbiSendView.parse(await sendConnector?.(reply.id, retry) ?? { status: 'UNAVAILABLE' }),
      (delivery) => delivery.status === 'SENT')
      return c.json(result, 200)
    })

    app.openapi(createRoute({
      method: 'post', path: `${newbi}/replies/{replyId}/close`, security,
      request: { params: newbiReplyParams, headers: schema.idempotencyHeader, body: body(newbiClosureInput) },
      responses: { ...errors, 200: success(schema.commandResponse) },
    }), async (c) => {
      const { characterId, replyId } = c.req.valid('param')
      const scope = { characterId, actor: c.get('actor') }
      const input = c.req.valid('json')
      const requestId = c.get('requestId')
      const result = await management.executeManagementCommand(db, {
        ...scope, operation: 'newbi.reply.close', targetScope: characterId + '/' + replyId, input, requestId,
        key: c.req.valid('header')['idempotency-key'],
      }, (tx) => closeNewbiReply(tx, scope, replyId, input))
      return c.json({ ...result, requestId }, 200)
    })

    app.openapi(createRoute({
      method: 'post', path: `${newbi}/accounts/{accountId}/check`, security,
      request: { params: z.object({ characterId: schema.resourceId, accountId: schema.resourceId }) },
      responses: { ...errors, 200: success(newbiAccountCheckView) },
    }), async (c) => {
      const { characterId, accountId } = c.req.valid('param')
      const result = await checkNewbiAccount(db, { characterId, actor: c.get('actor') }, accountId, async (endpoint, agentId) => {
        await requireNewbi(endpoint)
        return verifySavedConnector(endpoint, agentId)
      })
      return c.json(result, 200)
    })

    app.openapi(createRoute({
      method: 'get', path: `${newbi}/accounts/{accountId}/events`, security,
      request: { params: z.object({ characterId: schema.resourceId, accountId: schema.resourceId }) },
      responses: { ...errors, 200: success(newbiInboxView) },
    }), async (c) => {
      const { characterId, accountId } = c.req.valid('param')
      return c.json(await getNewbiInbox(db, { characterId, actor: c.get('actor') }, accountId), 200)
    })

    app.openapi(createRoute({
      method: 'post', path: `${newbi}/accounts/{accountId}/events/poll`, security,
      request: { params: characterParams.extend({ accountId: schema.resourceId }) },
      responses: { ...errors, 200: success(newbiPollView) },
    }), async (c) => {
      const { characterId, accountId } = c.req.valid('param')
      await db.$transaction(async (tx) => {
        await management.authorize(tx, { characterId, actor: c.get('actor') })
        const account = await tx.platformAccount.findFirst({
          where: { id: accountId, characterId, platform: 'newbi' },
          select: { status: true, instanceKey: true, identity: { select: { status: true, character: { select: { status: true } } } } },
        })
        if (!account) throw new management.ManagementError(404, 'NOT_FOUND', 'Newbi account not found')
        if ([account.status, account.identity.status, account.identity.character.status].some((status) => status !== 'ACTIVE')) {
          throw new management.ManagementError(409, 'STATE_CONFLICT', 'Newbi account is inactive')
        }
        await requireNewbi(account.instanceKey)
      })
      const result = await observe('connector-reader', async () => {
        const page = await pollConnector?.(accountId)
        if (!page) throw new management.ManagementError(409, 'CONNECTOR_VERIFICATION_FAILED', 'Newbi reading is unavailable')
        return newbiPollView.parse(page)
      }, (page) => page.status === 'READ' || (page.status === 'WAITING' && !page.reason))
      return c.json(result, 200)
    })
  }

  return {
    id: 'newbi', registerRoutes,
    account: { ...newbiAccountHooks(verifySavedConnector), registration: connectorAccountRegistration,
      register: (tx, scope, input) => registerAccount(tx, scope, connectorAccountRegistration.parse(input)) },
    accountFields: { newbiProfile: newbiAccountProfile.optional() },
    workspace: { fields: { newbiInstalled: z.boolean() },
      read: async () => ({ newbiInstalled: await deploymentPlugins?.isInstalled() ?? true }) },
    status: { fields: {
      newbiRegistrationAvailable: z.boolean(), newbiConnections: newbiConnectionsView.optional(), newbiPendingDeliveries,
    }, read: status },
  }
}
