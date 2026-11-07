# 多平台多身份 AI 虚拟角色认知与自主行为系统设计规范

v1.0  ·  开发与验收规格  ·  2026 年 11 月 6 日

本规范定义同一 AI 虚拟角色如何以公司号、个人大号和私人小号在多个平台活动。开发 Agent 应按第 16 章分阶段实现，以第 15 章的可执行用例验收。首个交付应在模拟环境完整走通入站、身份绑定、选择性召回、决策、审批与执行回执。

<a id="sec-01"></a>

## 01  目标与不可变规则

| 编号 | 强制规则 |
| --- | --- |
| INV-01 | 每个角色只有一个核心自我。身份拥有各自的职责、表达、关系、目标和记忆。账号属于一个确定的身份，平台账号与社会身份分开建模。 |
| INV-02 | 默认按身份隔离。跨身份仅允许受控核心资料、经审查的抽象状态或有效的显式授权。权限须在检索之前计算，并随用途变化。 |
| INV-03 | 核心身份、核心价值观、AI 披露、隐私规则、账号与操作权限由管理员维护并版本化。角色只能在配置的边界内更新兴趣、偏好、普通观点、模拟情绪、关系和自主目标。 |
| INV-04 | 行为意愿与执行授权分离。模型只提出候选，服务端固定账号、判定政策、绑定审批并执行。任何审批都不能覆盖硬拒绝。 |
| INV-05 | 每次运行固定一个身份与一个账号。撤权、停机、绑定变化或数据修正必须阻止尚未获准的外部发送。重要演化可追溯和回滚。 |

### 交付口径

“必须”表示验收条件。“默认”表示可由管理员在硬边界内配置的实现初值。“后续”表示相应阶段的工作。AI 披露由版本化政策指定内容、位置和适用渠道，由适配器验证能够实现。环境、地区、平台能力未核实的动作默认禁用。

## 章节索引

