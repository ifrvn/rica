# 第三方插件 SDK 与远程服务协议

通过部署清单安装固定版本 npm 包，或通过 HTTP 接入独立服务。能力选择、数据边界和权限原则见[插件架构与最佳实践](01-architecture.md)。

## 最小可运行的 npm 包

在插件项目中将以下 TypeScript 入口编译为 ESM，例如 `dist/rica.js`。开发时依赖与目标 Rica 版本匹配的 `@ricajs/plugin-host`，包内通过 `exports` 暴露 `./package.json` 和 `./rica`，默认条件指向编译后的入口。

```json
{
  "name": "@acme/rica-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./package.json": "./package.json",
    "./rica": "./dist/rica.js"
  }
}
```

```ts
import type { RicaPlugin } from '@ricajs/plugin-host/sdk'

export const ricaPlugin = {
  id: 'acme',
  sdkVersion: 1,
  management: () => ({
    async read({ path, characterId }) {
      if (path === '/summary') return { fields: [{ label: '角色 ID', value: characterId }] }
      return null
    },
  }),
  console: { title: 'Acme', summaryPath: '/summary' },
} satisfies RicaPlugin
```

部署者在清单所在项目安装该包的固定版本，并设置 `RICA_PLUGIN_MANIFEST` 指向以下 JSON 文件。使用经过审核的发布包或内部制品源。

```json
{
  "version": 1,
  "plugins": [{ "id": "acme", "package": "@acme/rica-plugin", "version": "1.0.0" }]
}
```

