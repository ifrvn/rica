# 第三方插件包与 SDK 重构

Rica 支持部署者选定并固定版本的受信包。部署清单是 API、Worker、迁移任务和前端构建的共同输入。新版 SDK 按能力独立演进，公共签名使用可序列化的数据，插件各自管理 Prisma schema 和生成的 Client。

当前实现覆盖部署清单加载、只读管理接口、Worker 生命周期、独立 Prisma 迁移、统一活动分页和账号接入。其余能力按下表推进。部署者可用以下方式从部署目录配置已安装的包。

```json
{"version": 1, "plugins": [{"id": "acme", "package": "@acme/rica-plugin", "version": "1.0.0", "config": {"label": "Acme"}}]}
```

包的 `exports` 同时暴露 `./package.json` 和 `./rica`，后者使用默认条件指向编译后的 JavaScript 模块。模块导出 `ricaPlugin`，可用 `@ricajs/plugin-host/sdk` 的 `RicaPlugin` 类型检查。插件至少贡献 `management`、`worker`、`activity` 或 `accounts` 其中一种能力。API 和 Worker 都会读取包入口，各自调用对应的工厂。模块顶层仅声明能力，将连接和任务启动放到对应的生命周期内。

`management(config, context)` 可异步创建实例，返回 `read(request, services)` 和可选的 `stop()`。`request` 包含角色 ID、调用者 ID、插件内路径和保留重复项的查询参数。`read` 返回 JSON，宿主只转发已通过权限校验的 GET 请求。插件查询自己的数据库时仍应使用已授权的 `characterId` 筛选数据。

### Worker 生命周期

`worker(config, context)` 同步返回 `start()` 和 `stop()`，实例在 `start()` 内获取资源、确认就绪并启动后台任务。`context.signal` 用于中止初始化和停止领取新任务。`stop()` 等待在途任务结束并释放已获取的资源，也要能清理只初始化了一部分的实例。宿主等所有插件启动成功后报告 Worker 就绪。单个插件启动失败时，宿主触发取消，并按相反顺序关闭已经开始初始化的插件。

插件的 Worker 随每个 Rica Worker 进程启动。需要单独领取的任务由插件管理租约、去重和重试。第一版提供生命周期入口，统一的事件订阅和任务协议在后续阶段实现。

### Prisma 插件的部署配置

需要建表的包另行导出 `./rica/prisma`，指向该包的 Prisma 配置文件。其 `schema` 和 `migrations.path` 使用包内路径，`datasource.url` 读取 `process.env.RICA_PLUGIN_DATABASE_URL`。发布包应包含用于迁移的 schema、迁移目录和运行时使用的独立 Client。

清单条目增加 `database` 字段。部署任务读取 `migrateUrlEnv` 指定的变量，API 和 Worker 在装配当前进程使用的能力时，将 `runtimeUrlEnv` 指定的 URL 通过 `context.databaseUrl` 传给插件。两个变量应由不同的 PostgreSQL 登录提供。清单本身只记录变量名。

```json
{"migrateUrlEnv": "RICA_PLUGIN_ACME_MIGRATE_URL", "runtimeUrlEnv": "RICA_PLUGIN_ACME_RUNTIME_URL"}
```

两个 URL 均指定 `?schema=rica_plugin_acme`。命名规则是 `rica_plugin_` 加插件 ID，连字符转为下划线。部署者预先建立 schema、迁移角色和运行时角色，并通过迁移授予业务操作所需权限。无额外参数的 `pnpm run db:migrate` 或 `rica migrate` 先运行宿主迁移，再依清单顺序运行插件迁移。附带参数时只调用宿主的 Prisma CLI，方便保留 `--help` 和单独指定宿主配置的用法。运行时用自己的 Client 连接该命名空间，使用 `PrismaPg` 时将对应 schema 传给驱动适配器。

### 统一运行活动

插件可以单独声明 `activity: { view: 'run_activity' }`。它需要清单中的 `database` 配置，并在**宿主所在数据库**的插件 schema 中创建同名视图。视图名由小写字母开头，后续允许小写字母、数字和下划线，最多 63 个字符。视图应提供以下非空列。

| 列 | PostgreSQL 类型 |
| --- | --- |
| `character_id`、`account_id`、`id` | `uuid` |
| `kind`、`identity`、`account`、`state` | `text`，`kind` 取 `ASSESSMENT` 或 `PROPOSAL` |
| `created_at` | `timestamptz`，保留微秒 |

