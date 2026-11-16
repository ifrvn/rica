# Newbi 服务端装配

Newbi 在 [database.ts](./persistence/database.ts)中复用宿主客户端，在事务内按操作切换到 `rica_newbi_poller` 或 `rica_newbi_executor`，并只读取当前 Rica 账号对应的凭证。数据库连接字符串、部署级 API 接入点和账号凭证分别按连接管理、插件设置和账号验证处理。API 响应、控制台构建包、队列数据和运行日志均应排除真实凭证。插件与宿主共享受信运行环境，数据库角色约束查询权限。

## Newbi 服务端装配 API

下表描述 Newbi 包的具体调用接口。开发其他平台时，用自己的连接配置和协议实现相应能力。通用宿主接入通过 [ManagementPlugin](../../../docs/plugin-development/03-management.md#managementplugin) 完成。

| 导出 | 参数和结果 |
| --- | --- |
| `settings.connectNewbiSettings(read)` | `read(id: string)` 返回 `Promise<{ stage?: PluginStage; config: unknown }>`。结果提供 `isInstalled()`、`readNewbi()` 和 `openNewbi(credential, expectedEndpoint?)`。 |
| `readNewbi()` | 异步返回启用配置的 `{ endpoint: string }` 或 `undefined`。 |
| `openNewbi(credential, expectedEndpoint?)` | 接受账号凭证和可选的预期接入点。返回 `{ connection: { endpoint, credential }, beforeRequest }` 或 `undefined`。调用 `beforeRequest()` 会复核当前接入点，变化时抛错。 |
| `operations.createNewbiOperations(db, store)` | 参数为宿主的 Prisma 客户端和带 `openNewbi` 的配置接口。返回下方四个按操作隔离的回调。 |
| `management.createNewbiManagement(db, settings, operations)` | 注入管理数据库、提供 `readNewbi` 及 `isInstalled` 的设置对象、操作回调，返回 `ManagementPlugin`。 |
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
import { connectNewbiSettings, createNewbiManagement, createNewbiOperations } from '@rica/plugin-newbi'

const settings = connectNewbiSettings(deploymentPlugins.readConfiguration)
const operations = createNewbiOperations(runtimeDb, settings)
const newbiManagement = createNewbiManagement(managementDb, settings, operations)
// 将 newbiManagement 交给 createManagementApp 的 plugins 数组。
```