启动管理 API 后，用[已登录的会话](03-management.md#建立-powershell-会话)请求 `GET /v1/characters/{characterId}/plugins/acme/summary`。已获准读取角色的成员会收到示例摘要。控制台也会在该角色的插件页展示卡片。需要私有存储或写命令时，再添加下文能力。

## 包能力参考

插件至少声明 `management`、`commands`、`worker`、`activity`、`accounts` 或 `retention` 中的一种。API 和 Worker 各自调用所需能力的工厂。

`management(config, context)` 可异步创建实例，返回 `read(request, services)` 和可选的 `stop()`。`request` 包含角色 ID、调用者 ID、插件内路径和保留重复项的查询参数。宿主校验会话和角色权限后转发 GET 请求。插件读自己的数据时继续按授权范围筛选。包处理并返回 JSON。

### 管理写命令

插件通过 `commands` 声明命令。命令 ID 由小写字母开头，由小写字母、数字和分隔用的连字符组成，最多 50 个字符。函数名使用下划线分隔的 PostgreSQL 标识符。

```ts
commands: [
  { id: 'update-note', function: 'update_note', scope: 'account' },
]
```

客户端使用 `POST /v1/characters/{characterId}/plugins/{pluginId}/commands/{commandId}`，提供 `Idempotency-Key` 请求头和 JSON 请求体。账号命令提交 `{ "accountId": "<uuid>", "data": {} }`，角色命令提交 `{ "data": {} }`。插件负责校验 `data` 的业务字段。

包需要声明 `database`，并在宿主数据库的插件 schema 中迁移同名函数，签名为 `(character_id uuid, actor_id text, account_id uuid, data jsonb) RETURNS jsonb`。角色命令收到 SQL `NULL` 作为账号 ID。账号命令只对当前角色、当前插件平台下已绑定且未撤销的账号开放。宿主在重放前同样检查账号权限。函数返回 `{ "id": "<uuid>" }` 和可选的 `status`、`version`，其中 ID 用作审计目标。返回空值会拒绝命令。函数异常或返回结构无效时，插件写入会随宿主事务回滚。

同一调用者、角色、命令和幂等键在 24 小时内重放结果。改变请求数据会返回冲突。审计操作名为 `plugin.<插件 ID>.<命令 ID>`。仅向 `rica_admin_api` 授予 schema 的 `USAGE` 和指定函数的 `EXECUTE`，撤销 `PUBLIC` 的执行权限。若使用 `SECURITY DEFINER`，固定 `search_path` 并限定所有业务对象的 schema。命令函数适用于本地事务数据，真实外部操作需要宿主的执行许可协议。

### Worker 生命周期

`worker(config, context)` 同步返回 `start()` 和 `stop()`，实例在 `start()` 内获取资源、确认就绪并启动后台任务。`context.signal` 用于中止初始化和停止领取新任务。`stop()` 等待在途任务结束并释放已获取的资源，也要能清理只初始化了一部分的实例。宿主等所有插件启动成功后报告 Worker 就绪。单个插件启动失败时，宿主触发取消，并按相反顺序关闭已经开始初始化的插件。

插件的 Worker 随每个 Rica Worker 进程启动。需要单独领取的任务由插件管理租约、去重和重试。需要讨论评估时声明 `workerServices: { discussion: true }`，通过 `context.services?.discussion` 调用宿主模型。宿主用已注册的插件 ID 作为平台归属，只接受该平台下的有效角色和身份绑定。模型请求前再次检查绑定及部署开关，宿主负责模型选择和用量归属。独立进程可通过下文的事件接口交换活动摘要。

### Prisma 插件的部署配置

需要建表的包另行导出 `./rica/prisma`，指向该包的 Prisma 配置文件。其 `schema` 和 `migrations.path` 使用包内路径，`datasource.url` 读取 `process.env.RICA_PLUGIN_DATABASE_URL`。发布包应包含用于迁移的 schema、迁移目录和运行时使用的独立 Client。

若 Prisma 配置文件与 schema 同在 `prisma/`，配置可以写成：

```ts
export default {
  schema: './schema.prisma',
  migrations: { path: './migrations' },
  datasource: { url: process.env.RICA_PLUGIN_DATABASE_URL },
}
```

清单条目增加 `database` 字段。部署任务读取 `migrateUrlEnv` 指定的变量，API 和 Worker 在装配当前进程使用的能力时，将 `runtimeUrlEnv` 指定的 URL 通过 `context.databaseUrl` 传给插件。两个变量应由不同的 PostgreSQL 登录提供。清单本身只记录变量名。

```json
{"migrateUrlEnv": "RICA_PLUGIN_ACME_MIGRATE_URL", "runtimeUrlEnv": "RICA_PLUGIN_ACME_RUNTIME_URL"}
```

两个 URL 均指定 `?schema=rica_plugin_acme`。命名规则是 `rica_plugin_` 加插件 ID，连字符转为下划线。部署者预先建立 schema、迁移角色和运行时角色，并通过迁移授予业务操作所需权限。无额外参数的 `pnpm run db:migrate` 或 `rica migrate` 先运行宿主迁移，再运行随宿主分发的插件迁移，最后依清单顺序运行第三方包的迁移。附带参数时只调用宿主的 Prisma CLI，方便保留 `--help` 和单独指定宿主配置的用法。运行时用自己的 Client 连接该命名空间，使用 `PrismaPg` 时将对应 schema 传给驱动适配器。

第三方插件通过 `./rica/prisma` 和清单接入迁移，升级时把表结构和数据转换追加到包内迁移。插件模型定义在包内的 `schema.prisma`，用 `prisma generate` 生成独立 Client，普通查询和写入可直接使用模型方法。数据库函数、触发器和角色授权通过 SQL 迁移维护。内置 Newbi 可作为在同一个包中使用这两种方式的示例。

例如，首次安装 `acme` 时，由数据库管理员为该包准备两个独立登录和业务 schema。登录的认证方式由部署环境统一配置。

```sql
CREATE ROLE rica_acme_migrate LOGIN;
CREATE ROLE rica_acme_runtime LOGIN;
CREATE SCHEMA rica_plugin_acme AUTHORIZATION rica_acme_migrate;
GRANT USAGE ON SCHEMA rica_plugin_acme TO rica_acme_runtime;
```

插件作者在包内编写表结构、索引和运行权限的迁移，生成该包自己的 Prisma Client。部署者在清单所在项目安装固定版本，配置两个连接变量，再运行 `rica migrate`。升级时更新安装版本和清单，继续使用同一个迁移 URL，Prisma 根据该 schema 的迁移记录应用新增迁移。

需要单独存放迁移记录时，可从首次部署起声明 `"migrationJournal": "separate"`。迁移 URL 使用 `?schema=rica_migrate_acme`，运行时 URL 指向 `rica_plugin_acme`。部署者创建迁移记录 schema 并授权迁移登录，迁移 SQL 显式限定业务对象的 schema。已经记录过迁移的部署应持续使用原来的记录位置。

### 统一运行活动

插件可以单独声明 `activity: { view: 'run_activity' }`。它需要清单中的 `database` 配置，并在**宿主所在数据库**的插件 schema 中创建同名视图。视图名由小写字母开头，后续允许小写字母、数字和下划线，最多 63 个字符。视图应提供以下非空列。

| 列 | PostgreSQL 类型 |
| --- | --- |
| `character_id`、`account_id`、`id` | `uuid` |
| `kind`、`identity`、`account`、`state` | `text`，`kind` 取 `ASSESSMENT` 或 `PROPOSAL` |
| `created_at` | `timestamptz`，保留微秒 |

每条记录引用当前 Rica 角色的已绑定账号。同一插件在一个角色下的 `(created_at, id, kind)` 必须唯一。宿主验证账号归属后，与其他活动来源统一排序和分页，并将来源标记为 `plugin:<id>`。授予 `rica_admin_api` 插件 schema 的 `USAGE` 和该视图的 `SELECT` 即可，插件可通过视图只公开摘要字段。控制台目前展示外部插件的摘要，详情随插件 UI 接入提供。

### 数据保留期

使用 `retention: { sweep: 'sweep_retention' }` 将清理接入宿主 Worker 和 `rica retention`。包需要声明 `database`，并在宿主数据库的插件 schema 中创建同名的无参数函数，返回本批修改或删除的记录总数，类型为 PostgreSQL `integer`。每次调用应限制处理批量，并支持与其他 Worker 并行调用。

为 `rica_runtime` 授予插件 schema 的 `USAGE` 和该函数的 `EXECUTE`，撤销 `PUBLIC` 的执行权限。Worker 和手动命令在启用清理前会检查函数签名与权限。各插件在独立事务中运行清理，单个插件报错时其他清理仍可提交。

### 账号接入和事务

有 `accounts` 能力的包以插件 ID 作为平台名。账号池复用宿主的会话、权限、审计和幂等逻辑。登记使用 `POST /v1/characters/{characterId}/account-pool`，提交 `platform`、`instanceKey`、`remoteAccountId` 和可选 JSON `data`。关联账号仍使用账号池的 `associations` 路由。包可以在控制台卡片中声明登记字段。

```ts
accounts: {
  register: 'register_account',
  profiles: 'account_profiles',
  remove: 'remove_account',
  verifyResume: 'verify_resume',
}
```

- `register` 必填。`register`、`remove` 和 `verifyResume` 指向宿主数据库中插件 schema 下的函数。签名为 `(character_id uuid, account_id uuid, instance_key text, remote_account_id text, data jsonb) RETURNS boolean`。登记使用宿主生成的 ID，关联后沿用此 ID。删除和恢复的 `data` 为 JSON `null`。
- 需要远端核验时，声明异步 `prepareRegistration({ characterId, instanceKey, remoteAccountId, data })`。宿主先授权并检查幂等结果，释放事务和锁后调用核验。回调应限制外部请求的时长，只做可重复的检查。返回 `{ accepted: false }` 会拒绝登记。返回 `{ accepted: true, data }` 时，宿主在写事务内重新检查权限和幂等状态，并把核验后的 `data` 传给 `register` 函数。账号的实例和远端 ID 仍以登记请求为准，核验时应核对这两个值。已经成功的同键重试直接返回原结果，并发的首次请求可能各自做一次核验。
- 宿主在同一事务中调用声明的函数，传入已授权的角色和账号。函数返回 `true` 才继续提交，返回 `false` 或抛出错误会回滚宿主和插件的写入。仅向 `rica_admin_api` 授予 schema 的 `USAGE` 和指定函数的 `EXECUTE`。如使用 `SECURITY DEFINER`，设定固定的 `search_path`、限定对象名，并撤销 `PUBLIC` 执行权限。事务函数处理本地数据库变更，外部请求无法随数据库回滚。
- `remove` 可选，省略时仅删除宿主的未绑定登记。省略 `verifyResume` 时，宿主拒绝激活该平台账号。可选的 `profiles` 声明只读视图，提供 `character_id uuid`、`account_id uuid`、`profile jsonb`，每个账号最多一行。宿主分页后批量查视图，并通过 `pluginProfile` 返回公开资料。
- `services.readAccounts(ids)` 供已声明 `accounts` 的插件在管理 `read` 回调中使用。每次最多 100 个 UUID，只返回当前角色在该插件平台下的已绑定账号，字段包含身份、远端标识、状态和绑定版本。每次查询重新检查调用者的角色访问权限。

### 内置样例

[Newbi 开发与部署](../../plugins/newbi/README.md#开发与部署)提供了包内 Prisma Client、共用迁移、活动视图和受限数据库函数的实例。

## 部署和生命周期

- `RICA_PLUGIN_MANIFEST` 指向部署目录中的 JSON 文件。清单版本为 `1`。每项声明 `id`、npm `package`、固定 `version` 和可选 JSON `config`。移出清单并重启对应进程后，该清单包的能力停止装配。部署者通过锁文件固定实际安装内容。
- 宿主从清单所在目录解析插件包的 `./rica` 导出，核对包清单中的名称和版本，再载入导出的 `ricaPlugin`。插件声明 SDK 版本和能力，宿主拒绝重复 ID、版本不符或不支持的能力。管理读取和命令通过角色下的插件路由提供，复用会话、来源、请求大小和成员权限检查。账号能力复用宿主账号池。
- 部署任务按上文顺序执行迁移，再启动同一发布版本的服务。迁移失败时中止部署。移除清单条目只影响装配，插件数据由独立维护操作管理。
- 插件代码在宿主进程中按受信代码部署。需要代码隔离的接入使用独立进程或远程服务。

## 控制台贡献

清单中的包可在 `ricaPlugin.console` 声明角色插件页的卡片。宿主通过已授权的 `GET /v1/characters/{characterId}/package-console` 提供卡片描述，在现有控制台渲染，无需修改宿主前端或重新构建。

```ts
console: {
  title: 'Acme',
  summaryPath: '/summary',
  accountDetailPath: '/account-detail',
  accountFields: [{ key: 'apiKey', label: '访问令牌', kind: 'secret' }],
}
```

`summaryPath` 和 `accountDetailPath` 是同一包的管理读取路径，返回 `{ fields: [{ label, value }] }`，值按文本显示。详情路径收到 `accountId` 查询参数，应通过 `services.readAccounts` 核对角色和平台归属，再读取插件数据。详情和登记需要 `accounts` 能力。

声明 `accountFields` 启用账号登记表单，宿主提供实例标识和远端账号 ID。附加字段以字符串提交到登记请求的 `data`，支持 `text` 和 `secret`。插件验证字段并负责凭据保存，摘要和详情只返回可展示字段。登记后在角色的账号池关联身份。

## 独立服务事件

通过 `RICA_REMOTE_PLUGIN_MANIFEST` 为独立服务启用 HTTP 事件接口。API 启动时读取该文件。每个服务使用独立的 Bearer 令牌，将 32 字节随机值编码为无填充的 Base64URL 字符串，并通过 `tokenEnv` 指向的环境变量配置。清单只记录变量名。更新令牌或权限后重启 API。

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "insights",
      "tokenEnv": "RICA_REMOTE_PLUGIN_INSIGHTS_TOKEN",
      "accounts": ["572b58ca-0702-4b9e-a3c3-85a9cbd40026"],
      "publishActivity": true
    },
    {
      "id": "reports",
      "tokenEnv": "RICA_REMOTE_PLUGIN_REPORTS_TOKEN",
      "accounts": ["572b58ca-0702-4b9e-a3c3-85a9cbd40026"],
      "subscribeTo": ["insights"]
    }
  ]
}
```

每个服务可以发布、订阅或同时声明两种能力。部署者使用宿主已绑定的账号 ID 配置 `accounts`，并向服务提供账号 ID、角色 ID 和当前 `bindingVersion`。发布和订阅都要求账号、身份和角色处于启用状态。服务通过 HTTPS 连接 Rica API，使用 `Authorization: Bearer <token>`，无需浏览器会话、插件安装包或数据库连接。

向 `POST /v1/plugin-events/{pluginId}/accounts/{accountId}` 提交 JSON。第一版接受 `activity.recorded.v1`。活动类别为 `ASSESSMENT` 或 `PROPOSAL`，状态由大写字母、数字和下划线组成，以字母开头，最多 64 个字符。事件时间使用 UTC，最多保留六位小数，最多可比宿主当前时间晚五分钟。

```json
{
  "id": "e14b5de5-a282-4f70-a29b-c3d21c83d239",
  "type": "activity.recorded.v1",
  "characterId": "062e37d4-be1d-48e4-887f-90afe6f0665e",
  "bindingVersion": 1,
  "occurredAt": "2026-11-20T01:00:00.123456Z",
  "payload": { "kind": "ASSESSMENT", "state": "DONE" }
}
```

初次发布返回 `201`，同一发布者重试相同事件返回 `200`。同一发布者以同一个事件 ID 提交不同内容时返回 `409`。即使是重试，宿主也重新校验账号和绑定版本。摘要进入统一运行活动，来源标记为 `plugin:remote:<pluginId>`，身份和账号名称由宿主提供。

订阅者以自己的服务 ID 调用 `GET /v1/plugin-events/{pluginId}/accounts/{accountId}?bindingVersion=1&after=0&limit=25`。返回 `{ items, nextOffset }`。事件含来源 `pluginId` 和字符串 `offset`。订阅者按账号和绑定版本保存游标，处理成功后以 `nextOffset` 继续读取。空页保留原游标。绑定版本变化后用新版本和 `after=0` 开始。服务只收到清单中 `subscribeTo` 允许的远程活动摘要。

## 独立服务任务

在远程服务清单中声明 `"tasks": ["analyze"]`，限定该服务可领取的任务类型。角色成员用宿主管理 API 调用 `POST /v1/characters/{characterId}/remote-plugins/{pluginId}/tasks`，提供 `Idempotency-Key` 和 `{ accountId, bindingVersion, type, data }`。宿主验证账号范围和任务类型，审计入队并返回任务 ID。可用同路径加 `/{taskId}` 的 GET 查询状态和处理结果。

独立服务用自己的令牌调用 `POST /v1/plugin-tasks/{pluginId}/accounts/{accountId}/claim` 并提交 `{ bindingVersion }`。响应是 `{ task: null }` 或一条含 `id`、`type`、`characterId`、`accountId`、`bindingVersion`、`data`、`lease` 和 `leaseUntil` 的任务。任务有效期 15 分钟，每次领取最多租用 30 秒，租约到期后可重新领取。服务以任务 ID 去重，按可重试任务设计。

向 `POST /v1/plugin-tasks/{pluginId}/accounts/{accountId}/{taskId}/receipt` 提交 `{ bindingVersion, lease, status, result }`。状态为 `SUCCEEDED` 或 `FAILED`，结果使用 JSON。相同回执可安全重试，旧租约或不同内容返回 `409`。账号撤销、身份或角色停用以及授权版本变化会使待办任务失效。任务协议用于可重试的读取和计算，真实发送仍通过宿主审批和执行许可。
