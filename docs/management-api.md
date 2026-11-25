# 管理 API 启用与使用

管理 API 提供角色配置、人工审批和受保护的 OpenAPI。设置 `RICA_ADMIN_ORIGIN` 后，可使用本地用户名密码或 Passkey 登录。

## 启用

1. 使用迁移账号执行 `pnpm run db:migrate`。管理 API 复用 `DATABASE_URL`，连接时切换到 `rica_admin_api`。
2. 将 `RICA_ADMIN_ORIGIN` 设置为与浏览器地址完全相同的源。本地使用 `http://localhost:5173`。部署使用固定的 HTTPS 地址，Passkey 的 RP ID 使用该地址的主机名。
3. 使用迁移数据库登录初始化系统管理员。启动 API 后访问控制台登录。

## 本地账号与会话

在终端运行添加或重置命令。输入用户名并回车，再输入密码并回车。用户名长度 3–64，允许小写字母、数字、点、下划线及连字符。密码长度 12–128，输入时隐藏，数据库只保存带盐的 scrypt 哈希。

```powershell
pnpm rica admin-user add
pnpm rica admin-user reset
```

系统管理员可在右上角菜单或「成员与审计」点击「新建账号」，验证当前密码后创建另一位系统管理员。新账号可以管理所有虚拟角色、部署插件和系统账号。列表显示账号创建时间，迁移前的账号可能没有记录。

### 网页账号管理接口

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `GET /v1/auth/users` | 可选 `after`，取上一页游标。 | 200，`{ items: [{ username, createdAt }], nextCursor }`，每页最多 25 条，仅返回系统管理员。历史记录的 `createdAt` 为 `null`。 |
| `POST /v1/auth/users` | `{ username, password, currentPassword }`。 | 201，`{ username }`。创建系统管理员。 |
| `PUT /v1/auth/users/{username}/password` | `{ password, currentPassword }`。 | 200，`{ username }`。旧会话及 Passkey 一并失效。 |

这些接口要求系统管理员会话。写请求使用同源 `Origin`，`password` 是目标账号的新密码，`currentPassword` 用于验证当前操作者。历史受限账号调用返回 403。用户名已存在时返回 `409 ACCOUNT_EXISTS`，通过网页接口重置系统管理员返回 `409 ACCOUNT_PROTECTED`，目标不存在返回 `404 ACCOUNT_NOT_FOUND`。

- 网页登录后持有有效期 8 小时的 HttpOnly、SameSite=Strict 会话 Cookie。退出会撤销当前会话，HTTPS 下 Cookie 额外使用 Secure 属性。
- 已登录用户可输入当前密码后登记 Passkey。登记和登录都验证浏览器来源、RP ID、一次性挑战和验证器的用户验证。已登记用户可直接选用 Passkey 登录。
- 在右上角账号菜单打开「安全设置」，输入当前密码后可修改自己的密码，或添加、移除自己的 Passkey。修改自己的密码会退出该账号的所有会话，已登记的 Passkey 继续有效。
- 按登记时间和识别码定位要移除的 Passkey。移除后该凭据随即失去 Rica 登录资格，已登录会话及其他凭据继续有效。设备或密码管理器保存的副本可从原处删除。
- 脚本可向 `POST /v1/auth/login` 提交 `username`、`password`，保存响应 Cookie，并在后续请求复用。所有写请求须附带与 `RICA_ADMIN_ORIGIN` 一致的 `Origin`。会话查询和退出使用 `GET /v1/auth/session` 与 `POST /v1/auth/logout`。管理接口的 OpenAPI 文档位于 `GET /v1/openapi.json`。

| 安全设置接口 | 参数 | 结果 |
| --- | --- | --- |
| `PUT /v1/auth/password` | 同源请求，提交 `{ password, currentPassword }` 修改自己的密码。 | 200，`{ success: true }`，所有旧会话失效，已登记的 Passkey 继续有效。错误密码或新旧密码相同返回 422，尝试过多返回 429。 |
| `GET /v1/auth/passkeys` | 当前登录会话。 | 200，`{ items: [{ id, createdAt }] }`。旧记录的 `createdAt` 为 `null`。 |
| `DELETE /v1/auth/passkeys/{id}` | 同源请求，提交 `{ password }` 确认当前密码。 | 200，`{ success: true }`。错误密码返回 422，凭据不可访问返回 404，尝试过多返回 429。 |

