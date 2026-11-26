import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { autoReviewInput, autoReviewTemplateInput, autoReviewTemplateView, autoReviewView, type AutoReviewView } from '@ricajs/contracts/auto-review'
import { commandResponse, idempotencyHeader, resourceId, versionHeader } from '@ricajs/contracts/management'
import { readAutoReviewSettings } from '@ricajs/persistence/auto-review'
import { authorize, executeManagementCommand, ManagementError } from '@ricajs/persistence/management'
import { body, character, characterParams, errors, security, success, version, type ManagementEnvironment } from '@ricajs/persistence/management-http'
import type { PrismaClient } from '@ricajs/persistence/prisma'

const identityParams = characterParams.extend({ identityId: resourceId })
const templateParams = characterParams.extend({ templateId: resourceId })
const settingsPath = `${character}/identities/{identityId}/auto-review` as const
const templatesPath = `${character}/auto-review/templates` as const

export function registerAutoReviewManagement(
  app: OpenAPIHono<ManagementEnvironment>, db: PrismaClient, reviewModel: () => Promise<AutoReviewView['model']>,
) {
  app.openapi(createRoute({
    method: 'get', path: settingsPath, security, request: { params: identityParams },
    responses: { ...errors, 200: success(autoReviewView) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const settings = await db.$transaction(async (tx) => {
      await authorize(tx, scope)
      const settings = await readAutoReviewSettings(tx, scope.characterId, scope.identityId)
      if (!settings) throw new ManagementError(404, 'NOT_FOUND', 'Identity not found')
      return settings
    }, { isolationLevel: 'RepeatableRead' })
    const model = await reviewModel().catch(() => null)
    const { prompt: _, ...view } = settings
    return c.json(autoReviewView.parse({ ...view, model }), 200)
  })

  app.openapi(createRoute({
    method: 'put', path: settingsPath, security,
    request: { params: identityParams, headers: versionHeader, body: body(autoReviewInput) },
    responses: { ...errors, 200: success(commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await executeManagementCommand(db, {
      ...scope, requestId, input, operation: 'identity.auto-review.update', targetScope: scope.identityId,
    }, async (tx) => {
      const where = { characterId: scope.characterId, id: scope.identityId }
      if (!await tx.identity.findFirst({ where, select: { id: true } })) {
        throw new ManagementError(404, 'NOT_FOUND', 'Identity not found')
      }
      if (input.templateId && !await tx.autoReviewTemplate.findFirst({
        where: { characterId: scope.characterId, id: input.templateId }, select: { id: true },
      })) throw new ManagementError(422, 'INVALID_INPUT', 'Review template is unavailable')
      const saved = await tx.identity.updateMany({
        where: { ...where, autoReviewVersion: expected },
        data: { autoReviewEnabled: input.enabled, imManualReviewEnabled: input.imManualReviewEnabled,
          autoReviewTemplateId: input.templateId, autoReviewVersion: { increment: 1 } },
      })
      if (saved.count !== 1) throw new ManagementError(412, 'STALE_VERSION', 'Review settings changed')
      return { id: scope.identityId, version: expected + 1 }
    })
    return c.json({ ...result, requestId }, 200)
  })

  app.openapi(createRoute({
    method: 'get', path: templatesPath, security, request: { params: characterParams },
    responses: { ...errors, 200: success(z.array(autoReviewTemplateView)) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const templates = await db.$transaction(async (tx) => {
      await authorize(tx, scope)
      return tx.autoReviewTemplate.findMany({
        where: { characterId: scope.characterId }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, prompt: true, version: true },
      })
    }, { isolationLevel: 'RepeatableRead' })
    return c.json(templates, 200)
  })

  app.openapi(createRoute({
    method: 'post', path: templatesPath, security,
    request: { params: characterParams, headers: idempotencyHeader, body: body(autoReviewTemplateInput) },
    responses: { ...errors, 201: success(commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const requestId = c.get('requestId')
    const result = await executeManagementCommand(db, {
      ...scope, requestId, input, operation: 'auto-review-template.create', targetScope: scope.characterId,
      key: c.req.valid('header')['idempotency-key'],
    }, (tx) => tx.autoReviewTemplate.create({ data: { ...input, characterId: scope.characterId }, select: { id: true, version: true } }))
    return c.json({ ...result, requestId }, 201)
  })

  app.openapi(createRoute({
    method: 'put', path: `${templatesPath}/{templateId}`, security,
    request: { params: templateParams, headers: versionHeader, body: body(autoReviewTemplateInput) },
    responses: { ...errors, 200: success(commandResponse) },
  }), async (c) => {
    const scope = { ...c.req.valid('param'), actor: c.get('actor') }
    const input = c.req.valid('json')
    const expected = version(c.req.valid('header'))
    const requestId = c.get('requestId')
    const result = await executeManagementCommand(db, {
      ...scope, requestId, input, operation: 'auto-review-template.update', targetScope: scope.templateId,
    }, async (tx) => {
      const where = { characterId: scope.characterId, id: scope.templateId }
      if (!await tx.autoReviewTemplate.findFirst({ where, select: { id: true } })) {
        throw new ManagementError(404, 'NOT_FOUND', 'Review template not found')
      }
      const saved = await tx.autoReviewTemplate.updateMany({
        where: { ...where, version: expected }, data: { ...input, version: { increment: 1 } },
      })
      if (saved.count !== 1) throw new ManagementError(412, 'STALE_VERSION', 'Review template changed')
      await tx.identity.updateMany({
        where: { characterId: scope.characterId, autoReviewTemplateId: scope.templateId },
        data: { autoReviewVersion: { increment: 1 } },
      })
      return { id: scope.templateId, version: expected + 1 }
    })
    return c.json({ ...result, requestId }, 200)
  })
}
