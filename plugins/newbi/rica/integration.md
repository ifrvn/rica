# Newbi 服务端装配

Newbi 从[插件 schema](../prisma/schema.prisma)生成独立 Prisma Client。词库查询、待处理回执计数和审核提示词写入使用插件模型，以 `rica_admin_api` 运行。账号绑定、授权和审计使用宿主事务。轮询和发送在事务内切换到 `rica_newbi_poller` 或 `rica_newbi_executor`，通过受限函数取得当前账号的凭证和执行许可。

账号凭据保存在 `rica_plugin_newbi.credentials`。账号列表、运行活动和后台候选查询使用 `rica_plugin_newbi.account_profiles`，视图只返回接入点、Agent ID 和公开资料。凭据写入使用宿主的账号事务。开发时运行 `pnpm run db:generate` 生成宿主和插件的客户端。部署时，`rica migrate` 使用 [migration.prisma](../prisma/migration.prisma) 执行现有 SQL，并在独立的 schema 中记录迁移。

轮询写入 `rica_plugin_newbi.events` 和 `rica_plugin_newbi.event_checkpoints`。两个表随宿主发布迁移，保留账号外键、事件去重键和轮询进度。读取组件通过受限函数领取和提交事件页，管理端读取事件摘要及检查点状态，游标和租约由轮询函数使用。

讨论评估和词库分别写入 `rica_plugin_newbi.discussion_assessments`、`rica_plugin_newbi.author_terms` 和 `rica_plugin_newbi.section_glossary_samples`。评估结果和本轮词库证据在同一事务中提交。保留期任务通过受限函数清理超过 30 天的评估，来源评估删除时级联清理词库证据。

回复提案、审核记录、发送状态和回执存放在 `rica_plugin_newbi.replies`。管理端在宿主授权事务中写入提案和审批，发送端通过受限函数领取和确认发送。

## Newbi 服务端装配 API

下表描述 Newbi 包的具体调用接口。开发其他平台时，用自己的连接配置和协议实现相应能力。通用宿主接入通过 [ManagementPlugin](../../../docs/plugin-development/03-management.md#managementplugin) 完成。

| 导出 | 参数和结果 |
| --- | --- |
| `settings.connectNewbiSettings(read)` | `read(id: string)` 返回 `Promise<{ stage?: PluginStage; config: unknown }>`。结果提供 `isInstalled()`、`readNewbi()` 和 `openNewbi(credential, expectedEndpoint?)`。 |
| `readNewbi()` | 异步返回启用配置的 `{ endpoint: string }` 或 `undefined`。 |
| `openNewbi(credential, expectedEndpoint?)` | 接受账号凭证和可选的预期接入点。返回 `{ connection: { endpoint, credential }, beforeRequest }` 或 `undefined`。调用 `beforeRequest()` 会复核当前接入点，变化时抛错。 |
| `operations.createNewbiOperations(db, store)` | 参数为宿主的 Prisma 客户端和带 `openNewbi` 的配置接口。返回下方四个按操作隔离的回调。 |
| `createNewbiDatabase(databaseUrl)` | 创建以 `rica_admin_api` 运行的 Newbi Prisma Client。调用方负责断开连接。 |
| `management.createNewbiManagement({ host, newbi }, settings, operations)` | 注入两个管理客户端、提供 `readNewbi` 及 `isInstalled` 的设置对象、操作回调，返回 `ManagementPlugin`。 |
| `reader.identifyNewbiAccount(connection, beforeRequest?)` | 核验 Agent Key。返回 `Promise<{ endpoint, agentId, username, avatarUrl } \| undefined>`。无效端点、凭证和核验失败返回 `undefined`。 |
| `reader.startNewbiReader(connection, signal?, beforeRequest?)` | 启动只读组件。参数为连接、可选 `AbortSignal` 和请求前检查。返回 `Promise<{ plugin, stop }>`。 |
| `executor.startNewbiExecutor(connection, beforeRequest?, signal?)` | 启动发送组件，注意可选参数次序与 reader 不同。返回 `Promise<{ plugin, stop }>`。业务发送应走下方的 `sendConnector`，由账本发放许可。 |

回调及参数如下。详细结果字段与 [HTTP 响应](./management/api.md)一致。

| 回调 | 参数 | 异步结果 |
| --- | --- | --- |
| `identifyConnector` | `credential: string`、`endpoint?: string` | `{ endpoint, agentId, username, avatarUrl }` 或 `undefined`。 |
| `pollConnector` | `accountId: string`，Rica 已绑定账号 UUID | 单次读取状态 `READ`、`WAITING`、`STOPPED` 或 `undefined`。 |
| `readConnectorThread` | `{ accountId, agentId, endpoint, postId }`，从已授权提案取得 | `{ post, comments }` 或 `undefined`。核对当前 Agent 和端点后读取。 |
| `sendConnector` | `replyId: string`、`retry: boolean` | `SENT`、`UNAVAILABLE`、`UNKNOWN` 或 `CLOSED` 的发送结果。 |
| `reportConnectorOperation` | `service: 'connector-reader' \| 'connector-executor'`、`succeeded: boolean` | 可选的观测回调，返回 `void` 或 `Promise<void>`。网页读取或发送返回结果后通知宿主，回调失败不影响业务响应。|

已经持有宿主数据库客户端和配置存储时，可以按下例装配，回调中使用的数据库权限由操作工厂切换。

```ts
import { connectNewbiSettings, createNewbiDatabase, createNewbiManagement, createNewbiOperations } from '@ricajs/plugin-newbi'

const settings = connectNewbiSettings(deploymentPlugins.readConfiguration)
const operations = createNewbiOperations(runtimeDb, settings)
const newbi = createNewbiDatabase(databaseUrl)
const newbiManagement = createNewbiManagement({ host: managementDb, newbi }, settings, operations)
// 将 newbiManagement 交给 createManagementApp 的 plugins 数组。
// 服务停止时调用 newbi.$disconnect()。
```