- [01  目标与不可变规则](#sec-01)
- [02  系统架构与信任边界](#sec-02)
- [03  领域模型与作用域](#sec-03)
- [04  数据表与数据库约束](#sec-04)
- [05  上下文与记忆检索](#sec-05)
- [06  身份切换与心理连续性](#sec-06)
- [07  动机情绪与观点演化](#sec-07)
- [08  决策状态机](#sec-08)
- [09  平台适配与账号管理](#sec-09)
- [10  审批安全与执行一致性](#sec-10)
- [11  调度预算与运行模式](#sec-11)
- [12  API 与管理端](#sec-12)
- [13  领域事件与队列契约](#sec-13)
- [14  可观测性与运维](#sec-14)
- [15  测试与验收](#sec-15)
- [16  MVP 与迭代交付](#sec-16)
- [17  插件架构与演进计划](#sec-17)

<a id="sec-02"></a>

## 02  系统架构与信任边界

采用模块化单体，共享 TypeScript 领域包，部署为 Hono.js API、BullMQ Worker 和 Vue 3 管理端。API 接收平台事件和管理员命令。Worker 运行认知、执行与维护作业。PostgreSQL 是授权、业务状态、时间线和工作恢复的事实来源。Redis 用于 BullMQ、短期缓存与限流提示，持久授权、预算扣减及防重由数据库判定。

| 模块 | 所有权与边界 |
| --- | --- |
| Character Core | 管理核心档案与版本、身份投影、生活节奏、动机情绪、观点、关系、目标和承诺。 |
| Cognition | 解析情境、按用途检索、评估候选、生成草稿。模型代理仅接收校验后的最小输入，无平台凭据或任意工具执行权限。 |
| Policy | 管理账号能力、记忆访问、风险、预算及审批。每次执行从数据库读当前授权。 |
| Execution | 唯一允许使用平台写凭据的模块。验证审批与目标、取得发送许可、适配平台、记录回执和对账。 |
| Management | Vue 3 提供角色与身份编辑、权限管理、模拟回放、审批、对账、暂停与审计。经 Hono API 访问，界面过滤只用于显示。 |

### 主数据流

平台回调或轮询 → 入站归一化与去重 → 绑定运行上下文 → 权限过滤与召回 → 候选评分及政策预检 → 草稿与输出检查 → 模拟或审批 → 执行前复核 → 平台回执 → 审计与后续反思。

### 项目组织

建议采用 apps/api、apps/worker、apps/admin、packages/domain、packages/contracts、packages/persistence、packages/adapters。领域层只依赖端口和契约。Cognition、API 及控制台不能调用适配器的写操作或读取密钥。以独立队列消费者及服务身份隔离执行职责。Prisma 管理关系模型和迁移，RLS、特定约束和向量 SQL 通过受版本控制的迁移落地。 可替换能力由启动入口装配，扩展点和权限边界见[第 17 章](#sec-17)。

<a id="sec-03"></a>

## 03  领域模型与作用域

| 对象 | 责任和生命周期 |
| --- | --- |
| Character / CoreVersion | 一个角色指向一个生效核心版本。核心包括 AI 声明、虚构背景、稳定特质、核心价值和底线。SelfModel 单独维护可演化的自我叙事与长期愿望。 |
| Identity / IdentityVersion | 社会身份有独立职责、语气、主题和活动规则。工作模式、个人模式与私人模式可并存，运行时选择其中之一。 |
| PlatformAccount | 平台、实例、远端账号 ID、凭据引用、当前授权和连接状态。绑定固定，换绑走停用与重建流程。 |
| Conversation / Contact / Relationship | 会话在账号内标识。联系人按账号及平台远端标识解析。关系由身份视角建立，具备边界、主题、摘要和互动引用。 |
| Memory / MemoryGrant | 记忆有归属和敏感级别。授权把指定用途、对象与有效期绑定到明确接收身份及可选账号。 |
| AgentRun / Action | Run 是一次不可换绑的认知过程。Action 是一份不可变的发送提案，重写生成新提案。一个 Run 最多产生一个提案。 |
| Approval / Receipt | 审批绑定提案及审查快照。回执用于确认外部结果、对账及创建真实活动记录。 |
| Goal / Commitment | 目标描述希望达成的结果。承诺对应已确认的对外约定，绑定身份、账号、对象、期限及已发送回执。 |

### 身份与权限的关系

工作账号可拥有个人账号同样不具备的读取权，但各账号能力分别声明。即使同一身份绑定两个平台账号，账号级历史也默认各自隔离。联系人同名、头像相同或文风相似都不足以建立跨平台关联。后续的关联记录需经明确验证和授权，关联本身不产生读权、联系权或公开引用权。

<a id="sec-04"></a>

## 04  数据表与数据库约束

### 标识与迁移约定

下表列出业务字段。默认 id 为 UUID 主键，业务时间用 timestamptz，状态及用途用枚举或 CHECK，计数用整数，范围参数使用有限数值。表均带 created_at，版本化可变表另带 version 和 updated_at。角色数据带 character_id，授权主体和外部目标使用外键。JSONB 只存经版本化 schema 校验的扩展值。

下文 C、I、A、T 分别代表 character_id、identity_id、account_id、conversation_id。“U”代表 UNIQUE。父表提供与其业务作用域相应的组合唯一键，子表通过组合外键引用，例如 accounts 提供 U(C,I,id)，会话引用账号并提供 U(C,I,A,id)。禁止靠独立 id 外键替代同角色及同身份约束。

| 表 | 必需字段及约束 |
| --- | --- |
| characters / core_versions | characters 有 status、timezone、active_core_version、auth_epoch。core_versions 有 C、version、hard_profile、actor_id、reason，U(C,version)。生效指针以 (C,version) 校验归属。 |
| identities / identity_versions | identities 有 C、slug、status、active_version，U(C,slug)。identity_versions 有 C、I、version、role_profile、actor_id、reason，U(C,I,version)。 |
| platform_accounts | C、I、platform、instance_key、remote_account_id、credential_ref、binding_version、status、granted_scopes、capability_version、sync_cursor。U(platform,instance_key,remote_account_id)。撤销后保留绑定墓碑。 |
| conversations / contacts | C、I、A、remote_key。两表均 U(A,remote_key)。联系人记录 display_label、interaction_boundary。会话记录 channel、last_event_at。 |
| relationships | C、I、A、contact_id、kind、familiarity、trust、topics、summary、boundary。U(A,contact_id)。contact_id 与 A 同属一个组合外键。 |
| inbound_events | C、I、A、T 可空、contact_id 可空、source_key、kind、occurred_at、received_at、payload_ref、verification。U(A,source_key)。引导事件不存于此表。 |
| policy_versions / account_permissions | 前者 C、version、policy_json、actor_id，U(C,version)，角色持生效策略指针。后者 C、I、A、action_kind、mode、limits、version，U(A,action_kind)。mode 为 DENY、REVIEW 或 AUTO。 |
| admin_users / role_assignments | admin_users 有 subject、status，U(subject)。role_assignments 有 user_id、C、role、valid_until，U(user_id,C,role)。授权到期按数据库时间判定。 |

### 记忆与演化记录

| 表 | 必需字段及约束 |
| --- | --- |
| memories | C、I?、A?、T?、contact_id?、scope、visibility、kind、status、content、summary、confidence、importance、expires_at、revision、supersedes_id?。置信度和重要性在 [0,1]。内容修正建新行，旧行失效。memory_sources 对派生依赖必须建完整来源链，并禁止循环。 |
| memory_sources | C、memory_id、source_id、source_kind、source_revision、transform。U(memory_id,source_id,source_kind,source_revision)。source_id 通过 sources_registry 统一约束，记录归属及删除状态。 |
| sources_registry / memory_embeddings | 来源登记 C、kind、source_key、classification、status，U(C,kind,source_key)。向量表含 C、memory_id、model_key、embedding，U(memory_id,model_key)。仅获准进入所用模型环境的内容可生成向量。 |
| memory_grants | C、memory_id、recipient_identity_id、recipient_account_id?、purpose、audience?、valid_from、valid_until、revoked_at、approved_by、reason。有效期必填，结束晚于开始。撤销保留历史。生成用途必须指定受众。 |
| memory_promotions | C、source_memory_id、candidate_ref、status、reviewer_id、result_memory_id?、reason。批准时创建独立 CORE 派生条目及来源链。 |
| cognition_states / cognition_revisions | 前者存 C、scope_key、kind、current_version、state_json、as_of，U(C,scope_key,kind)。后者存 state_id、version、before_hash、state_json、source_key、reason、actor_id，U(state_id,version) 和 U(state_id,source_key)。 |
| beliefs / belief_evidence | beliefs 有 C、scope_key、topic_key、type、confidence、status、current_version、reviewed_at。U(C,scope_key,topic_key,type)。证据表有 belief_id、revision、memory_id、source_group、polarity、weight，U(belief_id,revision,memory_id)。 |
| goals / commitments | goals 有 C、I、origin、title、priority、status、due_at、budget、next_step。commitments 有 C、I、A、contact_id、T?、receipt_id、item_key、goal_id?、due_at、status。U(receipt_id,item_key)。 |

### 运行与可靠性记录

| 表 | 必需字段及约束 |
| --- | --- |
| agent_runs / context_snapshots | runs 有 C、I、A、T?、trigger_key、trigger_type、mode、state、state_version、next_at、lease_until、lease_token。U(C,trigger_key)。snapshots 按 U(run_id,stage,revision) 记录核心、身份、策略、授权纪元、模型与记忆版本引用。 |
| actions / approvals | actions 有 run_id、C、I、A、kind、target_ref、audience、payload_ref、payload_hash、review_digest、status、expires_at，U(run_id)。approvals 有 action_id、review_digest、reviewer_id、decision、reason、expires_at、resolved_at，U(action_id,review_digest)。 |
| execution_attempts / receipts | attempts 有 action_id、attempt_no、send_key、state、fence、started_at、finished_at?，U(action_id,attempt_no)。receipts 有 action_id、A、remote_result_id?、result_kind、provider_ref、confirmed_at，U(action_id)。有远端对象 ID 时按 (A,result_kind,remote_result_id) 去重。 |
| schedules / quota_reservations | schedules 有 C、schedule_key、zone、rule、next_at、enabled、version，U(C,schedule_key)。reservations 有 action_id、bucket_key、window_start、units、status，U(action_id,bucket_key,window_start)。配额计数另存 quota_buckets，U(bucket_key,window_start)，字段 reserved、consumed、limit 均非负。按唯一键锁定并校验 reserved + consumed + units ≤ limit。 |
| outbox / consumer_inbox | outbox 有 event_id、aggregate_id、aggregate_version、type、payload、next_at、sent_at?。消费表 U(consumer,event_id)。业务提交与写出箱同事务。 |
| audit_log / api_idempotency | 审计记录 actor、操作、C、目标、决策码、摘要哈希及时间，应用角色仅追加。幂等表 U(principal,route_scope,key)，存 request_hash、response_ref、expires_at。 |

### 强制校验和索引

记忆 CHECK 规定 CORE 的 I/A/T 皆空，IDENTITY 仅 I 非空，ACCOUNT 的 I/A 非空且 T 空，CONVERSATION 的 I/A/T 均非空。有 contact_id 时要求 A，组合外键验证归属。CORE 仅接受批准的角色级内容及公开可引用摘要。scope_key 使用可验证的 CORE 或同角色身份键。固定 Run 的 C/I/A、Action 的目标与内容不可被通用 PATCH 修改。

活跃记忆按 (C,scope,I,A,T,created_at) 及 (A,contact_id,created_at) 查询。授权按 (C,recipient_identity_id,purpose,memory_id) 索引。建立待办 (state,next_at)、出箱 (next_at) 和账号时间线 (A,occurred_at,id) 索引。到期条件由查询判断。对未终结发送建立单活跃 attempt 的部分唯一索引。

使用数据库约束和集成测试验证同属关系。Prisma 未表达的约束通过 SQL migration 安装。应用运行角色无 DDL、表所有权和 BYPASSRLS。敏感表启用并强制 RLS，以事务内的请求角色范围补充保护。检索用途和来源限制由参数化 SQL 显式校验。禁止连接级 SET 跨池泄漏，所有设置、授权查询及读取在同一事务内完成。

<a id="sec-05"></a>

## 05  上下文与记忆检索

### 运行上下文

ContextService 从已验签的入站事件、持久化计划或具备权限的手工触发构建不可变 AgentContext。字段为 runId、characterId、identityId、accountId、platform、instanceKey、bindingVersion、conversationId?、contactId?、triggerId、mode、occurredAt、now、timezone。TemporalContext 附带同作用域内的最近事件、承诺到期时间、计划活动与当前时段。输入时间与服务器处理时间分别记录，外部时间戳不能重置调度和预算。

ContextSnapshot 保存每阶段的核心、身份、策略、绑定及 authEpoch，另存提示模板与模型版本、证据 ID 和修订、检索排名、外部事件引用、评估码及输出哈希。敏感原文留在受控存储，追踪不依赖模型的内部推理文本。回放从隔离副本加载仍可访问的证据，已删除资料显示占位。

### 授权矩阵

| 层级 | 默认可进入候选集的条件 |
| --- | --- |
| CORE | 同角色且已批准共享。公开输出仍按目的、受众、披露规则和来源授权筛选。 |
| IDENTITY | 同 I，可供该身份的多个账号使用。跨 I 须有有效授权及来源准入。 |
| ACCOUNT | 同 I/A。离开 A 需明确授权，且满足来源和受众限制。 |
| CONVERSATION | 同 I/A/T。关系摘要另存同 A 的联系人级记忆。私人会话原文与受限资料不得跨身份分享。 |

用途枚举为 INTERNAL_CONTEXT、DECISION_SUPPORT、PUBLIC_REFERENCE、PRIVATE_REPLY。前三项分别控制内部理解、候选决策和可公开引用。PRIVATE_REPLY 仅在当前账号、私聊会话和目标联系人一致时使用。来源条款、敏感级别、范围、受众和有效期必须同时满足。PUBLIC 可见性不自动授予跨身份使用权。CONFIDENTIAL 仅限本身份允许的内部用途。RESTRICTED 默认排除于模型输入。

### 召回与生成流程

1. 以 (C,I,A,T,contact,purpose,audience,now) 参数化查询。校验角色、身份、账号有效，记忆和所有依赖来源活跃且未过期，再求原生范围或显式授权。按目的生成候选集合。拒绝结果不能进入向量排序、提示、诊断采样或排名响应。
2. 在可访问集合内做关键词、语义及关系召回。MVP 用关键词和关系匹配，中文使用经测试的分词或应用侧受控词项索引。后续可对授权物化子集精确排序，再按负载评估作用域内的向量索引。严禁全库取向量 Top K 后再做权限筛选。
3. 归一化分值至 [0,1]。重排 S = 0.40R + 0.25C + 0.20I + 0.15T，R 为相关度，C 为会话与关系命中，I 为重要性，T 为按类别半衰期衰减的时间有效性。MVP 默认 S ≥ 0.45，最多 8 条和 1,500 token，平分按时间与 UUID 排序。无匹配则返回空数组。
4. 内部决策与面向外部的写作分成无共享会话的模型调用。写作只收到指定用途可用的资料、经过审核的状态投影与受限枚举行为指令。内部模型生成的自由文本、理由、摘要和历史提示不得透传给写作模型。输出仅提交规范化内容、允许引用的证据 ID、目标及风险提示。事实、观点、虚构背景与未核实外部内容分开标注。
5. 读时与执行时均复核来源及权限。策略、授权、来源删除、修正或撤权更新时同步推进角色 authEpoch。MVP 不缓存原文或检索结果。后续缓存键须覆盖上述完整作用域、目的、模型版本、authEpoch 与过期时间，并且命中后仍复核。

### 写入与遗忘

从已验证事件或已确认回执提取记忆候选。将外部说法标记为未核实，模型草稿不得写成真实经历。基于归属、主题、来源和内容指纹去重。同主题冲突记录正反证据和有效期，降置信并进入纠错流程。晋升从原记忆提议一条最小化摘要，经隐私、来源和授权检查后批准为新的 CORE 记录。禁止自动晋升公司秘密、私聊原文及可反推身份的细节。

撤销后在同一事务内对源记录失效并推进 authEpoch。在线查询立刻拒绝其派生项，后台清理摘要、向量、未发草稿及快照敏感载荷，并追踪到清理完成。删除前已送出的内容进入平台可用的人工处置。审计保留最少的引用、哈希和结果码。缺省原始入站载荷保留 30 天，审批草稿和运行引用分别保留 30 与 90 天，授权历史和去重墓碑按管理员配置保留。备份恢复须先应用删除墓碑再开流量。

<a id="sec-06"></a>

## 06  身份切换与心理连续性

入站事件锁定接收账号。账号停用、事件目标不匹配或会话消失时跳过，不改用备用账号。主动任务先由服务端列出已启用且拥有目标行为能力的候选，再按时段、目标优先级、预算、身份适配及模拟精力排序。模型可给候选评分，服务端按分数及稳定键定序。没有合法候选就记录 IDENTITY_UNAVAILABLE。

身份切换只发生于运行之间。工作进程不持有进程级 currentIdentity。新任务须创建新 Run，从目标身份重新构建上下文、读取记忆与生成内容。旧草稿、令牌、会话或授权不复用。排队任务绑定旧版本时进入取消或重建流程，禁止把旧回复用新身份重新投递。

### 共享状态投影

表现由核心资料、身份投影及当前情境组合。角色级精力只允许来自经批准的无归因节奏数据，或经审查的低精度抽象值，例如 LOW、NORMAL、HIGH。跨身份共享的状态按固定周期更新，最低粒度为日。禁止从机密、私人对话、事件时间和联系人生成可跨身份实时反推的变化。来源无法确认时回到基线，保留对应身份的局部情绪。

例：私人小号收到科幻讨论时，可以引用本账号的旧观点和获准共享的新兴趣。公司内部游戏讨论不得进入私人运行的授权候选集。若需要转到个人大号发原创，创建另一次计划运行，并针对个人大号重新检索及审批。

<a id="sec-07"></a>

## 07  动机情绪与观点演化

所有数值是模拟行为参数。状态更新使用有版本的规则、输入事件引用与操作者。模型只提议结构化增量和证据 ID。服务验证范围、来源、单次幅度和写权限，用 CAS 更新版本并追加修订。并发冲突重新读取并计算。按 (stateId,sourceKey) 防止重放重复更新。乱序事件进入重算队列，按 (occurredAt,eventId) 由最近有效检查点重算，不对现值二次叠加。

### 动机与情绪

| 对象 | 初始实现规则 |
| --- | --- |
| Motivation | 探索、表达、社交、休息四维 [0,1]，基线初值 0.5。事件按类型增加或满足需求，单次变动最多 0.15。无事件时以 24 小时半衰期回归基线。 |
| Affect | 愉悦度 [-1,1]，唤醒度与精力 [0,1]，基线依次 0、0.5、0.7。先衰减再加受限事件增量并截断。半衰期默认 8 小时，活动单次变化绝对值至多 0.15。 |
| 影响范围 | 动机及情绪合计最多改变排序分 0.10，只允许影响可选活动的偏好和语气。硬规则、审批、配额、静默及退出请求仍由 Policy 决定。 |

更新公式 x′ = clamp(b + (x − b) × 2^(−Δt/h) + δ)。Δt 取非负经过时长。规则版本、事件类别映射及参数由管理员配置。每个身份维护独立 Affect，核心投影按第 06 章控制。

### 信念与自我叙事

FACT、OPINION、PREFERENCE、UNCERTAIN、VALUE 分开存储。VALUE 绑定核心版本，仅管理员可改。FACT 保留出处和核实状态，冲突时置 DISPUTED。OPINION 与 PREFERENCE 可按范围演化，内容生成必须按主观判断表述。证据按独立来源组聚合，转载或重复提交只计一次。

默认正式更新要求至少 2 组获准、方向一致的独立证据且更新置信度 ≥ 0.65。评分取 clamp(旧值 + 0.1 × (支持权重和 − 反对权重和), 0, 1)，每组权重限制在 [0,1]，单批总变化绝对值至多 0.20。出现强冲突则保留旧版本并记录 DISPUTED。偏好单次体验可以作为待复核候选。证据撤销后失效并重算。每日反思按当前身份提炼经历，区分 FICTIONAL_PROFILE、OBSERVED_ACTIVITY、UNVERIFIED_EXTERNAL。全局叙事仅采用已批准的 CORE 资料。重要变更记差异、依据、置信度和原因。回滚生成新版本，按当前权限复核证据后生效。

### 目标承诺与关系

Goal 的 origin 为 ADMIN、SELF 或 COMMITMENT，状态 DRAFT、ACTIVE、PAUSED、DONE、CANCELED、EXPIRED。自主目标只能在许可主题、期限和预算内启用。规划生成带期限的下一步，实际行动仍进入统一运行状态机。MVP 默认每身份最多 3 个活跃自主目标。

只有平台确认的对外约定可创建承诺。状态 OPEN、FULFILLED、DEFERRED、CANCELED、EXPIRED，延期记录新到期日与原因。通知或解释也需当前账号许可。关系从成功互动更新熟悉度、主题和摘要，重复同源互动按一次计。用户表达不愿联系时立即写入边界，禁止主动触达，管理员解除须有可追溯的依据。

<a id="sec-08"></a>

## 08  决策状态机

每次运行最多提议一个外部动作。候选包括 NO_OP、READ、DRAFT、PUBLISH、REPLY。READ 表示对已摄取的许可内容进行阅读。主动远端获取由连接器按读取授权执行。LIKE、FOLLOW、DM、删除等能力预留枚举，MVP 策略关闭。支付、广告购买、账号创建和批量触达不进入 MVP 候选空间。

| 当前状态 | 条件与目标状态 |
| --- | --- |
| QUEUED | Worker 获得运行租约并确认有效绑定 → CONTEXT_READY。停用、过期或无账号 → CANCELED 或 SKIPPED。 |
| CONTEXT_READY | 读取授权快照，执行候选预检及评分 → PLANNED。NO_OP 或无合法候选 → SKIPPED。 |
| PLANNED | 生成结构化内容并检查 → DRAFTED。仅内部阅读可 → SUCCEEDED。永久模型或结构化校验错误 → FAILED。模型错误按重试规则处理。 |
| DRAFTED | 硬拒绝 → BLOCKED。仅草稿 → SUCCEEDED。SIMULATION → SIMULATED。需审查 → WAITING_APPROVAL。低风险且启用 AUTO → READY。 |
| WAITING_APPROVAL | 匹配审批且未过期 → READY。拒绝 → REJECTED。授权、内容或对象变化 → CANCELED。超时 → EXPIRED。 |
| READY | 最终核验、预算预留和发送许可提交 → EXECUTING。政策拒绝 → BLOCKED。临时延迟仍为 READY，并更新 next_at。 |
| EXECUTING | 已确认成功 → SUCCEEDED。确认未送达的暂时失败 → READY。永久失败 → FAILED。结果未知 → RECONCILING。 |
| RECONCILING | 确认已送达 → SUCCEEDED。经可靠证据确认未送达且许可仍有效 → READY。到达时限仍未知 → 保持待人工处置。 |

### 评分与转换条件

先对动作类型、目标与账号做硬筛选，再计算 score = 0.35×目标匹配 + 0.25×情境相关 + 0.20×身份适配 + 0.20×时机 − 0.25×成本 − 0.20×重复度 + 动机情绪修正。各输入规范化至 [0,1]，修正绝对值 ≤ 0.10。默认阈值 0.55，分数相同优先选择低副作用，再按稳定候选键排序。输入缺失使用 0，风险和权限无法判断时拒绝动作。扣分不能代替硬约束。

状态转换使用 WHERE state AND state_version AND lease_token 的原子更新。审批及撤销走各自的事务命令，并以版本匹配防止覆盖。状态、审计和 outbox 同事务。暂时性数据库、队列或模型故障保持当前阶段，写 next_at 并记录尝试次数。重复作业只读取或推进合法状态，终结状态不回退。草稿修订关闭旧运行，通过 successor 触发键开启新 Run，并与旧提案建立审计关联。

<a id="sec-09"></a>

## 09  平台适配与账号管理

### 统一适配契约

```typescript
interface PlatformAdapter {
  capabilities(account: AccountRef): Promise<Capabilities>
  verifyInbound(input: RawRequest): Promise<VerifiedInbound>
  normalize(event: VerifiedInbound): NormalizedEvent[]
  poll(account: AccountRef, cursor?: string): Promise<EventPage>
  validate(action: ActionEnvelope): Promise<ValidationResult>
  execute(action: ActionEnvelope, sendKey: string): Promise<ProviderResult>
  reconcile(query: ReconcileQuery): Promise<ReconcileResult>
}
```

AccountRef 由服务端解析，包含内部 ID、平台、实例、远端账号标识和绑定版本。ActionEnvelope 包含当前账号、动作、目标、内容、受众与审查摘要。Capabilities 声明支持的动作、签名方案、内容长度计量、媒体、可见性、重试与幂等能力。未实现的可选能力明确返回 UNSUPPORTED。结果标准化为 CONFIRMED、DEFINITELY_NOT_SENT 或 UNKNOWN，区分限流、权限撤销、不可达目标、无效内容及传输中断。

### 入站与认证

按平台签名方案验证原始请求、时钟窗口和重放标识。URL 不能单独决定账号归属，签名来源与负载绑定字段都需匹配。通过服务器获取或验证远端账号身份。回调提交入站去重行与 outbox 后返回 2xx。轮询在同一事务落盘并推进游标，分页重放按事件键去重。历史补录允许归档但默认不触发回复。回调或轮询收到角色自己的事件时更新对账资料，不唤起新回复。

### 账号生命周期

PENDING → ACTIVE → PAUSED、REAUTH_REQUIRED 或 REVOKED。由管理员启动连接，使用平台批准的官方接口、最小 OAuth scopes、state 及可用的 PKCE。凭据以密钥服务引用保存，执行时解密，日志、队列及模型上下文不可见。凭据轮换保持远端主体一致，失败转 REAUTH_REQUIRED。撤销立即取消新的发送许可。实例及回调域名设白名单，限制重定向与内网访问。

MVP 使用两个模拟平台适配器验证多平台绑定及差异。真实平台按配置启用，先在测试账号验证权限、披露、账号识别、限流、回执和对账。公司号、大号和小号是应用身份范例。平台名称和真实接入顺序由部署配置选择。

<a id="sec-10"></a>

## 10  审批安全与执行一致性

### 角色与策略

| 角色 | 允许的管理命令 |
| --- | --- |
| ADMIN | 配置硬档案、政策、账号、授权及停机，分配角色。审批须另持 REVIEWER。 |
| OPERATOR | 在授予范围内创建任务、提交提案与查看脱敏运行。不能赋权或审批自己的提案。 |
| REVIEWER | 可查看分配范围内的待审批必要资料，提交批准或拒绝。审查与资料访问分别授权。 |
| AUDITOR | 只读审计、版本及脱敏轨迹。无法查看凭据和未获授权原文。 |
| SERVICE | 分配给认知、执行与维护进程，各自使用专用服务凭据。执行进程才可获取平台写令牌。 |

判定顺序为停机与绑定 → 平台能力和账号动作授权 → 数据来源和受众 → 退出互动边界与硬规则 → 风险、时段与配额 → 审批模式。任何硬失败优先于允许。外部内容、工具结果和模型输出均为不可信输入，使用结构化 schema、长度上限、纯文本隔离和参数校验。审批前扫描敏感内容、冒名、注入外带、目标和 AI 披露。写作输入隔离负责首道防泄露，输出扫描用于补充拦截。

| 风险结果 | 行为 |
| --- | --- |
| DENY | 权限缺失、敏感越界、账号或目标异常、无法满足披露、预算用尽且已过期。审批不能继续。 |
| REVIEW | 外部发布默认走人工审批。新账号、首次目标或策略要求提高等级时仍需审查。 |
| AUTO | 仅对正式启用的低风险动作开放，且须持续满足白名单、配额、频控和披露。MVP 关闭外部 AUTO。 |

审批默认 24 小时有效，提案过期可更早。review_digest 对规范化 payload_hash、C/I/A、绑定版本、目标、受众、动作、核心与身份版本、政策版本、authEpoch、来源证据版本和有效期计算 SHA-256。审批以此摘要和当前 run state_version 绑定。编辑、变更目标或审查依赖变化均使旧审批失效。管理端须显示实际账号、公开范围、拟发内容与风险码。并发审批只有一个有效决定。到期和拒绝均记录审计。

### 发送许可与未知结果

执行 Worker 在短事务内按固定顺序锁定角色授权行、账号、运行与预算桶。读最新政策、授权和审批，复核证据及目标，确认 RUN.mode 为 LIVE 且服务环境允许发送，预留预算并创建唯一活动 attempt。authEpoch 更新与停机命令使用同一角色锁。事务提交是发送许可的顺序边界。适配器在许可有效期内发起请求，调用前尽力检查停机。已发许可可能处于在途，停机页面须列明该状态并可查询对账结果。网络调用不持数据库锁。

以 actionId 派生稳定 sendKey。可证明支持幂等时按平台能力使用同一键，覆盖整个重试窗口。没有幂等保证时，超时、进程崩溃或不确定错误一律进入 RECONCILING，禁止盲目补发。只接受平台回执、可靠对象关联或有依据的人工确认。RECONCILING 默认 15 分钟内按退避查询，超时升级人工。相似文本或查询暂未发现不能证明未发送。只有确认未送达才允许重试，且须重新获准。过期 EXECUTING 租约由对账任务接管，旧 Worker 不能提交新的状态转换。迟到回执可作为对账证据记录。

成功后将预留转为已消耗并提交回执。确定未发释放本次预留。未知结果继续占用原窗口的预留。每账号对执行按单通道串行，未解决的未知写入保持阻断。管理员处置需记录证据和结论，不能用清除记录来解锁重发。

<a id="sec-11"></a>

## 11  调度预算与运行模式

| 队列 | 触发与职责 |
| --- | --- |
| ingest | webhook 与轮询。通过幂等入站与出箱产生 Run 触发。 |
| cognition | 按 runId 加载状态，处理检索、规划与生成。慢模型调用有时限，租约内续约。 |
| execute | 仅领取 READY 的 LIVE 提案。按账号串行，执行前通过数据库许可。 |
| reconcile | 扫描过期执行租约、未知结果和迟到回执。按平台能力查询。 |
| maintenance | 反思、状态衰减、承诺扫描、过期清理、评测和修复出箱。作用域与凭据隔离。 |

调度依据数据库 next_at，锁定到期行并推进计划，在同事务写触发记录和出箱。触发键来自 scheduleId、计划 UTC 时刻及受众范围，重复扫描不得产生重复运行。日程使用 IANA 时区，夏令时缺失时刻跳过，重复时刻取较早实例。服务中断后普通活动只补最近一次且需仍在活动窗口，承诺提醒按未处理到期项恢复。计划修改后，旧任务按 scheduleVersion 取消。

默认公开写动作每账号 5 次/日，外部回复同一联系人至多 1 次/小时，默认静默时段 22:00–08:00，按角色时区。平台限制更严时取更严者。日预算按当地午夜换窗，按 UTC 落库。Redis 只能提前限速，数据库负责原子配额。按最晚发送时间和 Retry-After 计算延迟，默认可重试的暂时故障最多 3 次，退避 5 秒、30 秒、120 秒，加 0–20% 抖动。重试期超过有效期则过期。

SIMULATION 与 LIVE 使用不同部署凭据、队列命名空间和运行标识。模拟写入隔离副本、草稿与虚拟回执，不能消耗生产预算、污染生产记忆或取得真实写凭据。仿真可使用脱敏快照，校验权限和审批分支。提案不能从 SIMULATION 改为 LIVE，复用场景时必须创建新 Run。

启停分角色、身份和账号。暂停后阻止新发送许可，可继续记录回执和对账。恢复前复核队列中过期任务与权限变化。监控出箱积压、审批时长、未知结果、预算、授权拒绝、队列滞后及每身份活动量。

<a id="sec-12"></a>

## 12  API 与管理端

所有管理 API 以 /v1 为前缀。以下 /c 表示 /v1/characters/{characterId}。管理端使用可信身份提供方会话，Cookie 模式要求 CSRF 防护。Hono 在入口校验 schema、权限、角色归属和字段白名单。资源详情、列表、关联 ID、事件流及审批预览沿用同样的对象级授权。

| 方法与路径 | 输入及结果 |
| --- | --- |
| POST /v1/characters | ADMIN 创建角色。输入 slug、timezone、coreProfile。返回 201 与 id、version，初始 PAUSED。 |
| GET /c · GET /c/identities | 读取生效版本或有权限的身份列表。返回 status、version、profile 投影。 |
| PUT /c/core · PUT /c/policy | ADMIN 提交完整配置、If-Match、reason。返回新版本，推进 authEpoch。 |
| POST /c/identities · PUT /c/identities/{i} | ADMIN 创建或修订身份。输入 slug、roleProfile、timeWindow，修改需 If-Match。 |
| POST /c/accounts/connect · GET /c/accounts | 启动官方授权或列出账号。连接输入 identityId、platform、instanceKey，返回短期连接状态与受控跳转信息。 |
| GET /v1/oauth/{platform}/callback | 一次性 state、授权码和绑定校验。成功后回到管理页。 |
| PUT /c/accounts/{a}/permissions/{kind} | ADMIN 输入 mode、limits、If-Match 与 reason，更新动作权限并推进 authEpoch。 |
| GET /c/schedules · POST /c/schedules · PUT /c/schedules/{id} | ADMIN 管理计划。输入 zone、rule、enabled、intent 及作用域。更新需 If-Match，返回 scheduleVersion、nextAt。 |
| POST /c/controls | ADMIN 输入 scope、scopeId、operation、reason，操作为 PAUSE、RESUME、REVOKE_ACCOUNT，返回当前状态与可能在途数。 |
| GET /c/memories · POST /c/memories/{id}/revoke | 读取授权范围内元数据。ADMIN 可撤销来源可用性，返回 authEpoch 和清理任务 ID。 |
| POST /c/memory-grants · POST /c/memory-grants/{id}/revoke | ADMIN 输入记忆、接收身份及可选账号、用途、受众、开始结束时间、依据。撤销需 reason。 |
| POST /c/memory-promotions · POST /c/memory-promotions/{id}/decisions | 提交来源与候选摘要。ADMIN 审查并输入决定、reason、If-Match。 |
| POST /c/runs · GET /c/runs/{id} | OPERATOR 提交 mode、trigger、允许的账号提示及 intent。后端校验与绑定，返回 202 和 Location。详情返回状态、版本、快照摘要与提案引用。 |
| GET /c/actions · POST /c/actions/{id}/decisions | 待办列表与审批。REVIEWER 提交 APPROVE 或 REJECT、reviewDigest、reason 及 If-Match 对应运行版本，返回新状态。 |
| POST /c/actions/{id}/reconciliation | 有相应权限的 ADMIN 提交已送达或确认未送达的证据引用及原因。系统核验并推进对账。 |
| GET /c/audit · GET /c/events | 对象级授权的审计列表与运行事件流。事件流用 SSE，断线后按 Last-Event-ID 续读。 |
| GET /c/identities/{i}/reflections/{day} | ADMIN 或 AUDITOR 查看指定身份与 UTC 日的反思摘要和偏好候选引用。 |
| GET /c/identities/{i}/goals · POST /c/identities/{i}/goals | 列出该身份的手工和自主目标。ADMIN 可配置手工目标，或在身份版本中授权自主目标的主题、期限和预算。 |
| GET /c/accounts/{a}/automation-eligibility | ADMIN 或 AUDITOR 查看指定账号的低风险外部自动执行资格。M3 模拟阶段关闭外部 AUTO。 |
| POST /c/identities/{i}/beliefs/{id}/restore | ADMIN 输入 restoreVersion、reason 及 If-Match，证据复核通过后追加新版本。 |
| POST /v1/webhooks/{platform}/{routeKey} | 原始负载、平台签名和时间字段。验签后持久化。重复已接收事件返回相同语义的 2xx。 |

### HTTP 契约

有副作用的管理 POST 要求 Idempotency-Key，按调用者、资源路径及键去重。请求哈希不一致返回 409。并发同键仅一次创建。PUT 与审批等版本化命令要求 If-Match，缺失返回 428，版本变化返回 412。HTTP 401 为未认证，403 为无功能权限，跨角色资源返回 404，409 为状态冲突，422 为输入违反领域约束，429 为限流。返回 {error:{code,message,requestId,details?}}，details 禁止包含越权资源和秘密。

列表以 (createdAt,id) 游标稳定排序，默认 25 条，最大 100。SSE 使用审计事件的稳定递增流序号，断点超出保留期时要求全量刷新。OpenAPI 与运行时 schema 同源，Vue 3 客户端使用生成类型。管理员命令返回 requestId 便于追踪。

### 审批请求示例

```http
POST /v1/characters/{c}/actions/{id}/decisions
Idempotency-Key: approve-7c1
If-Match: "run-v12"
{
  "decision": "APPROVE",
  "reviewDigest": "<64位十六进制SHA-256>",
  "reason": "已核对私人账号、公开受众和引用来源"
}
200 {"data":{"runState":"READY","stateVersion":13}}
```

<a id="sec-13"></a>

## 13  领域事件与队列契约

采用事务出箱与可审计领域事件。当前视图从业务表读取。反思或回放可依据保存的版本与证据重建，完整事件溯源作为后续可选架构。生产事件只含引用和脱敏摘要。

```typescript
type DomainEvent<T> = {
  eventId: string; type: string; schemaVersion: 1;
  occurredAt: string; characterId: string;
  aggregateId: string; aggregateVersion: number;
  correlationId: string; causationId?: string; data: T;
}
```

| 事件 | 载荷与主要消费者 |
| --- | --- |
| InboundAccepted.v1 | inboundId、accountId、kind。认知创建或跳过 Run。 |
| ScheduleTriggered.v1 | scheduleId、scheduleVersion、plannedAt、triggerKey。认知挑选身份和账号。 |
| RunTransitioned.v1 | runId、state、stateVersion、reasonCode。审计与界面订阅。 |
| ApprovalRequested.v1 | actionId、runId、reviewDigest、expiresAt。审批待办投影。 |
| ApprovalDecided.v1 | actionId、decision、reviewDigest、version。审批审计和执行唤醒。 |
| ActionReady.v1 | actionId、runId、stateVersion。执行 Worker 尝试领取。 |
| DeliveryUncertain.v1 | actionId、attemptId、reasonCode。对账队列与告警。 |
| DeliveryConfirmed.v1 | actionId、receiptId、accountId、resultKind。回执与可用经历登记。 |
| AuthorizationChanged.v1 | scope、scopeId、authEpoch、reasonCode。失效调度和管理端更新。 |
| MemoryChanged.v1 | memoryId、revision、changeKind、authEpoch。索引、来源清理与评测。 |
| CognitionRevised.v1 | stateId、scopeKey、version、changeKind。时间线与漂移监控。 |

生产者在提交状态的事务中写 outbox。分发器用可恢复租约领取待发记录，BullMQ 成功接收后标记已送。崩溃可产生重复投递。消费者在同一业务事务写 consumer_inbox 并更新状态。外部动作以独立发送许可及 attempt 防重。队列消息只有事件 ID、聚合 ID 和追踪键。消息过旧时按聚合版本忽略，存在版本缺口时重读持久状态。无效 schema 入死信并告警，修复后按原 eventId 重放。

<a id="sec-14"></a>

## 14  可观测性与运维

用 requestId、correlationId、runId、actionId 贯通 API、队列和执行。日志可记录身份 ID、策略版本、状态、耗时、限流和脱敏错误码。禁止记录密钥、完整提示、私人会话及未经批准的模型输出。审计保留操作者、受影响资源、版本差异、审批和执行凭证引用。

| 信号 | MVP 告警初值及处置 |
| --- | --- |
| 未知发送 | 每条立即标记人工对账，账号保持写入阻断。 |
| 失效延迟 | 授权变更后的新许可须即时拒绝。已排队旧提案应在 60 秒内可见为过期或失效。 |
| 出箱与队列 | 最老未发送事件超过 60 秒告警，按数据库恢复未完成作业。 |
| 权限与质量 | 监控跨身份拒绝、注入样例命中、重复动作、管理员干预率及披露失败。按作用域报告。 |
| 资源 | 记录每角色模型 token、队列滞后、认知耗时及预算。超过上限时降频或跳过可选任务。 |

部署采用分环境凭据和数据库角色。迁移在启动 Worker 之前完成，破坏性改表走扩展、迁移、收缩。备份恢复演练应包含 outbox 重建、撤销墓碑、未知发送停留与审批失效。监控最小活性与就绪检查分别覆盖进程、数据库及必要队列连接。生产恢复前保持外部发送关闭。

<a id="sec-15"></a>

## 15  测试与验收

### 必须通过的场景

| 编号 | 自动验收与预期 |
| --- | --- |
| AT-01 | 建一个核心、三个身份、两个模拟平台，分别运行相同主题。核心版本一致，账号和语言风格按身份配置，三方时间线独立。 |
| AT-02 | 注入高度相关的公司机密作为测试标记，从私人账号检索与生成。禁止数据出现在排序输入、模型请求、输出、日志及快照内容。SQL 错配插入由组合外键拒绝。 |
| AT-03 | 为可共享记忆只授予 DECISION_SUPPORT。内部候选可使用，写作调用不得接收。再授予指定受众引用权，仅对应账号和受众可写入。 |
| AT-04 | 批准提案后撤回权限或删除来源，在发送许可前执行。必须拦截，适配器写调用为 0。预先获准且在途的请求保留审计和对账。 |
| AT-05 | 同时提交两份审批或重放同一命令。只产生一个有效审批和一次状态变化。过期摘要、旧 If-Match 以及自审均失败。 |
| AT-06 | 并发投递 100 次同一入站事件，最终仅 1 个入站、1 个 Run、1 个提案。并行两账号执行无串号，停用账号不自动换绑。 |
| AT-07 | 在出箱入队后、提交发送许可后和收到远端结果前分别杀死进程。恢复可推进。对无幂等保证的未知请求，额外发送次数为 0。 |
| AT-08 | 向私聊与公开回复注入账号切换、索要密钥及忽略策略文本。模型无写权限，写入受控输出只走当前身份。脱敏日志不包含凭据。 |
| AT-09 | 在 SIMULATION 运行发布与审批分支，真实写调用为 0，生产预算和记忆无变化。模拟提案不能转 LIVE。 |
| AT-10 | 测试暂停、凭据撤销、令牌主体错配、缺失披露、越时段和配额并发。未获许可写入为 0，配额永不超发。 |
| AT-11 | 跨日、夏令时、时钟前移及停机恢复后重扫计划。每个计划时刻只建一个触发。过期任务跳过，承诺提醒不丢失。 |
| AT-12 | 对同一状态事件重放及乱序投递，最终状态一致。无事件时趋向基线。单一来源重复输入不能推动正式信念演化。核心价值写入被拒绝。 |
| AT-13 | 模拟确认对外承诺并延期，再回滚普通观点。承诺按账号和对象检索。回滚生成新版本，撤销证据不可复活。 |
| AT-14 | 注入相同话题的跨平台内容及拒绝互动对象。跨平台近似去重按配置提醒审查，未授权的身份关联、提及和私信不执行。 |

### 测试层与通过标准

单元测试冻结时间与固定排序。数据库集成测试使用真实 PostgreSQL，覆盖迁移、RLS、事务竞争与删除链。轮换池连接并在缺少事务上下文时测试默认拒绝。用 Redis/BullMQ 集成测试验证出箱、租约、重试和重放。以假模型捕获每次提示，使用模拟适配器记录实际账号及调用次数。端到端测试从 Vue 审批到 Hono 命令、Worker 和平台回执。上线前用平台测试账号通过签名、授权和对账契约。

M1 的 AT-10 使用受信宿主独立提供的已验证远端主体，验证它与载荷和账号绑定一致，以及账号撤销后拒绝新许可。真实凭据签发和撤销、OAuth 主体及回调签名按第 09 章的测试账号试点验收。

门槛为所属阶段所有强制用例通过，跨身份泄露、审批绕过、模拟外发、已确认重复写入均为 0。MVP 性能基线为 3 个身份、10 万条角色记忆和 10 并发 Run。授权检索与重排 P95 ≤ 300 ms，不含模型调用。验收记录部署配置、数据分布及测试报告。认知连续性评测按同一批脚本比较多个版本的身份语气、事实与虚构区分、观点证据、承诺处理与隐私边界。

<a id="sec-16"></a>

## 16  MVP 与迭代交付

| 阶段 | 实现范围与退出条件 |
| --- | --- |
| M0  工程基线 | 初始化 TypeScript 工作区、API/Worker/管理端、PostgreSQL/Prisma/Redis、迁移、角色授权、结构化日志及测试环境。CI 从空库迁移，跑通 API 和单个出箱作业。 |
| M1  可靠角色基础 | 统一核心、三身份、两个模拟平台、四层记忆和授权、绑定上下文、关键词召回、草稿、审批、执行、对账、暂停、模拟与调度。关闭外部自动发布。按[第 17 章](#sec-17)显式注册适配器及模型实现，并通过 M1 插件验收。用固定数据提供时间与承诺夹具，支撑 AT-11。AT-01 至 AT-11 通过。真实平台试点需测试账号通过第 09 章适配器契约。 |
| M2  角色连续性 | 时间上下文、SelfModel、来源追溯和记忆纠错、承诺及关系、自主目标的手工配置入口。新增 AT-13 及 AT-14 中与关系边界有关的场景。 |
| M3  自主成长 | 动机、情绪及抽象投影、证据化观点、状态回滚与自主目标生成。AT-12、AT-13 全部通过。分开评估每个账号的低风险自动执行资格。 |
| M4  长期运行 | 混合检索、跨平台近似去重、长期评测、漂移告警及成本治理。AT-14 全部通过。以不少于 14 天模拟记录评估泄露、重复、行为频率及人工干预率。 |

### 开发 Agent 的首个闭环

先交付迁移、最小种子数据与假模型，再完成两个平台的入站和固定上下文。随后接通授权召回、决策状态机、审查控制台、事务出箱与模拟执行。最后加入故障注入、撤权和隔离回归。每阶段交付可运行源码、迁移、环境变量示例、OpenAPI、自动测试报告和部署操作说明。

默认实现参数由策略版本记录。首次真实部署需配置平台、账号、角色时区、模型环境与保留期限，并分别登记批准的动作。初始状态为 PAUSED，完成模拟验收后由管理员按账号启用 LIVE。

### 实现参数与配置边界

采用结构化配置分离应用环境与角色政策。DATABASE_URL、REDIS_URL、OIDC_ISSUER、CREDENTIAL_STORE、MODEL_ENDPOINT、APP_ENV、LIVE_SEND_ENABLED 由部署注入，生产默认 LIVE_SEND_ENABLED=false。验证配置后再启动消费者。初始时区默认 UTC，管理员按角色更新。首版不固定模型供应商，模型接口必须支持结构化结果、超时和按用途隔离调用。Redis 重建后从 PostgreSQL 扫描未送出箱、到期计划、可恢复 Run 和待对账尝试。

### 实现参考

- [PostgreSQL 行级安全](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Prisma 自定义数据库迁移](https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)
- [BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs)
- [pgvector 检索与索引](https://github.com/pgvector/pgvector)

<a id="sec-17"></a>

## 17  插件架构与演进计划

插件层负责装配和管理可替换能力。领域服务通过 TypeScript 接口调用能力实现，Hono API 和各 Worker 在各自进程的启动入口注册所需实现。M1 使用随部署发布的受信任实现、显式注册和部署级启用配置。进程中已加载的实现仍须通过角色、身份和账号的授权判定。

### 扩展点与交付顺序

| 扩展点 | 实现职责 | 首次交付 |
| --- | --- | --- |
| PlatformAdapter | 按第 09 章提供验签、归一化、轮询、能力声明、执行和对账。按进程职责装配相应能力。 | M1 注册两个模拟适配器。真实平台先验证只读入站，再单独启用外发。 |
| ModelProvider | 接收宿主按用途构建的最小上下文、输出 schema、时限与取消信号，返回结构化结果与用量。 | M1 提供假模型及可替换接口。模型选择由宿主配置。 |
| MemoryRanker | 对已授权候选排序，返回候选 ID 和评分。宿主验证结果属于输入集合，并应用条数与 token 上限。 | M1 使用内置排序。M4 混合检索时按需求开放注册。 |
| Evaluator | 使用经过批准的回放输入输出评分和诊断。 | M4 按长期评测需求引入。 |

### 注册与配置

注册项须声明稳定的实现 ID、实现版本、宿主契约版本、能力类型、配置校验规则和必需的宿主服务。同一能力类型与实现 ID 只能有一个生效注册。启动时校验契约、配置和依赖。启用项配置无效、注册冲突或缺少必需依赖时，拒绝启用并记录原因。缺少可选插件时，对应能力显示不可用。

M1 用代码允许列表限定实现，部署配置按 ID 选择启用项。插件启用与账号授权分别判定。宿主记录插件 ID、版本、启用结果和错误码。配置只保存凭据引用，日志和事件只记录脱敏摘要。

### 权限与进程边界

- 入站进程获得验签、归一化和受限读取能力。认知进程按用途调用模型和排序器。执行进程在校验账号、目标和发送许可后，读取执行所需凭据、调用适配器并保存回执。
- 插件只接收调用所需的结构化输入和窄接口。记忆查询、身份绑定、审批、发送许可、配额和对账状态仍由宿主控制。扩展结果不得覆盖硬拒绝，模型或插件返回的账号和目标须与原运行绑定一致。
- 进程内服务作用域用于依赖装配。身份数据访问由领域授权、数据库约束和独立进程的服务凭据保障。若后续允许第三方不受信任代码，须另行设计并验收进程或容器隔离、网络访问控制和能力代理。
- 插件的进程内事件可用于就绪、停用和诊断。需跨进程或可恢复的业务事件继续按第 13 章写入事务出箱，并由 BullMQ 派送。

### 生命周期与版本切换

宿主按“校验配置 → 注册 → 启动 → 就绪 → 停止接收新调用 → 释放资源”的顺序管理实现。插件须释放轮询计时器、订阅、连接和监听器。释放须可重复调用，启动失败时清理已取得的资源。M1 通过进程重启更新实现，并通过就绪状态和结构化日志暴露失败。

宿主把实际使用的实现 ID 和版本记录到运行快照。外部动作的审查摘要须绑定执行适配器的实现 ID、版本和能力版本。若其中一项变化，未发送提案按第 10 章使原审批失效并重新审查。停用后禁止开始新的插件调用。已在途的外部请求按现有许可、回执和对账规则处理。旧实现不可用时，保留未知结果并进入人工处置。禁止以换插件或重启为由重发。

### 扩展条件与验收

插件与应用一起发布。启动入口用工厂函数注入所需依赖，注册表按能力类型和实现 ID 选择实现。部署配置只引用已注册 ID。有常驻资源的实现提供启动与停止方法，由宿主统一调用。新增平台或模型时沿用相同接口和注册流程。

若不同部署需要按需加载模块，可在注册入口增加允许列表和动态加载。若多个实现重复处理依赖就绪、独立启停或资源清理，再评估是否抽取通用装配逻辑。动态安装、管理端上传代码及生产热替换须另行设计。

| 验收 | 可观察结果 |
| --- | --- |
| PL-01 注册与依赖 | 重复 ID、无效配置、契约不兼容或缺少必需服务时，受影响实现不进入就绪状态，诊断可定位实现和原因。 |
| PL-02 权限 | 已加载实现无法使用未授权账号。模拟运行和只读连接器的真实写调用数均为 0，既有身份隔离与审批用例通过。 |
| PL-03 清理与恢复 | 带轮询的连接器连续启停并重启后，停用状态下轮询数为 0，启用时每个配置只有一个轮询实例。重复入站仍按原规则去重。 |
| PL-04 执行切换 | 替换适配器导致审查依赖变化时，未发送提案的旧审批失效。在途结果继续对账，未知结果的额外发送次数为 0。 |

M1 完成 PL-01、PL-02 中的模拟与授权场景，以及 PL-04。启用首个真实只读连接器前，补验 PL-02 的只读场景。引入常驻轮询时须通过 PL-03。
