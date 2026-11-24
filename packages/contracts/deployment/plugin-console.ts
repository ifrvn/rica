import { z } from '@hono/zod-openapi'

const path = z.string().max(120).regex(/^\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/)
const field = z.strictObject({
  key: z.string().max(40).regex(/^[a-z][a-zA-Z0-9]*$/).refine(key => key !== 'constructor' && key !== 'prototype'),
  label: z.string().trim().min(1).max(60),
  kind: z.enum(['text', 'secret']),
})
export const pluginConsole = z.strictObject({
  title: z.string().trim().min(1).max(80),
  summaryPath: path.optional(),
  accountDetailPath: path.optional(),
  accountFields: z.array(field).max(12).refine(fields => new Set(fields.map(({ key }) => key)).size === fields.length).optional(),
})
export const pluginConsoleEntry = pluginConsole.extend({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
})
export const pluginConsoleContent = z.strictObject({
  fields: z.array(z.strictObject({ label: z.string().max(80), value: z.string().max(2000) })).max(20),
})
export type PluginConsole = z.infer<typeof pluginConsole>
export type PluginConsoleEntry = z.infer<typeof pluginConsoleEntry>
