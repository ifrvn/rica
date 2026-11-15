# 5. 控制台契约、组件 API 与系统运行状况

插件的 Vue 组件、浏览器请求、中文文案和视图状态放在 `plugins/<plugin-name>/console/`。在插件清单导出相应入口，再到 [控制台装配](../../apps/admin/src/app/plugin-integrations.ts)登记能力。浏览器入口可以使用共享契约及 [console-shared](../../packages/console-shared/package.json) 提供的请求与任务状态工具。检查依赖树，避免把数据库、服务端密钥存储或服务器专用客户端带进浏览器构建。

## 插件卡片和设置组件

部署目录里的每个 ID 在 `pluginNames` 和 `pluginCards` 中提供名称及卡片描述。卡片负责配置入口文案、组件列表、配置摘要和编辑器参数。卡片内编辑器通过 `inlineEditor` 与 `settingsChange(value)` 提交宿主部署配置，独立编辑器可以调用插件自己的路由。宿主页面负责安装、启用、停用和版本冲突反馈。

| 字段 | 类型与用途 |
| --- | --- |
| `description` | 字符串，说明插件能力。 |
| `editor` | Vue `Component`，设置编辑器。 |
| `inlineEditor?` | 布尔值，开启卡片内编辑模式。 |
| `components(status?)` | 返回 `{ id: string, label: string, detail: string, version?: string }[]`。状态对象至少可读到 `services[]`，元素含 `service` 和 `catalog`。初次渲染状态可能为 `undefined`。 |
| `summary(deployment)` | 返回设置摘要字符串。 |
| `configureLabel(deployment)` | 返回设置按钮名称。 |
| `editorProps(deployment)` | 返回通过 `v-bind` 传给编辑器的对象。 `deployment` 包含版本、各插件状态、公开配置与 `configuredModel`。 |
| `accountLink?(status?)` | 返回是否显示账号池入口的布尔值。 |
| `settingsChange?(value)` | 卡片内模式使用，把表单提交的单个字符串转换为部署动作对象。 |
| `upgradeStep?` / `invalidSettings?` | 自定义升级步骤和无效配置提示。 |
| `upgradeQueue?(status?)` | 返回当前角色需核对的队列 `{ label: string, status: string, count: number }[]`。未取得数据时返回 `undefined`。有审核权限时，`status` 用于打开对应的提案筛选。 |

| 编辑器模式 | 额外 props | 宿主监听 |
| --- | --- | --- |
| 卡片内 | `busy: boolean` | `close()`，`save(value: string)` |
| 独立编辑器 | `canStartSimulation: boolean` | `close()`，`expired()`，`saved()` 后刷新状态，`simulate()` 打开模拟 |

下面的设置编辑器用于示例插件的超时配置，文件名为 `TimeoutEditor.vue`。

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ value: string; busy: boolean }>()
const emit = defineEmits<{ close: []; save: [value: string] }>()
const value = ref(props.value)
watch(() => props.value, (next) => { value.value = next })
</script>

<template>
  <form @submit.prevent="emit('save', value.trim())">
    <label>
      请求超时（毫秒）
      <input v-model="value" inputmode="numeric" pattern="[0-9]+" required :disabled="busy" />
    </label>
    <button type="button" :disabled="busy" @click="emit('close')">取消</button>
    <button type="submit" :disabled="busy || !value.trim()">保存超时</button>
  </form>
</template>
```

将以下卡片和显示名称登记在 `acme` 下。卡片使用[同一示例的配置贡献](03-management.md#部署与配置存储)，宿主按 schema 验证超时范围。

```ts
import TimeoutEditor from './TimeoutEditor.vue'

type Deployment = { acme: { timeoutMs: number } }

