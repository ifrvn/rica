# 4. 平台读写、凭据与数据库权限

[调用边界](#调用边界) · [凭据与存储](#凭据与存储) · [事件读取](#读取) · [平台写入](#写入) · [故障验收](#故障验收)

## 调用边界

Rica 通过 [`PluginDefinition<T>`](02-runtime.md#生命周期与注册)管理运行组件，通过 [`ManagementPlugin`](03-management.md#managementplugin) 挂载管理路由和账号回调。当前外部平台的事件分页、发送、回执和对账由各插件定义，宿主还没有统一的 `PlatformReader` 或 `PlatformExecutor` 接口。本章的 Acme 类型是插件内部设计示例，用来把宿主授权、受限数据库操作和平台请求接起来。

| 能力 | 入口交给插件的数据 | 插件应保留的业务检查 |
| --- | --- | --- |
| 查公开账号资料 | 已授权的角色、待核验凭证、当前启用的端点 | 比对平台返回的身份，按声明的公开 schema 投影。 |
| 读取外部事件 | Rica 已绑定的 `accountId`、本次停止信号 | 从绑定取得远端账号、读取凭证和游标。只读取该账号可见范围。 |
| 创建提案 | 当前角色与操作者、已绑定账号、目标、正文 | 固定公开受众、最终正文、账号绑定版本和执行组件版本，并形成审核摘要。 |
| 执行与恢复 | 已授权的 `proposalId`、首次或恢复标志、本次停止信号 | 从原提案和持久化许可取正文、目标及幂等键。操作参数由账本确定。 |

管理路由先使用 `authorize(tx, scope)` 核对调用者，再用当前 `characterId` 查询目标记录。后台操作从已验证的运行或提案解析账号。读取与发送各自复核部署状态、账号绑定和操作范围，控制台按钮仅表示当前展示权限。

## 凭据与存储

从宿主接收数据库客户端或限定到当前操作的接口。插件把协议查询、游标、回执和数据清理实现放在自己的 `persistence/` 中。需要新表、索引、引用约束或数据库角色时，通过宿主的 [Prisma schema](../../prisma/schema.prisma) 与共享[迁移](../../prisma/migrations)交付，按[数据库角色说明](../database-roles.md)测试最小授权。

数据库连接由宿主提供。外部读取与执行分别使用受限操作接口，按当前账号和操作取用凭证。若通过连接池切换数据库角色，使用事务级角色切换，事务结束后连接恢复。API 响应、控制台构建包、队列数据和运行日志均应排除真实凭证。插件与宿主共享受信运行环境，数据库角色约束查询权限。

### 配置、绑定与权限

| 数据 | 用途与归属 |
| --- | --- |
| 部署设置 | 控制台保存启用状态和 API 地址。插件验证协议、允许的主机、端口或路径，按允许策略检查重定向。账号表单只选择部署允许的服务。 |
| 账号凭证 | 按平台、端点和经过核验的远端账号保存。服务端调用读取或写入时按绑定取用。配置和账号响应可返回核验时间、公开资料或凭证是否存在。 |
| Rica 绑定 | 宿主管理 `characterId`、`identityId`、`accountId` 与绑定版本。插件同时核对远端账号与端点，避免换绑或变更地址后沿用旧连接。 |
| 读取权限 | 读取受限账号信息和游标，写入事件及读取状态。 |
| 执行权限 | 查询获批提案及当前绑定，申请许可，更新尝试和回执。审批决定由对应的管理流程写入。 |

把数据库角色、约束和函数放入共享迁移，由宿主部署。连接池中的事务执行顺序是开启事务、切换到固定的操作角色、执行参数化查询、提交或回滚。角色名取固定的服务端值，查询参数使用绑定变量。对应用登录执行权限测试，覆盖读取角色申请发送许可、执行角色访问其他角色账号、事务结束后的角色恢复。

账号停用、解绑、凭证撤销或端点变更时阻止新请求。对已启动的调用，在每次出站请求前读取当前配置，响应入账前再复核绑定和版本。对于此前已发出的写请求，保留对账入口和原发送记录。

## 读取与写入是独立的能力

### 读取

一次读取分为**取得当前读权限 → 请求一页 → 验证响应 → 原子提交事件及游标**。游标是平台返回的不透明字符串，按原值保存。事件去重键选择平台为同一事件稳定提供的 ID，数据库至少按账号和事件键建唯一约束。平台文本以不可信输入处理，摘要视图按权限取出需要的字段。

下面是插件内部的一页读取函数。平台协议校验和持久化由注入的依赖提供。HTTP 请求在数据库事务外执行，`commit()` 在事务内比较读取快照，再插入事件及保存下一游标。

```ts
type ReadLease = {
  accountId: string
  bindingVersion: number
  endpoint: string
  cursor: string | null
  leaseId: string
}
type EventPage = {
  events: { eventId: string; occurredAt: string; resourceId: string }[]
  nextCursor: string | null
  historyGap: boolean
}
type ReadOperations = {
  acquire(accountId: string): Promise<ReadLease | undefined>
  fetchPage(lease: ReadLease, signal: AbortSignal): Promise<EventPage>
  commit(lease: ReadLease, page: EventPage): Promise<boolean>
  release(lease: ReadLease): Promise<void>
}

export async function readOnce(ops: ReadOperations, accountId: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const lease = await ops.acquire(accountId)
  if (!lease) return 'UNAVAILABLE'

  try {
    signal.throwIfAborted()
    const page = await ops.fetchPage(lease, signal)
    signal.throwIfAborted()
    return await ops.commit(lease, page) ? 'COMMITTED' : 'STALE'
  } finally {
    await ops.release(lease)
  }
}
```

| 参数或结果 | 实现要求 |
| --- | --- |
| `acquire(accountId)` | 使用本地账号 UUID。事务内验证角色、身份、账号、端点及退避状态，并获得带期限的账号租约。当前有租约或账号不可读时返回 `undefined`。 |
| `fetchPage(lease, signal)` | 发送前重验端点和绑定，按当前账号获取读取凭证。限制响应大小、页长和请求时间，校验事件与游标。 |
| `commit(lease, page)` | 复核租约、绑定版本、账号启用状态与起始游标。在同一事务按唯一键写事件、推进游标、记录历史缺口并更新最近成功时间。条件失效时返回 `false`。 |
| `release(lease)` | 以 `leaseId` 为条件释放本次租约，避免清掉另一个任务的新租约。进程中断时靠期限回收。 |
| `COMMITTED`、`STALE`、`UNAVAILABLE` | 分别表示运行提交、结果失效、当前无法取得读取许可。成功提交的事件数可以为零。 |

空页也保存平台给出的下一游标。重复事件通过唯一约束去重。游标过期时如果平台给出重置位置，记录历史缺口并原子保存新位置。限流或暂时不可用时保存可重试时间，读取任务按平台提供的等待时间退避。凭证失效时停止并显示可操作的核验提示。

单次命令记录最近一次结果。持续轮询需要显式接入进程生命周期，通过租约控制并发，通过 `AbortSignal` 停止请求和等待。停止接纳新任务后，释放租约及客户端资源。读取入口可以独立于决策与写入运行。

### 写入

写入链路分成提案、审批、许可、出站请求和对账。以下字段是账本设计建议，状态名称可按平台实现。

| 阶段 | 持久化的数据或校验 |
| --- | --- |
| 提案 | 目标平台、端点、角色、身份、账号、账号绑定版本、远端目标、受众和最终正文。先附加适用的披露，再计算摘要。 |
| 审批 | 操作者、决定、审批时间、有效期及审核摘要。摘要绑定目标、正文、授权版本和执行实现。 |
| 许可 | 在事务里查最新状态，通过唯一约束、行锁或条件更新取得执行尝试。记录尝试 ID、许可期限、组件 ID 与版本、用于外部请求的原始幂等键。 |
| 发送 | 从许可和提案取目标、正文、账号与幂等键。请求前复核是否仍可发送，使用有限超时。 |
| 回执 | 对应原提案和本次尝试，写远端回执 ID、状态和时间。结果落库采用条件更新，保留可验证的关联关系。 |

下面的执行函数展示了进程边界。它只在拿到持久化许可后请求平台。实际的审批与状态校验放在 `claim()`，实际的协议判定放在 `send()`。取消信号在请求发出后仍可能对应已成功的远端操作。

```ts
type Permit = {
  attemptId: string
  proposalId: string
  destination: string
  content: string
  idempotencyKey: string
}
type Delivery =
  | { state: 'SENT'; remoteReceiptId: string }
  | { state: 'NOT_SENT'; code: string }
  | { state: 'UNKNOWN'; code: string }
type WriteOperations = {
  claim(proposalId: string, retry: boolean): Promise<Permit | undefined>
  send(permit: Permit, signal: AbortSignal): Promise<Delivery>
  record(attemptId: string, delivery: Delivery): Promise<void>
}

export async function deliver(ops: WriteOperations, proposalId: string, retry: boolean, signal: AbortSignal) {
  signal.throwIfAborted()
  const permit = await ops.claim(proposalId, retry)
  if (!permit) return { state: 'UNAVAILABLE' } as const

  let delivery: Delivery
  try {
    delivery = await ops.send(permit, signal)
  } catch {
    delivery = { state: 'UNKNOWN', code: 'DELIVERY_UNCONFIRMED' }
  }
  await ops.record(permit.attemptId, delivery)
  return delivery
}
```

| 参数或结果 | 实现要求 |
| --- | --- |
| `claim(proposalId, retry)` | 仅接受可执行状态。复核审批有效期、审核摘要、角色及账号版本、启用状态和实现版本。恢复原提案时保留原目标、正文和幂等键，以新的尝试 ID 记录本次领取。 |
| `send(permit, signal)` | 请求前最后检查许可，按许可的目标与正文发送。明确确认请求前已阻断或平台明确保证无写入时返回 `NOT_SENT`。收到可验证的远端回执时返回 `SENT`。 |
| `record(attemptId, delivery)` | 按尝试 ID 验证账本归属并写回执或失败状态。对已确认回执提供重复提交去重。若回执写入数据库失败，保留在途记录供恢复。 |
| `UNKNOWN` | 超时、响应丢失或远端结果无法验证时保留该状态。后续通过远端核对或平台明确支持的幂等机制恢复。 |

### 恢复、审计与保留期

- 进程在领取许可后崩溃时，先读取原尝试并等待许可到期。远端已找到对应结果时登记回执。远端支持同一幂等键重试且原审批和绑定仍有效时，可以按原提案恢复。平台缺少可核对结果的方式或幂等保障时，由操作员人工核对和结案。
- 平台返回限流时，保存下次可用时间并遵循账号级限额。出现端点、主体、实现版本或授权变更时重新校验，旧审批按当前规则处理。
- 审计记录操作员、提案和尝试 ID、组件及版本、时间和脱敏错误码。将正文及回执限制在授权视图。清理任务可在保留期到期后去除正文和事件数据，保留必要的审核摘要、确认回执和仍待核对的关联记录。

模拟执行写本地账本，真实平台写入使用独立的实现和账本。开发验收使用本地协议夹具，核对权限失败、禁用、并发、重试和响应丢失等场景。

## 故障验收

| 场景 | 需要观察的结果 |
| --- | --- |
| 凭证属于另一账号，或调用者跨角色访问 | 请求在授权边界被拒绝，账号资料及回执保持隔离。 |
| 空页、重复页、游标过期 | 空页推进游标，重复页去重，过期重置可查到历史缺口。 |
| 并发读取，或读取途中暂停账号 | 同一读快照只提交一次，失效结果无法新增事件或覆盖新游标。 |
| 已审核的正文、绑定或组件版本被替换 | 旧审核无法发放新许可，远端请求计数为零。 |
| 同一提案并发发送 | 每次许可只允许一个发送者，限额和状态在账本中一致。 |
| 远端已写入但响应丢失，或回执写库失败 | 提案可按原键恢复，远端操作和本地回执各只确认一次。 |
| 凭证撤销、限流、停用插件 | 新调用被拦截或延后，在途写入结果仍可核对。 |
| 数据库角色与保留期 | 受限角色无法越权读取或发放许可，清理后必要审计依然可用。 |

相关运行命令及测试入口见[本地验证](06-verification-release.md#从本地启动到验收)。
