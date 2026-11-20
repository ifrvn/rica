# 第三方插件包与 SDK 重构

Rica 支持部署者选定并固定版本的受信包。部署清单是 API、Worker、迁移任务和前端构建的共同输入。新版 SDK 按能力独立演进，公共签名使用可序列化的数据，插件各自管理 Prisma schema 和生成的 Client。

当前实现覆盖部署清单加载、只读管理接口、独立 Prisma 迁移和停机回调。其余能力按下表推进。启用管理 API 后，部署者可用以下方式从部署目录配置已安装的包。

```json
{"version": 1, "plugins": [{"id": "acme", "package": "@acme/rica-plugin", "version": "1.0.0", "config": {"label": "Acme"}}]}
```

包的 `exports` 同时暴露 `./package.json` 和 `./rica`，后者使用默认条件指向编译后的 JavaScript 模块。模块导出 `ricaPlugin`，可用 `@ricajs/plugin-host/sdk` 的 `RicaPlugin` 类型检查。`management(config, context)` 可异步创建实例，返回 `read(request)` 和可选的 `stop()`。`read` 接收角色 ID、调用者 ID、插件内路径和保留重复项的查询参数，返回 JSON 值。宿主只转发已通过权限校验的 GET 请求。插件写查询时仍应使用已授权的 `characterId` 筛选插件数据。

### Prisma 插件的部署配置

需要建表的包另行导出 `./rica/prisma`，指向该包的 Prisma 配置文件。其 `schema` 和 `migrations.path` 使用包内路径，`datasource.url` 读取 `process.env.RICA_PLUGIN_DATABASE_URL`。发布包应包含用于迁移的 schema、迁移目录和运行时使用的独立 Client。

清单条目增加 `database` 字段。部署任务读取 `migrateUrlEnv` 指定的变量，API 将 `runtimeUrlEnv` 对应的 URL 托管在进程配置，通过 `context.databaseUrl` 传给插件。两个变量应由不同的 PostgreSQL 登录提供。清单本身只记录变量名。

```json
{"migrateUrlEnv": "RICA_PLUGIN_ACME_MIGRATE_URL", "runtimeUrlEnv": "RICA_PLUGIN_ACME_RUNTIME_URL"}
```

两个 URL 均指定 `?schema=rica_plugin_acme`。命名规则是 `rica_plugin_` 加插件 ID，连字符转为下划线。部署者预先建立 schema、迁移角色和运行时角色，并通过迁移授予业务操作所需权限。无额外参数的 `pnpm run db:migrate` 或 `rica migrate` 先运行宿主迁移，再依清单顺序运行插件迁移。附带参数时只调用宿主的 Prisma CLI，方便保留 `--help` 和单独指定宿主配置的用法。运行时用自己的 Client 连接该命名空间，使用 `PrismaPg` 时将对应 schema 传给驱动适配器。

## 部署和生命周期

- `RICA_PLUGIN_MANIFEST` 指向部署目录中的 JSON 文件。清单版本为 `1`。第一批接入项包含 `id`、npm `package`、固定 `version` 和 JSON `config`。清单中省略某个包即停用其对外能力。部署者通过锁文件固定实际安装内容。
- 宿主从清单所在目录解析插件包的 `./rica` 导出，核对包清单中的名称和版本，再载入导出的 `ricaPlugin`。插件声明 SDK 版本和能力，宿主拒绝重复 ID、版本不符或不支持的能力。API 扩展只挂在 `/v1/characters/{characterId}/plugins/{pluginId}/…` 下，复用现有会话、来源、请求大小和角色成员权限检查。
- 数据库阶段在启动服务前先应用宿主迁移，再应用启用包的迁移。插件可用自己的 Prisma 迁移目录。部署配置给每个插件分配迁移身份和运行时身份，默认只授予其 PostgreSQL schema。迁移历史在各自命名空间记录。发布任务负责串行化迁移和版本切换，失败时中止部署。停用和卸载保留数据，清除数据由独立维护操作处理。
- 后续的后台工厂接收宿主提供的停止信号，停机时停止领取并等待在途任务。重试和恢复使用持久化的幂等键和明确的插件版本。插件代码在宿主进程中按受信代码部署。需要代码隔离的接入使用独立进程或远程服务。

## 数据接口

1. **读能力**以业务对象为单位。宿主在授权后提供按账号批量查询的能力，插件返回公开资料；对展示字段沿用先分页再补资料的模式。任务资格判断由数据库在排序和限制条数前完成。
2. **事务能力**按业务操作发放。登记、解绑、审批和任务领取使用同一个宿主事务。需要插件内写入时，宿主调用声明过的、带权限边界的数据库操作，限制到当前角色和账号。参数用绑定传递。插件日常查询可继续用自己的 Prisma Client。
3. **活动和统一列表**使用版本化记录结构。受信插件可注册一个只读视图，宿主负责校验登记信息、控制权限、施加角色和类型过滤，并在同一个查询中合并记录。沿用 `(created_at, id, kind, platform)` 全序和微秒时间精度。远程插件可通过带幂等键的事件发布摘要，供宿主维护统一读模型。
4. **可选能力**按清单登记管理 API、Worker、公开状态、UI 构建入口及事件订阅。事件包含版本、作用域和幂等键。审批和真实执行的许可仍由宿主控制。远程接入使用相同业务数据契约，另行提供服务身份和授权。

## 实施顺序与验收

| 阶段 | 验收 |
| --- | --- |
| 包装配和 SDK | 仓库外的包从部署目录加载。角色成员能使用该插件的管理路由，越权请求在调用插件前被拒绝。未配置清单时可按原流程启动。 |
| 插件迁移及第二种能力 | 独立插件使用自己的 Client 建表、读写并升级，宿主生成 Client 不包含其模型。再用 Worker 或只读连接器跑通能力登记、启动失败和停机。 |
| 数据协议与 Newbi 迁移 | 先落地账号、事务和统一活动协议，再将 Newbi 私有表、函数、权限和清理任务迁入插件。验证登记原子性、越权隔离、停用后禁止领取、发送恢复、跨源分页和空库初始化。 |
| 独立服务 | 验证远程插件只凭已授权业务能力接入，并通过事件贡献统一列表。 |

开发验收使用空的专用 PostgreSQL 和 Redis。已有数据的部署需要对迁移历史、数据、外键和执行账本另行验证升级路径。
