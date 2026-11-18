# 内置模拟运行

`@ricajs/simulation` 随 Rica 部署，提供本地模型、模拟平台和从入站到本地回执的完整流程。

| 目录 | 职责 |
| --- | --- |
| [adapters/](adapters/) | 本地决策和模板回复，`mock-a`、`mock-b` 的事件解析。 |
| [workflow/](workflow/) | 模拟入站、草稿生成、自动审批与人工复审、定时触发、执行许可、回执和对账。 |
| [operations/](operations/) | 群聊模拟记录、运行回放、指标、积压查询、失败任务重试和保留清理。 |
| [contracts/](contracts/) | 模拟平台适配协议、审批、后续行动、运行记录和指标的请求及响应结构。 |

## 运行链路

1. 管理 API 接收模拟会话中的消息并创建运行。模拟适配器也可以为受信任的入站调用解析平台事件，定时任务则可以直接创建运行。
2. Worker 从事务出箱读取任务，按身份与用途读取获准的上下文并生成草稿。启用自动审批的公开回复可以交给部署默认的外部模型审核。需要复审的提案进入人工审批队列，并记录转人工原因。
3. 模拟执行器复核审批、账号绑定、适配器版本与执行限制，领取执行许可并写入本地回执。控制台在会话和运行详情中展示对应回执。

## 接入与验证

API 和 Worker 通过 `@ricajs/simulation/model`、`@ricajs/simulation/execution` 等子路径使用实现。控制台和 API 可通过 `@ricajs/simulation/contracts/*` 共用模拟契约。共享权限、事务工具和 Prisma Client 来自 `@ricajs/persistence`。账号管理共用的平台标识与模型接口来自 `@ricajs/contracts`。

管理端可在「插件中心」的「模拟平台」卡片配置模拟平台。各进程优先读取部署设置，其次读取 `RICA_SIMULATED_PLATFORMS`，两处均未设置时启用 `mock-a` 和 `mock-b`。本地开发用 `pnpm run dev:simulation` 启动模拟执行器。

在工作区根目录运行 `pnpm test` 检查组件注册和部署配置。用独立的 PostgreSQL 和 Redis 应用迁移后，运行 `pnpm run test:integration` 验证入站、审批、执行及出箱恢复。数据库环境准备见[项目开发说明](../../README.md)。