## 已开放的入口

系统管理员可以访问所有角色。历史账号继续按已有角色授权访问。人工提案须由提交人以外的管理员审批。

从旧版本迁移时，现有管理员授权保留，旧的操作员、审批员和审计员授权会撤销。原登录账号与审计记录保留。

以下 `/c` 表示 `/v1/characters/{characterId}`。

插件专用接口见 [Rica 的 Newbi 管理 API](../plugins/newbi/rica/management/api.md) 和[外部模型 API](../plugins/hosted-models/README.md)。

| 入口 | 权限与操作 |
| --- | --- |
| `GET /v1/characters`、`GET /c` | 当前主体获准访问的角色与生效配置投影。角色详情包含已启用的模拟适配器选项。 |
| `POST /v1/characters`、`PUT /c/core` | 指定主体创建初始暂停角色。ADMIN 提交新核心版本，可省略 `reason`。 |
| `GET /c/identities`、`POST /c/identities`、`PUT /c/identities/{identityId}` | ADMIN 读取。ADMIN 创建初始暂停身份或提交新身份版本，修改时可省略 `reason`。可选字段 `roleProfile.writingPrompt` 最多 4000 个字符，仅 ADMIN 可读。提交新版本时省略该字段即可清除。 |
| `GET /c/daily-energy/{utcDay}`、`POST /c/daily-energy` | ADMIN 查看审批后的档位。ADMIN 用幂等键批准一个未来 UTC 日。每天只允许批准一次。 |
| `GET /c/plugins` | ADMIN 查看部署插件状态、配置是否存在、各进程的脱敏报告，以及可选发布清单的升级预览。预览标出目标组件缺失、降级和契约不兼容。 |
| `GET /c/plans`、`POST /c/plans`、`PUT /c/plans/{planId}` | ADMIN 浏览、创建和编辑跨身份计划。每个参与项包含同角色下当前绑定的身份、账号和执行事项。创建使用幂等键，编辑使用计划版本。 |
| `PUT /c/plans/{planId}/state` | ADMIN 按版本暂停或恢复计划。暂停取消尚未执行的模拟运行，恢复前核对参与账号绑定。 |
| `GET /v1/deployment-plugins` | 本地部署操作者无需选择角色即可查看部署插件配置、进程报告、外部模型检查结果和可选发布预览。 |
| `PUT /v1/deployment-plugins` | 具有创建角色权限的本地部署操作者提交 `INSTALL`、`ENABLE`、`DISABLE`、`UNINSTALL` 或已登记的插件配置动作。使用 `If-Match` 指定 `deployment.version`。返回更新后的版本与脱敏设置。 |
| `GET /v1/model-usage?from=YYYY-MM-DD&through=YYYY-MM-DD` | 部署管理员查询最多 90 个 UTC 日的外部模型用量。按日期、角色、身份、平台、模型、用途及请求结果汇总。 |
| `GET /c/account-pool` | ADMIN 查询该角色尚未关联身份的账号。 |
| `POST /c/account-pool` | ADMIN 登记账号。模拟账号提交 `platform`、`instanceKey` 和 `remoteAccountId`。其他平台的请求体由对应插件定义。 |
| `POST /c/account-pool/associations` | ADMIN 提交 `registrationId` 和 `identityId`。两者须属于当前角色，关联后初始为暂停。身份已有未撤销账号时返回 `409 IDENTITY_ALREADY_BOUND`。撤销原账号后可关联另一个账号，历史记录保留原绑定。 |
| `DELETE /c/account-pool/{registrationId}` | ADMIN 提供 `Idempotency-Key` 移除当前角色的未关联账号，并在同一事务调用已登记的平台清理回调。 |
| `GET /c/accounts`、`POST /c/accounts` | ADMIN 读取已关联账号的脱敏列表。ADMIN 也可通过此接口在一个请求中登记并关联模拟账号。 |
| `GET /c/accounts/{accountId}/automation-eligibility` | ADMIN 查询指定账号的低风险外部自动执行资格与原因。 |
| `POST /c/controls` | ADMIN 暂停或恢复角色、身份、模拟账号，也可撤销账号。恢复真实账号须走平台授权。可省略 `reason`。 |
| `GET /c/memories`、`GET /c/memories/{memoryId}` | ADMIN 读取脱敏元数据和来源。列表支持身份、作用域和状态筛选。 |
| `GET /c/memory-grants` | ADMIN 读取共享授权和接收绑定，可按 `memoryId` 筛选。 |
| `GET /c/identities/{identityId}/conversations` | ADMIN 按当前身份、指定账号与公开或私聊类型分页获取授权选项。私聊选项含会话绑定的联系人。 |
| `GET /c/memories/{memoryId}/provenance`、`PUT /c/memories/{memoryId}/correction` | ADMIN 读取来源与修订元数据。ADMIN 用修订号作为 If-Match 提交纠错。原授权和派生正文失效。 |
| `POST /c/memory-grants`、`POST /c/memory-grants/{grantId}/revoke` | ADMIN 创建或撤销用途授权。公开引用绑定指定会话，私聊回复绑定确切的会话与联系人。 |
| `GET /c/identities/{identityId}/contacts` | ADMIN 分页查看该身份的联系人和联系边界摘要。 |
| `GET /c/contacts/{contactId}/boundary`、`PUT /c/contacts/{contactId}/boundary` | ADMIN 读取联系人边界。ADMIN 提供理由和 If-Match 修改。受信入站的明确拒绝指令立即阻断该账号下的联系人，解除后仅新运行可行动。 |
| `GET /c/identities/{identityId}/goals`、`POST /c/identities/{identityId}/goals` | ADMIN 列出该身份的目标。ADMIN 用幂等键创建手工目标。 |
| `GET /c/identities/{identityId}/goals/{goalId}`、`PUT /c/identities/{identityId}/goals/{goalId}` | ADMIN 读取目标。查询参数 `revision` 可读指定历史版本。ADMIN 用 If-Match 修改手工目标或取消自主目标。 |
| `GET /c/identities/{identityId}/reflections/{utcDay}` | ADMIN 查看该身份指定 UTC 日的反思和候选引用。 |
| `GET /c/identities/{identityId}/beliefs`、`POST /c/identities/{identityId}/beliefs` | ADMIN 分页查看当前观点版本的摘要。ADMIN 使用幂等键提交观点或偏好及其证据。 |
| `GET /c/identities/{identityId}/beliefs/{beliefId}`、`PUT /c/identities/{identityId}/beliefs/{beliefId}` | ADMIN 读取最新版本，或通过 `revision` 读取指定版本。ADMIN 使用 If-Match 提交新的证据集合。 |
| `POST /c/identities/{identityId}/beliefs/{beliefId}/restore` | ADMIN 使用 If-Match 和理由恢复曾生效的历史版本。恢复成功会追加新版本。 |
| `GET /c/memberships`、`POST /c/memberships` | GET 使用 `after` 按用户名分页，返回 `{ items: [{ subject }], nextCursor }`。POST 带幂等键提交 `{ subject, action, reason }`，`action` 为 `GRANT` 或 `REVOKE`。角色必须保留至少一名管理员。 |
| `GET /c/schedules`、`POST /c/schedules`、`PUT /c/schedules/{scheduleId}` | ADMIN 查询、创建或更新模拟计划。[模拟调度说明](simulation.md#计划调度) |
| `GET /c/commitment-receipts` | ADMIN 查询当前角色尚未登记承诺的已确认模拟回执，可用 `runId` 筛选。响应包含负责身份、平台、对象和回执时间。 |
| `GET /c/commitments`、`POST /c/commitments`、`PUT /c/commitments/{commitmentId}` | ADMIN 查询、登记和编辑承诺事项、截止时间和协作身份，也可延期或关闭。负责人和提醒范围由已确认模拟回执确定。[模拟调度与承诺](simulation.md#承诺提醒) |
| `GET /c/runs`、`POST /c/runs` | ADMIN 按最近运行分页。用幂等键提交 `accountId`、`message`，并携带 `chatId`（UUID）和 `speaker`（群员昵称）时，在当前角色的模拟群聊中排队。每次发言以本次提交的接收账号创建运行。首次发言时创建群聊和群员。仅提交账号和消息时发起单条模拟。 |
| `GET /c/simulation-chats`、`GET /c/simulation-chats/{chatId}` | ADMIN 分页查看当前角色的会话。详情返回群员、最近 40 次发言各自的接收账号和身份，以及保留期内已确认的模拟回复。 |
| `GET /c/runs/{runId}/replay`、`GET /c/monitoring` | ADMIN 查询脱敏运行轨迹和当前角色的积压。 |
| `GET /c/simulation-settings`、`PUT /c/simulation-settings` | ADMIN 读取角色时区、继承的模型预算及当前模拟限制，或提交完整的限制设置。写入使用 `If-Match` 版本并记录审计。 |
| `GET /c/monitoring/daily?from=YYYY-MM-DD&through=YYYY-MM-DD` | ADMIN 查询最多 31 个 UTC 日的模拟评测、模型预算用量和漂移信号。 |
| `GET /c/outbox/quarantined`、`POST /c/outbox/{eventId}/retry` | ADMIN 分页读取隔离事件。ADMIN 用当前代次和理由恢复一个事件。 |
| `GET /c/audit` | ADMIN 读取操作元数据、摘要哈希和请求 ID。可用 `runId` 限定运行相关记录，`order=desc` 按最新时间优先。 |
| `GET /c/actions`、`GET /c/actions/{actionId}` | ADMIN 读取模拟待办和经复核的提案预览。列表支持 `status=HISTORY`、`APPROVE` 或 `REJECT`，并按决定时间分页。审批历史包含结果、时间、AI 或人工来源及详情中已填写的人工理由。列表不含正文。 |
| `GET /c/auto-review`、`PUT /c/auto-review` | ADMIN 读取和修改当前角色的自动审批开关和提示词。读取时返回只读的默认外部模型信息，配置不可用时 `model` 为 `null`。保存时在 If-Match 带上当前版本。 |
| `POST /c/actions/{actionId}/decisions` | ADMIN 提交批准或拒绝、reviewDigest 和理由。If-Match 使用提案详情的 ETag，例如 "run-v3"。 |
| `GET /c/actions/{actionId}/reconciliation`、`POST /c/actions/{actionId}/reconciliation` | ADMIN 查看封存的本地账本证据并处置长期未知的模拟尝试。提交需要版本、幂等键、结论、证据引用和理由。 |

声明幂等键的 POST 请求带 `Idempotency-Key`。同一主体在同一路径使用相同键和相同输入，24 小时内会得到相同业务结果。键相同但输入不同返回 409。PUT 带强版本头，例如 `If-Match: "1"`。旧数据尚无生效版本时使用 `If-Match: "0"`。缺少版本返回 428，版本过时返回 412。无会话或会话无效返回 401，缺少角色管理员授权或请求跨角色资源返回 404。

分页列表默认 25 条，最多 100 条。目标列表按单个身份返回当前版本。后续请求通常把响应的 `nextCursor` 作为 `cursor` 传回。成员列表按用户名分页，使用 `after`。审计记录、状态修改和幂等结果一起提交，审计中保留摘要哈希及请求 ID。授权变化推进角色授权纪元，并沿用旧草稿清理规则。

## 身份状态规则与每日精力

ADMIN 可在身份档案的 `roleProfile.stateRule` 配置动机和模拟情绪。`motivationHalfLifeHours` 与 `affectHalfLifeHours` 可在 1 至 168 小时之间设置。`deltas.POST`、`deltas.MENTION` 和 `deltas.REPLY` 各含七个数，依次为探索、表达、社交、休息、愉悦度、唤醒度和精力，每项范围为 −0.15 至 0.15。ADMIN 可在身份列表读取规则。省略规则时采用内置 v1。

每个事件固定使用其身份版本的配置。重放以当前折叠的事件规则计算前一事件至该事件的衰减和增量。读取状态时使用最后折叠事件的半衰期，已保存的修订保持原值。

每日投影的请求字段为 `utcDay`、`energy` 和 `reason`。`energy` 可取 `LOW`、`NORMAL` 或 `HIGH`。管理员只可批准未来 UTC 日，同角色的身份在该日读取同一档位。没有审批时返回 `NORMAL`。内部决策收到档位，不收到审批理由、操作者或其他身份的局部状态。

## 身份观点与偏好

创建和更新接受 `kind`、`statement`、`reason` 和一至十六条 `evidence`。类型可取 `OPINION` 或 `PREFERENCE`，创建后固定。每条证据包含 `memoryId`、`memoryRevision`、`direction` 和 `weight`。方向可取 `SUPPORT` 或 `OPPOSE`，权重为 0 至 1。

证据必须是同一身份的有效身份级公开或个人记忆，且只有一个同身份、无账号或会话绑定的原始来源。服务端解析来源。同一来源的两条记忆在同一版本中返回 422。更新提交完整的证据集合，原有权重按净变化计分，重复提交相同来源及权重不会抬高置信度。从 0.5 起算，每批最多变动 0.20。正式生效需至少两个独立的支持来源且置信度至少为 0.65。一条强支持和一条强反对同时出现时记录为 `DISPUTED`，强证据的权重至少为 0.8。其余未达标的版本为 `PENDING`。

恢复请求提交 `restoreVersion` 和 `reason`，并用当前最新版本作为 If-Match。只可恢复更早的 `ACTIVE` 版本。记忆纠错、过期或来源撤销后，相关版本读取为 `INVALIDATED`，正文、置信度、理由和证据引用隐藏，恢复返回 409。读取时从仍有效的来源重算支持数、反对数和置信度，汇总置于 `remainingEvidence`。重算保留失效状态。ADMIN 复核剩余证据能支持的表述后，可提交新版本。观点版本由管理端提交。模拟内部决策按置信度读取最多八条当前身份的有效正式观点，以主观判断字段区分。写作模型使用单独授权的证据。审批预览、审批决定、执行许可和模拟回执写入都会复核草稿引用的观点版本。

## 每日身份反思

Worker 为启用的角色和身份汇总上一完整 UTC 日。同一身份同一天只记录一次，重启或多个 Worker 同时扫描可重试。反思分别保存虚构背景存在标记、已确认模拟回执计数及未核实入站计数，并记录生成时的核心和身份版本。汇总使用计数和引用，原始消息及档案正文保留在源存储中。

若该日有合格的身份级记忆，反思最多生成一条待复核的偏好，并返回其 `candidateBeliefId`。已用于自动候选的同一登记来源不会再次生成候选。来源失效时，候选按观点接口的规则隐藏内容。管理员复核时可引用其他独立来源，再按正式观点规则提交更新。

## 自主目标与账号资格

ADMIN 在版本化的 `roleProfile.autonomousGoal` 中配置 `topic`、`maxDays` 和 `budget`。M3 的许可主题为 `REVIEW_INTERACTIONS`，期限为 1 至 7 天，计划预算为 1 至 100 单位。省略配置时关闭自主目标生成。

每日反思发现至少一条已确认的模拟互动后，可以在当前身份下生成一个 `SELF` 目标，记录反思日期和有截止时间的内部下一步。同一主题同时最多一个生效的自主目标，手工与自主目标共享每身份三个活跃名额。管理员可取消自主目标。撤回许可或收紧期限、预算时，系统会追加取消版本。运行只读取仍有效且版本相符的目标。对外动作仍经过原有提案、审批和执行流程。

资格接口逐账号检查当前角色、身份和账号绑定状态、绑定版本及适配器类型。模拟账号返回 `SIMULATION_ONLY`，绑定暂停另返回 `BINDING_INACTIVE`。M3 所有账号都返回 `eligible: false` 和 `EXTERNAL_AUTO_DISABLED`。

## 跨平台重复审查

ADMIN 可在 `roleProfile.duplicateReview` 中为该身份启用提示。配置项 `similarityPercent` 为 65 至 100，`windowHours` 为 1 至 168。省略配置时关闭。系统在该身份活跃账号的已验证公开入站之间比较不同平台的主题，最多比较 64 条。短于 12 字符的规范化文本跳过比较。算法用前 480 字符的三元字符集合计算 Jaccard 相似度。

命中时审批风险码包含 `CROSS_PLATFORM_NEAR_DUPLICATE`。提示绑定当前提案，审批员只收到风险码与该提案原本获准查看的内容。比较不读取私聊，不建立账号、联系人或身份关联。

## 审批

模拟运行回放的 `executionWait` 返回当前执行许可的等待原因和可计算的最早执行时间。账号有未决执行时无法确定时间。提案会在等待期内过期时也省略时间。执行前拦截或草稿跳过使用 `stateReason` 说明原因。

用本地账号登录 Vue 控制台，在「审批」选择角色。批准将模拟提案推进到 READY，等待已启用的独立模拟执行进程。拒绝会终止提案。同一次运行只有一份提案和一个有效决定。[模拟执行说明](simulation.md)

「自动审批设置」按角色生效，初始关闭。管理员可编辑提示词或恢复默认。新产生的合格公开回复使用插件中心配置的部署默认外部模型。审核模型收到待发正文和该讨论的公开内容。私聊、近似重复提示、拟定计划或承诺的模拟提案进入人工复审。

模型返回明确批准时，服务端在提交决定前复查策略版本、提案和当前授权。修改或关闭设置会使尚未提交的旧审核结果失效。提案详情和审计记录标识自动批准。对有权预览正文的待审提案，详情返回 `autoReviewHandoff`，显示模型建议转人工的理由，或跳过、审核未完成的原因。审核反馈随草稿正文清理。

人工批准或拒绝时可省略 `reason`。发送结果对账和 Newbi 结案仍需说明理由。

模拟提案详情的 `messageContext` 提供触发回复的原消息，以及触发时已收到的同会话最近 12 条入站消息。私聊历史限定同一联系人。列表、不可预览的提案和已过保留期的正文均不返回对应内容。

模拟群聊以接收账号为边界。每条发言产生独立运行，写作和自动审核可参考此发言之前同一群聊的最近发言及已确认模拟回复。群员是会话内的虚拟发言者，可以重复参与。手动发起的群聊可在静默时段写入本地模拟回执，执行额度按账号计算。运行详情通过 `chatId` 关联会话。自动审核期间返回 `autoReviewPending`，审核完成或等待超时后再显示相应的审批状态。

Newbi 首次向某帖子回复仍走人工审批。同一账号后续回复时，审核前须在当前公开讨论中查到该账号已确认的回复。自动批准后的 Newbi 提案进入待发送，由管理员触发发送。[Newbi 插件手册](../plugins/newbi/README.md)

Newbi 审批打开时读取提案指向的帖子原文和首批可见评论。继续读取时把 `GET /c/newbi/replies/{replyId}/thread` 返回的 `nextCursor` 作为 `cursor` 传入。评论带有 `replyToCommentId`，以便判断回复关系。

预览和决定都会复核绑定、正文摘要和授权证据。撤权或配置版本更新时，待审和已批准提案会随授权纪元变化失效。适配器或策略版本不匹配、证据过期以及正文变化时，预览会隐藏正文。提交决定时会记录失效或过期状态和审计。后台过期扫描随调度接入。执行许可和回执由独立执行进程处理。


## 每日评测与预算

`coreProfile.dailyModelBudget` 是每角色每 UTC 日的预留单位上限，允许 1,024 至 100,000,000，默认 10,000,000。每次决策或写作调用前，由数据库原子预留序列化输入字节数与该阶段的输出额度。重试按实际尝试预留，预算不足时跳过该次模型调用。额度是本地估算，供治理使用。

日报按角色和 UTC 日返回提案、批准、拒绝、近似重复提示、模拟回执、账号单日回执峰值、草稿延迟均值和预算计数。审批率以提案日期归组，分子为该组收到审批决定的提案数。回执按实际记录日期归组。报告只包含聚合数据。

告警由日报计算。带重复提示的回执、缺少批准的回执、预算拒绝分别发出对应风险码。有至少 14 个完整 UTC 日时比较最近两个 7 日窗口。后窗回执总量达到前窗两倍加 7，或审批率相差至少 20 个百分点时，报告漂移。授权泄露由隔离验收中的测试标记验证。

## 出箱隔离与恢复

在控制台打开「运行 → 失败任务」。管理员可打开关联运行并填写理由恢复隔离事件。若代次发生变化，先重新核对事件再提交。

每个出箱代次最多尝试四次，含首次和三次重试。Worker 在开始处理前以 PostgreSQL 记录一次尝试并取得 30 秒租约。进程崩溃后，过期租约不会返还尝试次数。耗尽后隔离事件，保留原运行和事件。监控中的 `outbox.quarantined` 单独计数，`outbox.count` 包含所有未完成事件。

`GET /c/outbox/quarantined` 每页最多 25 条，用响应中的 `nextCursor` 作为下次请求的 `after`。返回事件 ID、运行 ID、类型、当前代次、尝试数和隔离时间。查明失败原因后，ADMIN 调用 `POST /c/outbox/{eventId}/retry`，提交 `reason` 并在 If-Match 传入当前代次，例如 `"0"`。成功会增加代次、重置尝试预算并交给正常 Worker 流程，同时追加审计。并发恢复只允许一次，旧代次返回 412。

队列作业必须包含当前出箱代次。版本切换使用同一版本的 Worker 和新的开发队列。

## 模拟数据保留期

Worker 启动后定时清理模拟数据。入站正文从接收时刻起保留 30 天，审批草稿正文从草稿创建时起保留 30 天。运行创建满 90 天后，清除上下文快照、证据、观点和目标引用。回放返回 `referencesExpiredAt`，并省略已清理的计划引用。未进入执行的旧运行在压缩时过期。

保留入站去重键及适配器版本、运行和提案状态、审批摘要、尝试和回执。未决发送仍可按原账本对账。清理以角色为单位持锁、分批提交，可重跑。

恢复同一版本的备份时，先保持 API、Worker 和执行进程停机，并用指向恢复数据库的运行配置执行 `pnpm rica retention`。命令排空到期批次后退出，再开放服务。该命令按备份中原始时间补清理。

## 回放与积压

运行回放返回固定的身份、账号与配置版本、时间、快照，以及存在时的计划和承诺引用。运行轨迹包括入站类型与接收时间、草稿创建时间与模型版本、提案与审批时间、执行许可发放时间和模拟回执状态。证据按快照保存时的用途和受众复核当前权限与修订。失效时只返回排名与不可用标记。观点引用字段 `beliefRefs` 只含 ID 和版本。

当前角色的 ADMIN 可在 `transcript` 查看从控制台发起、回执已确认且绑定仍有效的公开模拟消息、草稿及审批理由。正文沿用 30 天保留期，草稿每次读取时复核摘要与证据授权。公开模拟的草稿仍在保留期内时，`systemPrompts` 独立显示生成时绑定的角色核心设定和身份提示词。

监控返回 `observedAt` 和四类积压的数量及最早时间。出箱统计关联到当前角色的未消费事件，另给出其中已入队的数量。审批统计尚未过期的待审记录。对账统计未知尝试，最早时间取许可截止时间。计划统计已启用且到期的计划。没有积压时最早时间为空。两类查询均使用角色级授权，且保持运行状态。
