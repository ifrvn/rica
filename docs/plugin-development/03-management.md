# 3. 管理契约、宿主 API 与请求示例

[管理插件](#managementplugin) · [路由与事务](#路由事务与错误助手) · [HTTP 请求约定](#请求约定) · [部署配置](#部署与配置存储) · [进程状态](#进程状态报告) · [平台账号](#平台账号生命周期)

本章记录宿主管理 HTTP 与内置插件装配。第三方管理读取、写命令和账号扩展见[包 SDK](08-package-sdk.md)。

## 挂载管理 API

在插件包导出返回 [`ManagementPlugin`](../../packages/persistence/management/http.ts) 的工厂，由 [API 启动入口](../../apps/api/main.ts)传入已装配的数据库、连接配置和授权函数。工厂返回稳定的 `id` 与 `registerRoutes(app)`。插件使用 `app.openapi` 声明输入、响应和错误，路由路径以管理应用为根。宿主统一挂载在 `/v1` 下，运行时的接口描述见登录后的 `GET /v1/openapi.json`。新路径使用插件名作为命名空间，并确认方法与路径组合属于该插件。

宿主提供会话、写请求 Origin 检查、请求大小限制和错误包络。路由继续验证该操作的权限及资源归属。角色作用域的管理接口先根据已认证的 `actor`、`characterId` 调用持久化层的 `authorize`，并在查询中绑定目标角色。角色管理员可审批及查看审计记录。部署级操作使用本地部署管理员权限，参考 [API 启动入口](../../apps/api/main.ts)对 `localIssuer` 和 `canCreate` 的检查。

对于角色内的变更，优先通过 [`executeManagementCommand`](../../packages/persistence/management/index.ts)执行，传入操作名、角色和目标范围、输入、请求 ID 及适用的幂等键。它在事务内复核授权并写审计，使用相同键和输入重试时复用已提交的结果。带版本的更新使用现有 `versionHeader` 和 `version()` 解析 `If-Match`。权限规则见[管理 API](../management-api.md)。

## ManagementPlugin

从 `@ricajs/persistence/management-http` 导入类型，并在插件的 `package.json` 声明 `@ricajs/persistence` 依赖。

```ts
type ManagementPrincipal = { issuer: string; subject: string; id: string; canCreate?: boolean }
type Scope = { characterId: string; actor: ManagementPrincipal }
type ManagementEnvironment = {
  Variables: { actor: ManagementPrincipal; requestId: string }
}
type PlatformAccountRef = { platform: string; instanceKey: string; remoteAccountId: string }

type ManagementPlugin = {
  id: string
  registerRoutes(app: OpenAPIHono<ManagementEnvironment>): void
  workspace?: { fields: z.ZodRawShape; read(): Promise<object> }
  status?: { fields: z.ZodRawShape; read(characterId: string): Promise<object> }
  accountFields?: z.ZodRawShape
  account?: {
    platform: string
    registration: z.ZodType<{ platform: string }>
    register(tx: Prisma.TransactionClient, scope: Scope, input: unknown): Promise<{ id: string }>
    profiles(tx: Prisma.TransactionClient, accounts: PlatformAccountRef[]):
      Promise<(account: PlatformAccountRef) => object>
    remove(tx: Prisma.TransactionClient, account: PlatformAccountRef): Promise<void>
    verifyResume(tx: Prisma.TransactionClient, account: PlatformAccountRef): Promise<void>
  }
}
```

| 字段 | 宿主何时调用 | 插件应返回什么 |
| --- | --- | --- |
| `id` | 管理应用装配时检查唯一性。 | 稳定标识。一个管理插件可服务多个部署项。 |
| `registerRoutes` | 创建管理应用时调用一次。 | 在 `app` 注册路由。路由中从 `c.get('actor')`、`c.get('requestId')` 取已认证操作者和请求 ID。 |
| `workspace` | 角色工作区查询时。 | 输出与 `fields` 对应的公开字段。此钩子无角色参数，适合部署级标志。 |
| `status` | 已授权的插件状态查询时。 | 根据 `characterId` 读取并返回声明过的公开摘要。 |
| `accountFields` | 合并已绑定账号和账号池 schema 时。 | 资料钩子可能贡献的字段。某些平台特有的字段通常标记为可选。 |
| `account.registration` | `POST /characters/{characterId}/account-pool` 验证请求体时。 | 匹配该平台的 schema。用 `z.literal(platform)` 限定判别字段，并在 `register` 内解析。`platform` 与现有账户平台值保持一致。 |
| `account.register` | 成功匹配后，在授权、幂等和审计事务中。 | 复用通用登记函数并保存平台专用资料，返回 `{ id: 登记UUID }`。失败抛错回滚。 |
| `account.profiles` | 读取账号列表或账号池时。 | 批量加载本平台账号资料，返回纯投影函数。投影结果只保留该插件声明的 `accountFields`。 |
| `account.remove` | 未绑定的登记已在当前事务中删除后。 | 清理平台专用数据。需要处理同一远端账号仍被引用的情况。 |
| `account.verifyResume` | 恢复外部账号前。 | 核对凭证、启用状态和远端账号绑定。拒绝时抛出 `ManagementError`，宿主保持原状态。 |

`registerRoutes` 必填。仅提供投影或账号回调时，可用空函数。宿主拒绝同名投影字段，扩展值由声明的 schema 校验。内置实现可参考 [Newbi 的管理路由](../../plugins/newbi/rica/management/routes.ts)。

## 响应投影

宿主组合并校验字段，拒绝重复的插件 ID、平台和字段。为字段选用有明确用途的名称。响应可以返回头像、用户名、公开 ID 和核验结果。密钥、原始游标、供应商错误正文及未脱敏请求只在服务端按需处理。插件状态按角色查询，维持工作区已有的角色权限。

## 路由、事务与错误助手

| API | 参数与结果 |
| --- | --- |
| `character` / `characterParams` | `'/characters/{characterId}'` 及对应的 UUID 参数 schema。可用 `characterParams.extend({ ... })` 扩展。 |
| `body(schema)` | 声明必填 `application/json` 请求体。`success(schema)` 为 JSON 成功响应描述。 |
| `security` / `errors` / `failure` | 会话安全声明、通用错误映射及单个错误响应描述。 |
| `error(requestId, code, message)` | 返回 `{ error: { requestId, code, message } }`。 |
| `version(headers)` | 从经过 `versionHeader` 校验的头取带双引号的非负十进制版本。最大接受 `2147483646`，无效时抛 `422 INVALID_VERSION`。 |
| `authorize(tx, scope)` | 使用 `scope.actor.issuer`、`subject` 和 `scope.characterId` 核对角色管理员资格。缺少授权返回 404。 |
| `executeManagementCommand(db, command, apply)` | 在事务内验证权限、串行化角色更新、执行 `apply(tx)` 并写入审计。使用 `key` 时按操作者、操作及 `targetScope` 处理幂等，结果返回给处理器。 |
| `registerAccount(tx, scope, input)` | 使用 `{ platform, instanceKey, remoteAccountId }` 写入角色账号池。返回 `{ id }`。通过 `scope` 使用可信角色 ID。 |
| `new ManagementError(status, code, message)` | 抛出已定义的业务错误，宿主用统一错误格式响应。未知异常转为通用 500。 |

`command` 必填字段为 `actor`、`operation: string`、`requestId: string`、`input: unknown`、`targetScope: string`。可选 `characterId: string`、`key: string`。角色变更传 `characterId`，宿主校验角色管理员资格。`apply` 返回包含 `id` 的命令结果。角色操作应在事务内继续限定目标资源归属。对外部不可逆请求，由执行账本持久化许可并管理重试。

## 请求约定

路径以控制台同源地址为基准，开发环境默认 `http://localhost:5173`。角色接口中的 `{characterId}`，以及账号、身份和平台账号登记 ID 均为 UUID。登录使用 `POST /v1/auth/login`，请求体为 `{ "username": "...", "password": "..." }`，响应设置会话 Cookie。后续请求复用 Cookie。`GET /v1/auth/session` 返回 `{ username, canCreate }`。

- 所有变更请求及核验 POST 传入与 `RICA_ADMIN_ORIGIN` 一致的 `Origin`。带 JSON 请求体时使用 `Content-Type: application/json`。管理请求体上限为 32768 字节。
- 下表的「幂等」表示必填 `Idempotency-Key`。长度 1–128，允许英文字母、数字以及 `.`、`_`、`:`、`-`。重试同一业务请求使用原键和原输入。
- 「版本」表示必填 `If-Match`，请求头的实际值需包含双引号，例如 `"3"`。按最近读取的资源版本提交。
- 「分页」参数为可选 `limit`（1–100，默认 25）及可选 `cursor`（上页的 `nextCursor` UUID）。返回 `{ items: T[], nextCursor: string | null }`。
- 「命令结果」返回 `{ id, requestId, version?, status?, authEpoch? }`。`id` 和 `requestId` 为 UUID，`version` 和 `authEpoch` 为整数，`status` 为操作状态字符串。
- 业务错误使用 `{ "error": { "code": "PLUGIN_STATE_CONFLICT", "message": "...", "requestId": "..." } }`。常见状态包括 401 会话无效、403 权限或 Origin 不符合、404 资源不可见、409 状态或幂等冲突、412 版本过期、413 请求体过大、422 输入无效、428 缺少版本头。

服务端即时生成的接口描述为 `GET /v1/openapi.json`。该文档会包含当前装配的插件路由。本章说明宿主提供的通用工作流。

## 建立 PowerShell 会话

先启动 API 和控制台，准备有本地部署权限的管理员、一个已创建的角色及一个身份。下面的请求在 PowerShell 7 中执行，密码通过屏蔽输入读取。

```powershell
$ricaOrigin = 'http://localhost:5173'
$ricaPassword = Read-Host -MaskInput 'Rica 管理员密码'
Invoke-RestMethod -Method Post -Uri "$ricaOrigin/v1/auth/login" -SessionVariable ricaSession `
  -Headers @{ Origin = $ricaOrigin } -ContentType 'application/json' `
  -Body (@{ username = 'admin'; password = $ricaPassword } | ConvertTo-Json)
Remove-Variable ricaPassword

$ricaCharacterId = Read-Host '角色 UUID'
$ricaIdentityId = Read-Host '身份 UUID'
$ricaCharacter = "/v1/characters/$ricaCharacterId"

function Invoke-Rica {
  param(
    [string]$Method, [string]$Path, [hashtable]$Body,
    [string]$Key, [Nullable[int]]$Version,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session = $ricaSession
  )
  $headers = @{ Origin = $ricaOrigin }
  if ($Key) { $headers['Idempotency-Key'] = $Key }
  if ($null -ne $Version) { $headers['If-Match'] = '"' + $Version + '"' }
  $arguments = @{
    Method = $Method; Uri = "$ricaOrigin$Path"; WebSession = $Session; Headers = $headers
  }
  if ($null -ne $Body) {
    $arguments.ContentType = 'application/json'
    $arguments.Body = $Body | ConvertTo-Json -Depth 8
  }
  Invoke-RestMethod @arguments
}

Invoke-Rica Get "$ricaCharacter/plugins"
```

## 插件自定义路由

内置插件在 `registerRoutes` 中声明相对路径，宿主统一添加 `/v1` 前缀。业务权限、输入 schema 和响应体由路由定义。启用管理 API 后，可在登录会话中查看 OpenAPI 契约。

```powershell
Invoke-Rica Get '/v1/openapi.json'
```

通过部署清单安装的管理扩展使用[插件 SDK 的读取和命令能力](08-package-sdk.md#包能力参考)。浏览器调用使用同源会话，服务端继续按角色和业务资源检查权限。

## 部署与配置存储

插件也可以注册自己的设置路由及配置存储，适合含敏感字段或需要独立版本的配置。宿主的受保护设置目录可由 `RICA_MODEL_SETTINGS_DIR` 指定。需要共享配置的进程应读取同一路径。密钥由控制台收集，服务器只回传是否已保存。采用文件配置时设定一个写入者，并按进程角色限制读取权限。

在 `apps/deployment-plugin-contracts.ts` 声明部署项和公开 schema，持久化由 `createDeploymentPluginStore(directory)` 提供。

| 入口 | 签名和行为 |
| --- | --- |
| 部署项 | `{ id: string; ownsComponent(service: string, component: PluginMetadata): boolean }`。用于发布预览的组件归属。 |
| 配置贡献 | `{ id, change, stored, public, apply(input), view(value) }`。`change` 校验独立的动作字面量及字段，`apply` 返回存储值，`view` 返回公开投影，`stored` 和 `public` 分别校验两者。 |
| `status(provider)` | `Promise<DeploymentPluginsView>`，返回版本、各部署项状态、公开配置和当前已配置模型。`provider` 为模型提供方 ID。 |
| `save(change, expected, getProvider)` | 检查版本和状态，应用部署或配置变更，原子写入并返回最新公开视图。 `expected: number`，`getProvider: () => Promise<string>`。 |
| `readConfiguration(id)` | `Promise<{ stage?: PluginStage; config: unknown }>`。用于服务端，插件负责解析自己的存储值。 |
| `isEnabled(id)` | `Promise<boolean>`。按部署记录判断指定插件是否已启用。 |

配置贡献示例。此处的 `acme` 与其 ID、公开 schema 需登记到部署目录。

```ts
import { z } from '@hono/zod-openapi'

const stored = z.object({ timeoutMs: z.number().int().min(100).max(5000) })

export const acmeConfiguration = {
  id: 'acme',
  change: stored.extend({ action: z.literal('CONFIGURE_ACME') }).strict(),
  stored,
  public: z.object({ timeoutMs: z.number().int() }),
  apply({ timeoutMs }: z.infer<typeof stored>) {
    return { timeoutMs }
  },
  view(value?: z.infer<typeof stored>) {
    return { timeoutMs: value?.timeoutMs ?? 1000 }
  },
} as const
```

将 `acmeConfiguration` 放入 `deploymentConfigurations`，在 `deploymentPluginsView` 加入 `[acmeConfiguration.id]: acmeConfiguration.public`，并在 `deploymentPlugins` 注册 `acme`。当前存储实现只有一个专用配置贡献。加入第二个、字段不同的贡献时，应在 [deployment-plugins.ts](../../apps/deployment-plugins.ts) 按动作收窄 `change`，让 `parse` 与 `apply` 配对，并保持读取时的 `stored` 与 `view` 配对。启用后提交 `{ "action": "CONFIGURE_ACME", "timeoutMs": 1500 }`。HTTP 示例见[部署与插件状态](#部署与插件状态)。

### 部署与插件状态

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /v1/characters/{characterId}/plugins` | 角色 ADMIN | 无查询参数或请求体。 | 200，进程状态、部署信息和已注册的状态贡献。 |
| `PUT /v1/deployment-plugins` | 本地部署管理员 | 版本。请求体为 `{ action, id }`，或者已注册的插件配置动作及其字段。 | 200，最新部署视图。 |

通用动作 `action` 为 `INSTALL`、`ENABLE`、`DISABLE` 或 `UNINSTALL`，`id` 取当前部署目录中的插件 ID。状态依次为 `NOT_INSTALLED → INSTALLED → ENABLED`，停用回到 `INSTALLED`。卸载从 `INSTALLED` 或 `ENABLED` 回到 `NOT_INSTALLED`，保留配置和业务记录。非法状态转换返回 409，版本过期返回 412。

插件在核验连接、读取或发送前应检查当前启用状态、设置和账号绑定。历史查询与执行入口各自校验权限。

插件状态必含 `services: { service, catalog, report }[]`。组件目录和报告见[进程状态报告](#进程状态报告)。启用部署配置时会返回 `deployment`，包含 `version: number`、`plugins` 状态映射、`configuredModel: string | null`，以及当前部署声明的公开设置字段。配置了发布查询时可返回 `release`。插件声明的状态字段合并到根对象，其参数由贡献的 schema 决定。

`release.status` 为 `UNCONFIGURED`、`UNAVAILABLE` 或 `AVAILABLE`。可用时还包含 `ricaVersion`、`releaseUrl`、`upgrades`（目录与目标有差异的组件）和 `aligned`（目录与目标一致的组件）。两个列表都以 `{ id, components }` 按插件返回，组件项为 `{ service, current, target, problem }`。`target` 缺失时为 `null`，`problem` 为 `null` 或 `MISSING_COMPONENT`、`INCOMPATIBLE_CONTRACT`、`DOWNGRADE`。运行核对使用独立的 `services[].report`。

以下命令适用于已随部署交付的插件。输入 `GET /plugins` 所列的部署 ID。

```powershell
$ricaPluginId = Read-Host '部署插件 ID'
$ricaDeployment = (Invoke-Rica Get "$ricaCharacter/plugins").deployment
$ricaStage = $ricaDeployment.plugins.PSObject.Properties[$ricaPluginId].Value
if ($ricaStage -eq 'NOT_INSTALLED') {
  $ricaDeployment = Invoke-Rica Put '/v1/deployment-plugins' `
    -Version $ricaDeployment.version -Body @{ action = 'INSTALL'; id = $ricaPluginId }
  $ricaStage = $ricaDeployment.plugins.PSObject.Properties[$ricaPluginId].Value
}
if ($ricaStage -eq 'INSTALLED') {
  $ricaDeployment = Invoke-Rica Put '/v1/deployment-plugins' `
    -Version $ricaDeployment.version -Body @{ action = 'ENABLE'; id = $ricaPluginId }
}
$ricaDeployment
```

例如部署了[示例配置贡献](#部署与配置存储)后，将 `$ricaPluginId` 设为 `acme`，启用后执行以下命令。响应中的 `acme.timeoutMs` 为 `1500`，`version` 随变更递增。

```powershell
$ricaDeployment = Invoke-Rica Put '/v1/deployment-plugins' -Version $ricaDeployment.version `
  -Body @{ action = 'CONFIGURE_ACME'; timeoutMs = 1500 }
$ricaDeployment.acme
```

## 进程状态报告

`PluginMetadata` 包含 `id`、`version`、`contractVersion`、`kind`。当前 `kind` 为 `platform | model | platform-reader | platform-reply-executor`。在 `apps/plugin-observation.ts` 把进程 ID 和组件加入状态目录。组件身份和种类必须与目录一致，临时或不匹配的报告会被视为未知。

| 函数 | 参数与结果 |
| --- | --- |
| `startPluginHeartbeat(redisUrl, service, plugins)` | `redisUrl`、进程 ID 字符串及 `PluginMetadata[]`。返回 `ready(nextPlugins?)`、`failed(diagnostic)` 和 `stop()`。进程关闭时调用 `stop()`。 |
| `reportPluginResult(redisUrl, service, diagnostic?)` | 单次命令使用。URL 可为 `undefined`，有诊断时发布失败，否则发布完成。返回 `Promise<void>`。 |
| `readPluginStatus(redis?)` | 接受可选的 Redis `mget` 依赖，返回 `{ services: { service, catalog, report }[] }`。无可用报告时 `report` 为 `null`。 |

`report` 含 `status: READY | COMPLETED | FAILED`、ISO 时间 `observedAt`、最多 20 条 `plugins` 及可选 `diagnostic`。诊断允许 `UNKNOWN_PLUGIN`、`DUPLICATE_SELECTION`、`INVALID_CONFIG`、`MISSING_SERVICE`、`START_FAILED`、`INCOMPATIBLE_CONTRACT`、`DUPLICATE_PLUGIN`、`INVALID_MANIFEST`、`DEPENDENCY_UNAVAILABLE`、`OPERATION_FAILED`。用 `observationError(error, fallback)` 过滤运行时异常。状态发送属于尽力而为的辅助报告，业务的成功或失败由原操作决定。

## 平台账号生命周期

1. **核验**。平台专用路由使用凭证向平台获取远端身份，返回公开资料。可从凭证发现的身份字段由服务端填充。凭证改变后清除旧预览。
2. **登记**。声明 `platform` 和带对应平台字面量的 `registration` schema。宿主通过 `POST /v1/characters/{characterId}/account-pool` 分派到 `register(tx, scope, input)`。处理器复核当前端点、凭证和远端身份，复用通用账号登记并在同一事务保存专用资料。浏览器提交的预览仅用于比较本次核验对应的账号。
3. **关联与启用**。宿主管理角色内账号和身份的一对一绑定。绑定后账号先暂停，恢复时宿主按平台调用 `verifyResume(tx, account)`，由插件确认凭证仍匹配已绑定账号。
4. **查看与移除**。`profiles(tx, accounts)` 只收到该平台的记录并返回每条账号的公开投影。`remove(tx, account)` 在未绑定登记被删除的同一事务中清理专用资料。已绑定账号按宿主管理流程暂停或撤销。

测试从核验失败到移除的完整生命周期，特别核对多个同平台账号、重复登记、错误角色及已停用插件的请求。

### 账号贡献的代码骨架

下面的工厂展示登记、公开资料、删除及恢复的完整回调。把它放在插件的 `management.ts`。注入的服务实现负责平台核验与插件专用存储，使用调用时收到的事务。浏览器核验路由可以复用 `verify`，登记时仍会核验一次。

```ts
import { z } from '@hono/zod-openapi'
import { resourceId } from '@ricajs/contracts/management'
import { ManagementError, registerAccount } from '@ricajs/persistence/management'
import type { Prisma } from '@ricajs/persistence/prisma'
import type { ManagementPlugin } from '@ricajs/persistence/management-http'

const registration = z.strictObject({
  platform: z.literal('acme'),
  credential: z.string().min(1).max(256),
  agentId: resourceId,
})
const profile = z.object({ name: z.string().min(1) })
type Verified = { endpoint: string; agentId: string; name: string }
type Account = { platform: string; instanceKey: string; remoteAccountId: string }
type Services = {
  verify(credential: string): Promise<Verified | undefined>
  save(tx: Prisma.TransactionClient, account: Verified, credential: string): Promise<void>
  profiles(tx: Prisma.TransactionClient, accounts: Account[]):
    Promise<(account: Account) => { name: string } | undefined>
  remove(tx: Prisma.TransactionClient, account: Account): Promise<void>
  verifySaved(tx: Prisma.TransactionClient, account: Account): Promise<boolean>
}

export function acmeAccounts(services: Services): Pick<ManagementPlugin, 'account' | 'accountFields'> {
  return {
    accountFields: { acmeProfile: profile.optional() },
    account: {
      platform: 'acme',
      registration,
      async register(tx, scope, input) {
        const { credential, agentId } = registration.parse(input)
        const verified = await services.verify(credential)
        if (!verified || verified.agentId !== agentId) {
          throw new ManagementError(409, 'CONNECTOR_VERIFICATION_FAILED', 'Could not verify account')
        }
        const result = await registerAccount(tx, scope, {
          platform: 'acme', instanceKey: verified.endpoint, remoteAccountId: verified.agentId,
        })
        await services.save(tx, verified, credential)
        return result
      },
      async profiles(tx, accounts) {
        const project = await services.profiles(tx, accounts)
        return (account) => ({ acmeProfile: project(account) })
      },
      async remove(tx, account) {
        await services.remove(tx, account)
      },
      async verifyResume(tx, account) {
        if (!await services.verifySaved(tx, account)) {
          throw new ManagementError(409, 'CONNECTOR_VERIFICATION_FAILED', 'Account verification failed')
        }
      },
    },
  }
}
```

在插件对象中用 `{ id: 'acme', registerRoutes, ...acmeAccounts(services) }` 挂载。具体服务的 `verify` 与 `verifySaved` 应读取当前启用状态、验证端点和账号绑定。`remove` 删除最后一次引用时才清理底层凭证。

### 平台账号池与绑定

本节的相对路径均在 `/v1/characters/{characterId}` 下。

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /account-pool` | ADMIN | 分页。 | 200，未绑定登记列表。每项含 `id`、`platform`、`instanceKey`、`remoteAccountId`，可含插件资料投影。 |
| `POST /account-pool` | ADMIN | 幂等。`platform` 用于选择登记 schema，其他字段由该平台声明。 | 201，命令结果，`id` 为登记 ID。 |
| `POST /account-pool/associations` | ADMIN | 幂等。`{ registrationId, identityId }`。登记尚未绑定，身份尚无未撤销账号。 | 201，命令结果，返回关联账号 ID、版本和初始状态 `PAUSED`。 |
| `DELETE /account-pool/{registrationId}` | ADMIN | 幂等，无请求体。仅限未绑定登记。 | 200，命令结果。 |
| `GET /accounts` | 角色管理员 | 分页。 | 200，已绑定账号列表。每项含 `id`、`identityId`、`platform`、`instanceKey`、`status`、`version`，可含插件资料投影。 |
| `GET /accounts/{accountId}/automation-eligibility` | ADMIN | 无。 | 200，`{ accountId, identityId, bindingVersion, eligible, reasons }`。 |
| `POST /controls` | ADMIN | 幂等。`{ scope, scopeId, operation, reason? }`。 | 200，命令结果。 |

`controls.scope` 为 `CHARACTER`、`IDENTITY` 或 `ACCOUNT`，`operation` 为 `PAUSE`、`RESUME` 或 `REVOKE_ACCOUNT`。撤销只适用于账号。理由可选，去首尾空白后为 1–240 字符，无控制字符。恢复外部账号会触发插件的 `verifyResume`。自动化资格当前返回 `eligible: false`，原因可包含 `BINDING_INACTIVE`、`SIMULATION_ONLY`、`UNSUPPORTED_ADAPTER` 或 `EXTERNAL_AUTO_DISABLED`。

以下示例使用内置模拟平台演示宿主通用绑定流程。模拟登记需要 `platform`、`instanceKey` 和 `remoteAccountId`。后两项去首尾空白后分别为 1–120 和 1–240 字符，无控制字符。使用尚未关联账号的身份。

```powershell
$ricaAccountKey = [guid]::NewGuid().ToString()
$ricaRegistration = Invoke-Rica Post "$ricaCharacter/account-pool" -Key $ricaAccountKey `
  -Body @{ platform = 'mock-a'; instanceKey = 'sandbox'; remoteAccountId = 'demo-account' }
Invoke-Rica Get "$ricaCharacter/account-pool?limit=25"
$ricaAccount = Invoke-Rica Post "$ricaCharacter/account-pool/associations" -Key ([guid]::NewGuid().ToString()) `
  -Body @{ registrationId = $ricaRegistration.id; identityId = $ricaIdentityId }
Invoke-Rica Get "$ricaCharacter/accounts"
Invoke-Rica Get "$ricaCharacter/accounts/$($ricaAccount.id)/automation-eligibility"
```

角色和身份均已启用时，用 `Invoke-Rica Post "$ricaCharacter/controls" -Key ([guid]::NewGuid().ToString()) -Body @{ scope = 'ACCOUNT'; scopeId = $ricaAccount.id; operation = 'RESUME' }` 恢复账号。若只验证登记和移除，在关联前执行 `Invoke-Rica Delete "$ricaCharacter/account-pool/$($ricaRegistration.id)" -Key ([guid]::NewGuid().ToString())`。

插件自己的登记参数由 `account.registration` 定义。例如[账号贡献示例](#账号贡献的代码骨架)为 `acme` 提供 `{ platform: "acme", credential, agentId }`。启用插件并实现凭证核验后，使用该请求体调用相同的 `POST /account-pool`。核验路由和返回资料字段由插件声明。
