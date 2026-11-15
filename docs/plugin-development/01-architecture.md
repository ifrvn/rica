# 1. 选择能力与包结构

## 按调用场景选择接入点

| 能力 | 运行时接入 | 契约与示例 |
| --- | --- | --- |
| 模拟事件解析 | `PluginDefinition<PlatformAdapter>`，通过 `startSimulationPlatforms` 启用 | [最小模拟适配器](02-runtime.md#最小模拟适配器) |
| 认知决策、回复生成 | `PluginDefinition<ModelProvider>`，通过 `startConfiguredModel` 选择 | [模型接口与实现示例](02-runtime.md#modelprovider) |
| 外部平台读取 | 插件专用客户端、受限数据库操作和读取入口，单独报告版本与状态 | [读取能力](04-platform-safety.md#读取) |
| 外部平台写入 | 独立执行能力，配审批、许可、幂等回执及对账 | [写入能力](04-platform-safety.md#写入) |
| 管理与控制台 | `ManagementPlugin` 加控制台贡献，可按需提供账号、设置、审批与健康视图 | [完整管理示例](07-worked-example.md)、[控制台契约](05-console.md) |

一个包可以提供多种能力。假设 `@rica/plugin-acme` 对应部署 ID `acme`，它可以另外登记 `acme-reader` 和 `acme-executor` 作为两个运行组件。包名供工作区依赖解析，部署 ID 用于启停，组件 ID 用于版本绑定，进程 ID 用于状态展示。

## 宿主与插件的分工

| 宿主维护 | 插件维护 |
| --- | --- |
| 会话和角色权限、账号与身份的绑定约束、记忆授权、通用幂等和事务 | 提供方协议、载荷校验、远端身份核验和插件专用配置 |
| PostgreSQL 连接、迁移入口、角色授权、运行队列和模拟执行规则 | 接收宿主依赖的查询实现、平台事件游标、执行账本和专用清理逻辑 |
| API、Worker 和控制台的装配，以及启停、发布版本匹配和状态展示 | 运行组件定义、业务路由、账号表单、设置、审批视图和状态投影 |

模拟流程本身由宿主协调。比如 [simulated-draft.ts](../../packages/persistence/simulated-draft.ts) 按身份和用途读取获准证据，调用模型并保存提案。[simulation-execution.ts](../../packages/persistence/simulation-execution.ts) 复核审批和配额，写本地回执。模拟适配器提供消息解析，本地模型提供决策和回复。

## 建包和装配

1. 在 `plugins/<plugin-name>/` 新建私有 ESM 包。包名用 `@rica/plugin-<plugin-name>`。按实际用途建立 `index.ts`、`contracts.ts`、`management.ts`、`settings.ts`、`persistence/` 或 `console/`，并在 `package.json` 的 `exports` 中公开宿主需要的入口。
2. 在插件清单声明本包直接使用的依赖，内部工作区包使用 `workspace:*`。宿主的依赖声明位于仓库根目录的 [package.json](../../package.json)。新插件路径已包含在 [pnpm 工作区](../../pnpm-workspace.yaml)及 TypeScript 检查范围中。
3. 在 [运行时装配](../../apps/runtime-plugins.ts)、[管理 API 入口](../../apps/api/main.ts)、[部署目录](../../apps/deployment-plugin-contracts.ts)和[控制台装配](../../apps/admin/src/app/plugin-integrations.ts)中登记实际提供的能力。专用协议、文案、表单和持久化代码放在插件包内。
4. 修改依赖后运行 `pnpm install` 更新根锁文件，再用 `pnpm install --frozen-lockfile` 验证。

当前宿主有显式的模拟平台白名单、模型提供方配置、管理响应类型和控制台装配。扩展既有能力时核对相关组合点与数据库约束。接入新的运行能力时，应先定义输入、输出、授权和失败语义，再增加相应的宿主接入。
