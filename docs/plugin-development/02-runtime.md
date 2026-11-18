# 2. 运行时契约、API 与实现示例

## 生命周期与注册

组件实现版本用于依赖追踪和审批绑定。更新会影响已批准操作的实现时，验证旧许可如何处理。

1. 按能力索引定义，检查重复 ID、契约版本与选择项。
2. 有配置的组件通过 `prepare` 解析配置，并返回持有已解析值的工厂。无配置的组件直接声明 `create`。宿主同时用 `services` 检查 `requires` 声明的服务是否可用。
3. 调用工厂取得 `implementation` 以及可选的 `start`、`stop`。异步资源在 `start` 打开，并由 `stop` 释放。组件启动后通过 `find(id)` 取得。
4. 必需组件故障会中止启动并清理已启动资源。可选组件的配置、依赖或启动失败通过 `report` 上报，该组件不可用。宿主停止时先移除查找条目，再按相反顺序清理。

从 `@ricajs/plugin-host` 导入类型和函数。

```ts
type PluginIdentity = { id: string; version: string; contractVersion: number }
type Plugin<T> = PluginIdentity & Readonly<{ implementation: T }>
type PluginInstance<T> = Readonly<{
  implementation: T
  start?: () => void | Promise<void>
  stop?: () => void | Promise<void>
}>
type CreatePlugin<T> = () => PluginInstance<T>
type PluginDefinition<T> = PluginIdentity & Readonly<{ requires?: readonly string[] } & (
  { create: CreatePlugin<T>; prepare?: never } |
  { prepare: (config: unknown) => CreatePlugin<T>; create?: never }
)>
```

| 参数 | 类型与含义 |
| --- | --- |
| `id` | 能力内唯一的稳定组件 ID。需要出现在状态目录时，使用 1–80 个小写字母、数字或连字符。 |
| `version` | 组件实现版本。状态目录和发布清单使用三段数字。 |
| `contractVersion` | 当前必须为 `1`。 |
| `requires` | 必需服务名列表，逐一匹配启动时的 `options.services`。 |
| `prepare(config)` | 解析配置并返回工厂。配置无效时抛出异常，宿主报告 `INVALID_CONFIG`。在此阶段只解析配置。 |
| `create()` | 无配置插件使用的工厂。此时宿主只接受 `undefined`。 |

```ts
startPluginHost<T>(
  kind: string,
  definitions: readonly PluginDefinition<T>[],
  selections: readonly { id: string; config?: unknown; optional?: boolean }[],
  options?: {
    services?: ReadonlySet<string>
    report?: (diagnostic: { kind: string; id: string; version?: string; code: string }) => void
  },
): Promise<{ find(id: string): Plugin<T> | undefined; stop(): Promise<void> }>
```

`kind` 是宿主传入的能力分类。`definitions` 为允许注册的定义，`selections` 决定本次启动的实例。`optional` 默认 `false`。启动后用 `find` 取实例，停止后查找返回 `undefined`。`report` 用于状态反馈，应可以安全地同步调用。

必需项失败时抛出 `PluginHostError`，错误的 `diagnostic` 含 `kind`、`id`、可选的 `version` 和 `code`。常见代码如下。

| 代码 | 条件 |
| --- | --- |
| `DUPLICATE_PLUGIN` / `DUPLICATE_SELECTION` | 定义或选择列表出现重复 ID。 |
| `INVALID_MANIFEST` / `INCOMPATIBLE_CONTRACT` | 注册身份为空或契约版本不受支持。 |
| `UNKNOWN_PLUGIN` / `INVALID_CONFIG` / `MISSING_SERVICE` | 当前选择缺定义、配置未通过或缺少依赖。 |
| `START_FAILED` / `STOP_FAILED` / `READY` | 生命周期诊断。`STOP_FAILED` 通过回调报告，宿主继续清理其他实例。 |

启动示例可以在仓库根目录的 TypeScript 脚本中运行。

```ts
import { startPluginHost, type PluginDefinition } from '@ricajs/plugin-host'

type Counter = { next(): number }

const counter: PluginDefinition<Counter> = {
  id: 'demo-counter',
  version: '1.0.0',
  contractVersion: 1,
  prepare(config) {
    if (typeof config !== 'number' || !Number.isSafeInteger(config)) throw new Error('Expected an integer')
    return () => {
      let current = config
      return { implementation: { next: () => ++current } }
    }
  },
}

const host = await startPluginHost('demo', [counter], [{ id: 'demo-counter', config: 40 }])
try {
  const plugin = host.find('demo-counter')
  if (!plugin) throw new Error('Counter unavailable')
  console.log(plugin.implementation.next()) // 41
} finally {
  await host.stop()
}
```

## 模拟平台适配器

`@ricajs/simulation/contracts/platforms` 提供以下类型。

```ts
type PlatformAdapter = { normalize(payload: unknown): NormalizedPlatformEvent }
type NormalizedPlatformEvent = {
  remoteAccountId: string
  remoteConversationKey: string
  remoteContactKey?: string
  sourceKey: string
  messageText: string
  kind: 'POST' | 'REPLY' | 'MENTION'
  occurredAt: Date
}
```

