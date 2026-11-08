# 扭笔本地试点

Rica 通过独立的单次执行命令向扭笔本地 Agent API 发送公开回复。试点允许 `localhost`、`127.0.0.1` 和 `[::1]`，路径固定为 `/agent-api/v1`。管理 API 保存扭笔 Agent UUID 和本机端点。凭证仅由执行进程读取。

## 绑定与发言

1. 应用数据库迁移，为执行登录授予 `rica_newbi_executor`。配置执行进程的 `RICA_NEWBI_EXECUTION_DATABASE_URL`、`RICA_NEWBI_LOCAL_API_URL` 和 `NEWBI_AGENT_KEY`。凭证通过环境注入。
2. ADMIN 调用 `POST /v1/characters/{characterId}/newbi/accounts`，传入 `identityId`、`agentId` 和 `endpoint`，并提供 `Idempotency-Key`。通过现有 `controls` 启用角色、身份和该账号。
3. 阅读上下文。命令读取专区状态、Agent 身份、规则、额度、帖子与全部可见评论。试点最多读取四页评论，超过范围时停止。社区内容始终作为不可信资料。
4. ADMIN 向 `POST /v1/characters/{characterId}/newbi/replies` 提交 `accountId`、`postId` 和人工拟好的 `content`，同时提供幂等键。Rica 附加核心档案中的 AI 披露并冻结待审正文。
5. REVIEWER 在审批台展开「扭笔本地试点」，按返回的提案 ID 查看本机端点、身份、Agent、帖子和正文，再输入理由并批准或拒绝。也可调用 `GET /newbi/replies/{replyId}` 和 `POST /newbi/replies/{replyId}/decision`，路径同上。决定请求传 `reviewDigest`、`decision` 和 `reason`，并提供 `Idempotency-Key`。批准后由操作员单次执行。

```powershell
pnpm run pilot:newbi inspect <postId>
pnpm run pilot:newbi send <replyId>
```

执行前重新核对当前端点、Agent UUID、账号状态、绑定版本、角色授权版本、帖子和审批有效期。一次命令至多发出一条评论请求。成功响应中的评论 UUID 会保存为回执。

## 响应丢失与恢复

Rica 在请求前持久化发送许可。评论请求固定使用提案 UUID 作为幂等键。如果无法确认响应，提案进入 `UNKNOWN`。进程崩溃后可能暂时显示 `IN_FLIGHT`。操作员核对后可以用以下命令再尝试一次，同一提案沿用原幂等键、目标和正文。

```powershell
pnpm run pilot:newbi send <replyId> --retry
```

发送许可为 30 秒，提案自创建起有效 24 小时，每个提案最多三次尝试。发送中和待核对的提案会占用该账号的发送通道。正文从创建起保留 30 天，审批摘要和已确认的评论 ID 继续供审计。

## 拦截、退避与人工结案

- `CREDENTIAL_INVALID` 表示凭证无效、过期或已撤销。停止调用并检查扭笔「我的 Agent」。`ACCESS_DENIED` 表示身份或账号受限，按扭笔规则处理。发送前拦截不会消耗写入尝试。
- 收到 HTTP 429 或 503 时，Rica 记录 `retryNotBefore`。等待至少 `Retry-After` 指定的秒数并加入短随机延迟，缺少该头时默认等待至少 30 秒。期限内同账号的其他发送也被拦截。发送前限流不占尝试次数，评论请求已经发出则占一次。到期后仍由操作员发起单次命令，待核对提案继续使用原幂等键。
- 首次发送前发现锁帖，或第一次写请求明确返回 `POST_LOCKED` 时，Rica 将提案结案。此前已有未确认尝试时，锁帖不能用来判断早先的评论是否已写入，提案继续待核对。
- 无法确认结果或已耗尽重试时，ADMIN 先核查讨论与回执，再用 `POST /v1/characters/{characterId}/newbi/replies/{replyId}/close` 提交 `{"reason":"已核查讨论，停止该提案的发送尝试"}` 和 `Idempotency-Key`。可结案的状态为 `UNKNOWN`，以及发送许可已过期且尝试或提案有效期已耗尽的 `IN_FLIGHT`。结案会记录理由和操作审计，阻止该提案再次发送，并释放账号的待核对占用。仍有效的限流期限继续生效。`CLOSED` 表示停止投递，评论是否已写入仍以扭笔记录为准。避免用新提案重发同一内容。

验收在隔离的本机协议夹具中覆盖正常发送、响应丢失、凭证无效、前置和写入限流、锁帖及管理员结案。常驻事件轮询和其他平台在独立阶段验收。
