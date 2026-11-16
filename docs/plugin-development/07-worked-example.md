# 7. 从零实现并验证一个管理插件

这个示例实现 `/v1/characters/{characterId}/demo-echo/preview`。请求接受一条测试消息，响应返回去掉首尾空白的文本。插件还贡献一个状态字段。它适合用来验证新包的工作区依赖、认证、角色权限、输入校验和 OpenAPI 装配。

## 建包

新建 `plugins/demo-echo/package.json`。根目录 `package.json` 的 `dependencies` 也加入 `"@rica/plugin-demo-echo": "workspace:*"`。然后在仓库根目录执行 `pnpm install`，提交实际生成的锁文件。

```json
{
  "name": "@rica/plugin-demo-echo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./index.ts",
  "dependencies": {
    "@hono/zod-openapi": "^1.6.3"
  }
}
```

## 实现后端

创建 `plugins/demo-echo/index.ts`。这里的 `db` 由启动入口传入。预览操作只读取角色授权。

```ts
import { createRoute, z } from '@hono/zod-openapi'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { authorize } from '../../packages/persistence/management.js'
import {
  body, character, characterParams, errors, security, success,
  type ManagementPlugin,
} from '../../packages/runtime/management-http.js'

const previewInput = z.strictObject({ text: z.string().trim().min(1).max(200) })
const previewOutput = z.object({ preview: z.string() })

export function createDemoEcho(db: PrismaClient): ManagementPlugin {
  return {
    id: 'demo-echo',
    registerRoutes(app) {
      app.openapi(createRoute({
        method: 'post',
        path: `${character}/demo-echo/preview`,
        security,
        request: { params: characterParams, body: body(previewInput) },
        responses: { ...errors, 200: success(previewOutput) },
      }), async (c) => {
        const scope = { ...c.req.valid('param'), actor: c.get('actor') }
        await db.$transaction((tx) => authorize(tx, scope))
        return c.json({ preview: c.req.valid('json').text }, 200)
      })
    },
    status: {
      fields: { demoEchoReady: z.boolean() },
      async read() { return { demoEchoReady: true } },
    },
  }
}
```

在 `apps/api/main.ts` 增加 `import { createDemoEcho } from '@rica/plugin-demo-echo'`，再将 `createDemoEcho(managementDb)` 加到 `createManagementApp({ ..., plugins: [...] })` 的列表。管理 API 启用时，宿主会把插件路由挂在 `/v1` 下。

## 发请求

在 [PowerShell 会话](03-management.md#建立-powershell-会话)中执行：

```powershell
Invoke-Rica Post "$ricaCharacter/demo-echo/preview" -Body @{ text = '  活动报名已开放。  ' }
(Invoke-Rica Get "$ricaCharacter/plugins").demoEchoReady
```

第一条响应为 HTTP 200 和 `{ "preview": "活动报名已开放。" }`。第二条读到 `true`。`text` 缺失、去空白后为空、长度超过 200 或出现额外字段时返回 422。缺少该角色管理员授权的调用者收到 404。

## 加一条接入测试

创建 `plugins/demo-echo/management.test.ts`。测试通过假的数据库事务提供角色记录，实际走宿主校验与路由。它可以直接用 `pnpm exec tsx --test plugins/demo-echo/management.test.ts` 运行。

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { createManagementApp } from '../../apps/api/management.js'
import type { PrismaClient } from '../../packages/persistence/generated/client.js'
import { createDemoEcho } from './index.js'

test('echo preview requires an authenticated role administrator', async () => {
  const origin = 'http://localhost:5173'
  const characterId = '10000000-0000-4000-8000-000000000001'
  const db = {
    $transaction(read: (tx: object) => unknown) {
      return read({
        managementMembership: {
          async findUnique({ where }: { where: { characterId_issuer_subject: { subject: string } } }) {
            return where.characterId_issuer_subject.subject === 'admin' ? { subject: 'admin' } : null
          },
        },
      })
    },
  } as unknown as PrismaClient
  const app = createManagementApp({
    db, origin, cookie: 'demo-session', resolveAdapter: () => undefined,
    async authenticate(request) {
      const subject = request.headers.get('Cookie')?.split('=')[1]
      return subject ? { id: subject, issuer: 'fixture', subject } : null
    },
    plugins: [createDemoEcho(db)],
  })
  const base = '/characters/' + characterId
  const preview = (text: string, subject?: string) => app.request(base + '/demo-echo/preview', {
    method: 'POST',
    headers: {
      Origin: origin, 'Content-Type': 'application/json',
      ...(subject ? { Cookie: 'demo-session=' + subject } : {}),
    },
    body: JSON.stringify({ text }),
  })

  assert.equal((await preview('hi')).status, 401)
  assert.equal((await preview('hi', 'nonmember')).status, 404)
  assert.equal((await preview('  ', 'admin')).status, 422)
  const response = await preview('  hi  ', 'admin')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { preview: 'hi' })

  const status = await app.request(base + '/plugins', { headers: { Cookie: 'demo-session=admin' } })
  assert.equal(status.status, 200)
  assert.equal((await status.json()).demoEchoReady, true)
})
```

示例只注册管理能力。若还需要插件中心启停，使用[部署贡献](03-management.md#部署与配置存储)登记部署项，并在业务路由调用宿主注入的启用状态查询。需要界面时，使用[控制台组件契约](05-console.md)增加卡片与编辑器。