| 字段 | 用途 |
| --- | --- |
| `remoteAccountId` | 远端账号唯一标识。宿主将其与已验证账号及数据库绑定比对。 |
| `remoteConversationKey` / `remoteContactKey` | 平台内会话键和可选的联系人键，用于解析本地会话、联系人。私聊应提供正确联系人。 |
| `sourceKey` | 对同一个源事件稳定的键，重投时保持相同，用于去重。 |
| `messageText` | 消息文本。内置模拟适配器限制为 4000，并拒绝空白文本和 NUL。 |
| `kind` / `occurredAt` | 事件类型和发生时间。`occurredAt` 必须是有效的 `Date`。 |

`normalize` 同步执行，输入无效时抛错。宿主提供的 `ResolveSimulationPlatform(id)` 返回完整平台插件或 `undefined`，`ResolveSimulationAdapter(id)` 只返回 `{ adapterId, adapterVersion, adapterContractVersion }` 或 `undefined`，供许可和绑定校验。真实平台的读写使用独立能力。

### 最小模拟适配器

例如在 `plugins/acme-simulation/index.ts` 提供一个读取简化消息的适配器。

```ts
import { maxSimulatedTextLength, type PlatformAdapter } from '@ricajs/simulation/contracts/platforms'
import type { PluginDefinition } from '@ricajs/plugin-host'
import { z } from 'zod'

const inbound = z.object({
  id: z.string().trim().min(1).max(256),
  account: z.string().trim().min(1).max(256),
  thread: z.string().trim().min(1).max(256),
  text: z.string().min(1).max(maxSimulatedTextLength),
  occurredAt: z.iso.datetime(),
})

export const acmeSimulation: PluginDefinition<PlatformAdapter> = {
  id: 'acme-simulation',
  version: '1.0.0',
  contractVersion: 1,
  create: () => ({
    implementation: {
      normalize(payload) {
        const event = inbound.parse(payload)
        return {
          sourceKey: event.id,
          remoteAccountId: event.account,
          remoteConversationKey: event.thread,
          messageText: event.text,
          kind: 'POST',
          occurredAt: new Date(event.occurredAt),
        }
      },
    },
  }),
}
```

包清单导出 `./index.ts`，声明 `@ricajs/simulation`、`@ricajs/plugin-host` 与 `zod` 依赖。宿主将适配器加入 [模拟运行时的定义列表](../../apps/runtime-plugins.ts)之后，可用 `startPluginHost` 和内存夹具验收 `normalize`，覆盖非法时间、非法载荷和最大长度。

运行时注册完成后，完整的模拟账号、审批和执行接入还需要扩展 [simulationPlatformId](../../packages/contracts/management/index.ts) 及数据库中的模拟平台约束。检查 [模拟执行规则](../simulation-execution.md)，用同一允许列表配置 API、Worker 和模拟执行器。宿主复核已绑定的远端账号、身份、会话和适配器版本，适配器负责校验并返回稳定的来源键和远端标识。

## ModelProvider

外部模型可以在本地判断是否回复，由供应商生成公开模拟的正文。`hostedModel` 标记使用外部写作的实现，供宿主选择私密场景的本地模型和记录版本。

1. 在 `hosted-models` 的[提供方目录](../../plugins/hosted-models/providers/catalog.ts)登记 `id`、`name` 和 `requiresBaseUrl`，并在插件内实现请求构造和响应解析。现有表单支持模型 ID、API 密钥和由 `requiresBaseUrl` 控制的 HTTPS 基础地址。
2. [模型装配入口](../../apps/runtime-plugins.ts)注册一个 `hosted-models` 定义。`prepare` 接收保存后的 `{ provider, model, apiKey, baseUrl? }`，按提供方解析配置并返回工厂。
3. 在插件中心安装并启用「外部模型」，添加命名配置并运行连接检查。在身份设置里选择公开草稿模型。多个身份可以引用同一配置，也可以使用同一提供方的不同配置。[模型设置测试](../../plugins/hosted-models/tests/model-settings.test.ts)使用模拟响应验证配置隔离及插件生命周期。

供应商请求使用本次写作所需的消息、写作指令和获准公开引用的摘录。外部回复应通过响应结构校验，错误用 [ModelProviderError](../../packages/contracts/runtime/model-provider.ts) 的脱敏错误码表示。连接测试使用固定输入，与角色运行、记忆检索和真实发言分开。

`@ricajs/contracts/model-provider` 提供 `ModelProvider`、`ModelEvidence`、`WritingStyle` 和 `ModelProviderError`。两个方法都返回 `Promise<unknown>`，宿主按下表校验结果。

| 方法 | 输入 | 接受的输出 |
| --- | --- | --- |
| `decide(input, signal)` | `text: string`、`evidence: readonly ModelEvidence[]`、`context: RunContinuity` | 字面量 `'REPLY'` 或 `'NO_OP'`。 |
| `write(input, signal)` | `text`、`evidence`、`style: WritingStyle`、`time: RunTime`、可选的 `identityPrompt: string`、`suggestFollowUp: boolean` | `{ text: string, evidenceIds: string[], followUp?: ModelFollowUp }`。正文须非空、最多 4000 个 JavaScript 字符串代码单元。引用 ID 必须来自该次写作的证据，且每个 ID 只出现一次。 |