export const acmeCard = {
  description: '读取 Acme 平台事件。',
  editor: TimeoutEditor,
  inlineEditor: true,
  components: () => [{ id: 'acme-reader', label: '读取消息', detail: '读取账号收件箱' }],
  summary: (deployment: Deployment) => '请求超时 ' + deployment.acme.timeoutMs + ' ms',
  configureLabel: () => '设置超时',
  editorProps: (deployment: Deployment) => ({ value: String(deployment.acme.timeoutMs) }),
  settingsChange: (value: string) => ({ action: 'CONFIGURE_ACME', timeoutMs: Number(value) }),
}
```

## 账号池贡献

在 `platformAccounts` 注册平台。新增字段时同步更新[浏览器插件状态组合](../../apps/plugin-status-view.ts)和控制台装配中的账号、工作区类型。异步核验期间禁用重复提交，切换平台或角色时重置敏感状态，凭证变化后使旧预览失效。用 `active()` 防止迟到的响应更新已关闭或切换的视图。

主对象包含 `platform: string`、`Form`、`Label`、`Details`、`pauseMessage`、`resumeMessage`、`resumeError`、`label(account)`、`labelProps(account)` 和 `use(context)`。三个消息字段为字符串。 `label(account)` 返回名称字符串或 `undefined`，`labelProps(account)` 返回资料组件的 props 对象或 `undefined`。账号基础字段包括字符串 `id`、`platform`、`instanceKey`，以及已绑定记录上的 `identityId`、`status`、`version`。

| `use(context)` 参数 | 签名和用途 |
| --- | --- |
| `base()` | `() => string`，返回当前角色 API 前缀，包含 `/v1/characters/<id>`。 |
| `run(task)` | `(task: () => Promise<void>) => Promise<void>`，用页面忙碌状态运行任务。 |
| `active()` / `refresh()` | `() => boolean` 判断页面仍活动，`() => Promise<void>` 重新读取页面数据。 |
| `clearError()` / `error(message)` | 清除页面错误及待重试登记，或显示给定的错误字符串。 |

| `use` 返回项 | 签名和用途 |
| --- | --- |
| `sync(status?)` | 消费最新插件状态和部署设置。 |
| `choices(workspace?)` | 返回 `{ label: string, value: string, disabled?: boolean }[]`。`value` 取平台 ID。 |
| `formProps()` | 返回登记表单 props 对象，可附加事件处理器，如 `onTest`、`'onUpdate:credential'`。 |
| `ready()` | 返回登记是否允许提交。 |
| `parse()` | 返回 `{ success: true, data: object }` 或 `{ success: false, error: { issues: { path: PropertyKey[] }[] } }`。成功数据作为账号登记请求体。 |
| `reset()` | 清除表单、凭证和核验预览。 |
| `registrationError(cause)` | 接受 `unknown`，返回插件专用提示字符串或 `undefined` 以使用通用提示。 |
| `checkingAccount` | 含 `value: string \| undefined` 的引用，表示正在核验的账号 ID。 |
| `check(account)` / `accountCheckLabel(account)` | 启动账号核验，或返回该账号的状态提示字符串。 |
| `canCheck(account)` / `canRefreshProfile(account)` | 返回是否可核验连接或补齐资料。 |
| `canPropose(account, identityStatus?, characterStatus?)` | 返回是否开放真实平台提案入口，两个状态参数为可选字符串。 |

`Form` 收到 `formProps()` 的结果以及 `busy: boolean`。凭证表单可以接收 `credential: string` 和可选的 `preview: { accountId: string, name: string }`，发出 `update:credential(value)` 和 `test()`。这些字段由插件和自己的表单约定，宿主读取 `ready()` 与 `parse()` 决定能否提交。`Label` 的 props 来自 `labelProps()`。

`Details` 的 props 为 `characterId`、`accountId`、`accountStatus`、`accountLabel`、`identityLabel` 五个字符串，以及布尔值 `canReview`、`canPropose`。宿主监听 `expired()` 和 `proposals(accountId: string, proposalId?: string)`。

## 审批页面

`platformReviews` 的一项包含 `id: string`、`title: string`、`component: Component`、`installed(workspace): boolean`、`deployed(deployment): boolean`。账号详情跳转时用平台 ID 选择同名审批项。

审批组件接收 `characterId: string`、可选的 `detailId: string`、`accountId: string`、`statusFilter: string`，以及布尔值 `canReview` 和 `canManage`。事件签名为 `open(id?: string)`、`all()`、`expired()` 和 `filter(status: string)`。`open(reply.id)` 切换到提案详情，`open()` 回到筛选列表，`all()` 去掉账号筛选，`filter(status)` 更新链接中的状态。插件应校验收到的状态值。

账号详情可以发出 `proposals(accountId, proposalId?)`，宿主形成带插件 ID 的审批链接。路由位于 `#/characters/<characterId>/connector[/<proposalId>]`，查询参数 `plugin` 选择审批组件，`accountId` 限定列表。账号入口使用平台 ID 作为审批插件 ID，登记时保持两者一致。提案正文、目标、受众、动作名称和执行后果应直接可见。前端权限用于展示入口，服务端按操作重新验证。

可选的 `workbench(characterId: string, canManage: boolean)` 向工作台贡献已获授权的待办预览。返回 `Promise<{ status: string; label: string; items: { id: string; title: string; createdAt: string }[] }[]>`。每组的 `status` 同时用于预览查询和审批链接，记录的 `id` 用于打开详情。按 `canManage` 选择适用的队列，服务端继续校验角色和资源权限。

审批组件可接收 `canInspect: boolean`，在用户有账号和审计访问权时发送 `account(accountId: string)` 或 `audit(targetId: string)` 跳转。插件可以提供 `ownsAudit(operation: string): boolean`，让有审批权限的用户从对应操作记录打开提案。仅对确实以提案 UUID 为目标的操作返回 `true`。

## 系统运行状况与审计

插件提供状态到 [HealthNode](../../packages/console-shared/health.ts) 的映射，在[系统运行状况](../../apps/admin/src/features/health/SystemHealth.vue)对应层装配。将「已启用」「已配置」「最近核验成功」「进程在线」分别表达。单次命令完成只代表最近一次运行成功。PostgreSQL 和 Redis 的就绪探测由宿主提供。

补充插件操作的审计文案时，在插件内声明操作标签，并在控制台装配入口组合。复用宿主主题和间距。验证窄屏、深色模式、键盘焦点、空态、出错回退及下拉列表在对话框中的可见性。对审批、发送等高影响操作，使用明确的动作按钮和确认信息。

### 健康节点与浏览器请求

```ts
type HealthNode = {
  id: string
  label: string
  description: string
  state: string
  tone: 'default' | 'success' | 'warning' | 'error'
  at?: string
  diagnostic?: string
}
```

示例节点为 `{ id: 'acme-api', label: 'Acme API', description: '核验平台连接', state: '等待核验', tone: 'default' }`。在系统运行状况对应层装配生成函数。时间和诊断分别放在 `at` 和 `diagnostic`。

| 导入 | API |
| --- | --- |
| `@rica/console-shared/request` | `request<T>(url: string, init?: RequestInit): Promise<T>`，携带同源 Cookie，使用 10 秒超时并返回解析后的 JSON。HTTP 错误抛出 `RequestError`，含 `status: number` 与可选 `code: string`。 |
| `@rica/console-shared/console-data` | `characterPath(id)` 返回角色 API 前缀。`queryPath(path, params)` 编码查询参数。 |
| `@rica/console-shared/console-data` | `useConsoleTask(expired)` 在组件 setup 中使用，提供 `busy`、`error`、`notice`、`active()`、`run(task)` 和 `command(path, payload, method?, version?)`。给定版本时发送 `If-Match`，否则同一次重试保留幂等键。 |