每条记录引用当前 Rica 角色的已绑定账号。同一插件在一个角色下的 `(created_at, id, kind)` 必须唯一。宿主验证账号归属后，与其他活动来源统一排序和分页，并将来源标记为 `plugin:<id>`。授予 `rica_admin_api` 插件 schema 的 `USAGE` 和该视图的 `SELECT` 即可，插件可通过视图只公开摘要字段。控制台目前展示外部插件的摘要，详情随插件 UI 接入提供。

### 账号接入和事务

有 `accounts` 能力的包以插件 ID 作为平台名。账号池复用宿主的会话、权限、审计和幂等逻辑。登记使用 `POST /v1/characters/{characterId}/account-pool`，提交 `platform`、`instanceKey`、`remoteAccountId` 和可选 JSON `data`。关联账号仍使用账号池的 `associations` 路由。控制台表单可在后续 UI 扩展中接入。

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

内置 Newbi 的账号池登记和直接绑定已走相同的两阶段宿主命令。它先核对远端 Agent，提交前再确认部署中的接入点，账号登记和凭据保存仍作为一次本地写入完成。

内置 Newbi 的凭据、公开账号资料、事件和轮询检查点存放在 `rica_plugin_newbi`。此步骤由宿主迁移部署。轮询角色通过受限函数更新游标和事件页，发送角色通过自己的受限函数取用凭据。后续阶段再迁移评估、执行账本和独立部署入口。

## 部署和生命周期

- `RICA_PLUGIN_MANIFEST` 指向部署目录中的 JSON 文件。清单版本为 `1`。第一批接入项包含 `id`、npm `package`、固定 `version` 和 JSON `config`。清单中省略某个包即停用其对外能力。部署者通过锁文件固定实际安装内容。
- 宿主从清单所在目录解析插件包的 `./rica` 导出，核对包清单中的名称和版本，再载入导出的 `ricaPlugin`。插件声明 SDK 版本和能力，宿主拒绝重复 ID、版本不符或不支持的能力。API 扩展只挂在 `/v1/characters/{characterId}/plugins/{pluginId}/…` 下，复用现有会话、来源、请求大小和角色成员权限检查。
- 数据库阶段在启动服务前先应用宿主迁移，再应用启用包的迁移。插件可用自己的 Prisma 迁移目录。部署配置给每个插件分配迁移身份和运行时身份，默认只授予其 PostgreSQL schema。迁移历史在各自命名空间记录。发布任务负责串行化迁移和版本切换，失败时中止部署。停用和卸载保留数据，清除数据由独立维护操作处理。
- 插件代码在宿主进程中按受信代码部署。需要代码隔离的接入使用独立进程或远程服务。

## 数据接口

1. **读能力**以业务对象为单位。宿主在授权后提供按账号批量查询的能力，插件返回公开资料；对展示字段沿用先分页再补资料的模式。任务资格判断由数据库在排序和限制条数前完成。
2. **事务能力**按业务操作发放。登记、解绑、审批和任务领取使用同一个宿主事务。需要插件内写入时，宿主调用声明过的、带权限边界的数据库操作，限制到当前角色和账号。参数用绑定传递。插件日常查询可继续用自己的 Prisma Client。
3. **活动和统一列表**使用版本化记录结构。宿主在同一个查询中合并记录，使用 `(created_at, id, kind, platform)` 全序和微秒时间精度。后续远程插件可通过带幂等键的事件发布摘要，供宿主维护统一读模型。
4. **可选能力**按清单登记管理 API、Worker、公开状态、UI 构建入口及事件订阅。事件包含版本、作用域和幂等键。审批和真实执行的许可仍由宿主控制。远程接入使用相同业务数据契约，另行提供服务身份和授权。

## 实施顺序与验收

| 阶段 | 验收 |
| --- | --- |
| 包装配和 SDK | 仓库外的包从部署目录加载。角色成员能使用该插件的管理路由，越权请求在调用插件前被拒绝。未配置清单时可按原流程启动。 |
| 插件迁移及第二种能力 | 独立插件使用自己的 Client 建表、读写并升级，宿主生成 Client 不包含其模型。再用 Worker 或只读连接器跑通能力登记、启动失败和停机。 |
| 数据协议与 Newbi 迁移 | 先落地账号、事务和统一活动协议，再将 Newbi 私有表、函数、权限和清理任务迁入插件。验证登记原子性、越权隔离、停用后禁止领取、发送恢复、跨源分页和空库初始化。 |
| 独立服务 | 验证远程插件只凭已授权业务能力接入，并通过事件贡献统一列表。 |

开发验收使用空的专用 PostgreSQL 和 Redis。已有数据的部署需要对迁移历史、数据、外键和执行账本另行验证升级路径。