- `signal` 为 `AbortSignal`。本地实现可调用 `signal.throwIfAborted()`，外部请求将其传入请求客户端。
- `ModelEvidence` 为 `{ id: string, revision: number, content: string }`。决策证据与写作证据按目的独立授权。
- `WritingStyle` 为 `neutral | formal | casual | concise`。
- 可选属性 `hostedModel: string` 表示外部写作模型名。宿主据此选择私密场景的本地模型，并记录外部模型标识。
- 可选属性 `hostedProvider: string` 记录草稿实际使用的外部提供方。
- `new ModelProviderError(code, status?)` 用于模型请求失败。代码为 `HTTP_ERROR | REQUEST_FAILED | INVALID_OUTPUT`，`status` 为可选 HTTP 状态码。

`RunTime` 有 `occurredAt`、`now` 两个 ISO 时间字符串，`timezone` 时区、`localDate` 和 `eventLocalDate` 当地日期字符串，以及 `localHour: number`。决策独有的 `RunContinuity` 字段如下。

| 字段 | 类型与语义 |
| --- | --- |
| `runId`、`characterId`、`identityId`、`accountId`、`triggerId` | 此次运行关联的 ID 字符串。 |
| `bindingVersion`、`mode`、`platform`、`instanceKey` | 账号绑定版本数字、字面量 `SIMULATION`、平台和实例键。 |
| `conversationId`、`contactId` | 字符串或 `null`。 |
| `time`、`recent` | `RunTime` 和近期 `{ kind: string, occurredAt: string }` 列表。 |
| `nextCommitmentAt`、`nextScheduleAt` | 时间字符串或 `null`。 |
| `relationship` | `{ confirmedInteractions: number, lastConfirmedAt: string \| null }` 或 `null`。 |
| `goals` | `{ id, version, origin, title, budget, priority, dueAt, nextStep }[]`。版本、预算和优先级为数字，`origin` 为 `ADMIN \| SELF`，`nextStep` 可为 `null`，其余为字符串。 |
| `self` | `{ coreVersion: number, name: string \| null, fictionalBackground: string \| null, facts: ModelEvidence[] }`。 |
| `identityState` | `revision`、`configurationVersion` 可为数字或 `null`，`ruleVersion` 为数字，`sharedEnergy` 为 `LOW \| NORMAL \| HIGH`。另含数字向量 `motivation: { exploration, expression, social, rest }`、`affect: { pleasure, arousal, energy }`。 |
| `beliefs` | `{ id: string, version: number, kind: 'OPINION' \| 'PREFERENCE', statement: string, confidence: number, subjective: true }[]`。 |

最小回复模型可以直接实现为：

```ts
import type { ModelProvider } from '@ricajs/contracts/model-provider'

export const model: ModelProvider = {
  async decide({ text }, signal) {
    signal.throwIfAborted()
    return text.trim() ? 'REPLY' : 'NO_OP'
  },
  async write({ evidence }, signal) {
    signal.throwIfAborted()
    const [first] = evidence
    return first
      ? { text: first.content.trim().slice(0, 4000) || '收到。', evidenceIds: [first.id] }
      : { text: '收到。', evidenceIds: [] }
  },
}
```

### 后续事项

当 `suggestFollowUp` 为 `true` 时，`write` 可以附带一个 `followUp`。宿主检查格式、时间窗口、参与账号绑定及后续审批结果。

| 字段 | 类型与限制 |
| --- | --- |
| `kind` | 必填，`PLAN` 或 `COMMITMENT`。 |
| `title` | 必填，去首尾空白后 1–72 字符，无控制字符。 |
| `task` | 必填，具体事项。去首尾空白后 1–300 字符，无 NUL。 |
| `dueAt` | 一次性事项的 ISO UTC 时间。宿主接受 `time.now` 之后七天内的建议。 |
| `dailyAt` | 每日计划的当地时间，格式 `HH:mm`。`PLAN` 可在 `dueAt` 和 `dailyAt` 中选一项。`COMMITMENT` 使用 `dueAt`。 |
| `additionalTasks` | `PLAN` 可用，最多两条 `{ platform: string, task: string }`。事项约束与 `task` 相同。 |
| `collaboratorPlatforms` | `COMMITMENT` 可用，最多两个平台 ID。平台 ID 使用 1–80 个小写字母、数字或连字符。额外事项的 `platform` 遵循相同规则。 |

```json
{
  "text": "我会每天核对报名名单。",
  "evidenceIds": [],
  "followUp": {
    "kind": "PLAN",
    "title": "核对报名",
    "task": "查看活动页报名名单并记录人数。",
    "dailyAt": "09:00"
  }
}
```

建议的 schema 位于 [模拟后续行动契约](../../packages/simulation/contracts/follow-up.ts)。输入结构对应[模型契约](../../packages/contracts/runtime/model-provider.ts)及[上下文契约](../../packages/contracts/runtime/run-continuity.ts)。
