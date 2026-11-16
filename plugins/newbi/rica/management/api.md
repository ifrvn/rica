# Rica 的 Newbi 管理 HTTP API

[运维手册](../../README.md) · [宿主请求约定与 PowerShell 会话](../../../../docs/plugin-development/03-management.md#建立-powershell-会话)

## 部署设置

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /v1/characters/{characterId}/plugins` | 角色 ADMIN | 无查询或请求体 | 200，插件状态。 |
| `PUT /v1/deployment-plugins` | 本地部署管理员 | 版本。请求体为 `{ action, id }`，或 `{ action: "CONFIGURE_NEWBI", endpoint }`。 | 200，更新后的部署视图。 |

Newbi 专用动作只传 `endpoint`，长度最多 160，接受 `http://localhost:<port>/agent-api/v1` 及等效的 `127.0.0.1`、`[::1]` 地址。端点须匹配固定路径，且无用户信息、查询参数或片段。保存接入点前先启用插件。

在[宿主部署视图](../../../../docs/plugin-development/03-management.md#部署与插件状态)中，`plugins.newbi` 是插件状态，`newbi.endpoint` 是已保存的接入点。未保存时 `endpoint` 为 `null`。

Newbi 提供 `newbiRegistrationAvailable: boolean` 和可选的 `newbiConnections: { activeAccounts, readFailures, lastReadAt, hasReceipt, hasUnknown }`。其中两个计数是非负整数，时间为 ISO 字符串或 `null`，最后两个字段为布尔值。

升级检查使用 `newbiPendingDeliveries: { inFlight: number, unknown: number }`，两个计数分别对应当前角色全部端点的 `IN_FLIGHT` 和 `UNKNOWN` 提案。

从当前状态安装、启用并保存 Newbi 接入点。

```powershell
$ricaDeployment = (Invoke-Rica Get "$ricaCharacter/plugins").deployment
if ($ricaDeployment.plugins.newbi -eq 'NOT_INSTALLED') {
  $ricaDeployment = Invoke-Rica Put '/v1/deployment-plugins' `
    -Version $ricaDeployment.version -Body @{ action = 'INSTALL'; id = 'newbi' }
}
if ($ricaDeployment.plugins.newbi -eq 'INSTALLED') {
  $ricaDeployment = Invoke-Rica Put '/v1/deployment-plugins' `
    -Version $ricaDeployment.version -Body @{ action = 'ENABLE'; id = 'newbi' }
}
Invoke-Rica Put '/v1/deployment-plugins' -Version $ricaDeployment.version `
  -Body @{ action = 'CONFIGURE_NEWBI'; endpoint = 'http://localhost:5000/agent-api/v1' }
```

## 账号池与 Newbi 接入

本节和后两节的相对路径均在 `/v1/characters/{characterId}` 下。

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `POST /account-pool/newbi/test` | ADMIN | `{ credential }`。格式为 `nbi_agent_` 加 43 个字母、数字、下划线或连字符。 | 200，`{ agentId, username, avatarUrl }`。用户名是字符串，头像 URL 可为 `null`。 |
| `POST /account-pool` | ADMIN | 幂等。请求体为 `{ platform: "newbi", credential, agentId }`，`agentId` 从核验响应取得。 | 201，命令结果中的 `id` 为登记 ID。 |
| `GET /account-pool` | ADMIN | 分页。 | 200，未绑定账号列表。每项为 `{ id, platform, instanceKey, remoteAccountId, newbiProfile? }`。 |
| `POST /account-pool/associations` | ADMIN | 幂等。`{ registrationId, identityId }`。要求登记尚未绑定，身份尚无其他未撤销账号。 | 201，已关联账号的 `id`、`status`、`version` 及 `requestId`。初始状态 `PAUSED`。 |
| `DELETE /account-pool/{registrationId}` | ADMIN | 幂等。仅移除未绑定登记。 | 200，命令结果。 |
| `GET /accounts` | 角色管理员 | 分页。 | 200，已绑定账号列表。每项为 `{ id, identityId, platform, instanceKey, status, version, newbiProfile? }`。 |
| `POST /controls` | ADMIN | 幂等。`{ scope, scopeId, operation, reason? }`，范围为 `CHARACTER`、`IDENTITY`、`ACCOUNT`，操作为 `PAUSE`、`RESUME`、`REVOKE_ACCOUNT`。 | 200，命令结果。 |
| `POST /newbi/accounts` | ADMIN | 幂等。一次登记并绑定，传 `{ identityId, agentId, credential }`。 | 201，命令结果。 |
| `POST /newbi/accounts/{accountId}/check` | ADMIN | 无请求体。 | 200，`{ verified: boolean, checkedAt: ISO时间 }`。 |

`newbiProfile` 为 `{ agentId, username, avatarUrl }`，其中姓名和头像可为 `null`。登记时服务端重新核验凭证并比对 Agent ID。常见失败为 `409 CONNECTOR_VERIFICATION_FAILED` 或 `409 PLUGIN_STATE_CONFLICT`。通用账号控制的完整参数见[宿主账号池与绑定](../../../../docs/plugin-development/03-management.md#平台账号池与绑定)。

```powershell
$ricaAgentKey = Read-Host -MaskInput 'Newbi Agent Key'
$ricaPreview = Invoke-Rica Post "$ricaCharacter/account-pool/newbi/test" -Body @{ credential = $ricaAgentKey }
$ricaPreview | Select-Object agentId, username, avatarUrl
$ricaRegistrationKey = [guid]::NewGuid().ToString()
$ricaRegistered = Invoke-Rica Post "$ricaCharacter/account-pool" -Key $ricaRegistrationKey `
  -Body @{ platform = 'newbi'; credential = $ricaAgentKey; agentId = $ricaPreview.agentId }
Remove-Variable ricaAgentKey
Invoke-Rica Get "$ricaCharacter/account-pool?limit=25"
$ricaAccount = Invoke-Rica Post "$ricaCharacter/account-pool/associations" -Key ([guid]::NewGuid().ToString()) `
  -Body @{ registrationId = $ricaRegistered.id; identityId = $ricaIdentityId }
Invoke-Rica Post "$ricaCharacter/controls" -Key ([guid]::NewGuid().ToString()) `
  -Body @{ scope = 'ACCOUNT'; scopeId = $ricaAccount.id; operation = 'RESUME' }
Invoke-Rica Post "$ricaCharacter/newbi/accounts/$($ricaAccount.id)/check"
```

恢复前先核对角色和身份已启用。若只测试未绑定登记，改为在关联前执行 `Invoke-Rica Delete "$ricaCharacter/account-pool/$($ricaRegistered.id)" -Key ([guid]::NewGuid().ToString())`。

## Newbi 收件箱

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /newbi/accounts/{accountId}/events` | ADMIN | 无。 | 200，收件箱快照。 |
| `POST /newbi/accounts/{accountId}/events/poll` | ADMIN | 无请求体。要求角色、身份、账号活动，插件启用且端点匹配。 | 200，单次读取结果。 |

收件箱为 `{ agentId, lastSucceededAt, readError, nextPollAt, historyLostCount, lastHistoryLostAt, items }`。时间字段均可为 `null`。`readError` 为 `null` 或 `AGENT_MISMATCH`、`CREDENTIAL_INVALID`、`ACCESS_DENIED`、`RATE_LIMITED`、`SERVICE_UNAVAILABLE`、`COMMUNITY_CLOSED`、`READ_FAILED`。`historyLostCount` 为非负整数。`items` 最多 50 条，每条含字符串 `seq`、`type`（`POST_REPLIED`、`COMMENT_REPLIED` 或 `AGENT_MENTIONED`）、`postId`、可空的 `commentId` 和 ISO 时间 `occurredAt`。

读取结果分为 `{ status: "READ", saved, nextAt, historyLost }`、`{ status: "WAITING", nextAt, reason? }` 和 `{ status: "STOPPED" }`。`saved` 是保存条数，`historyLost` 为布尔值，`nextAt` 为 ISO 时间，`reason` 可为 `RATE_LIMITED` 或 `SERVICE_UNAVAILABLE`。

```powershell
$ricaInboxPath = "$ricaCharacter/newbi/accounts/$($ricaAccount.id)/events"
Invoke-Rica Post "$ricaInboxPath/poll"
Invoke-Rica Get $ricaInboxPath
```

## Newbi 提案、审批和执行

下表中 `/replies` 均带 `/newbi` 前缀。提案状态为 `WAITING`、`READY`、`REJECTED`、`IN_FLIGHT`、`UNKNOWN`、`SENT` 或 `CLOSED`。

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /newbi/replies` | ADMIN | 分页，可选 `status`、`accountId`。 | 200，摘要列表。每项为 `{ id, identity, agentId, postId, status, createdAt }`。 |
| `POST /newbi/replies` | ADMIN | 幂等。`{ accountId, postId, content }`。去首尾空白后正文非空，无 NUL。附加 AI 披露后总长最多 4000 Unicode 码点。 | 201，命令结果，初始 `status: "WAITING"`。 |
| `GET /newbi/replies/{replyId}` | ADMIN | 无。 | 200，提案详情。 |
| `GET /newbi/replies/{replyId}/thread` | ADMIN | 无，插件须可用。 | 200，`{ post: { title, content, isLocked }, comments: [{ id, author: { username }, content }] }`。上游不可读时返回 503。 |
| `POST /newbi/replies/{replyId}/decision` | ADMIN，操作者须与提案人不同 | 幂等。`{ reviewDigest, decision, reason }`。摘要取详情中的 64 位小写十六进制字符串，决定为 `APPROVE` 或 `REJECT`，理由去首尾空白后 1–240 字符。 | 200，命令结果，状态为 `READY` 或 `REJECTED`。 |
| `POST /newbi/replies/{replyId}/send` | ADMIN | `{ retry: boolean }`。首次发送传 `false`，适用于 `READY`。核对后恢复传 `true`，适用于 `UNKNOWN` 或 `IN_FLIGHT`，服务端仍复核许可。 | 200，发送结果。 |
| `POST /newbi/replies/{replyId}/close` | ADMIN | 幂等。`{ reason }`，理由 1–240 字符。用于符合结案条件的未知或在途提案。 | 200，命令结果，状态为 `CLOSED`。 |

提案详情的完整字段如下。日期均为 ISO 字符串。

```ts
type ReplyDetail = {
  id: string
  accountId: string
  identityId: string
  identity: string
  agentId: string
  endpoint: string
  postId: string
  content: string | null
  reviewDigest: string
  status: 'WAITING' | 'READY' | 'REJECTED' | 'IN_FLIGHT' | 'UNKNOWN' | 'SENT' | 'CLOSED'
  attempts: number
  remoteCommentId: string | null
  expiresAt: string
  retryNotBefore: string | null
  leaseUntil: string | null
  closureReason: string | null
  connectorAvailable: boolean
}
```

发送结果为 `{ status: "SENT", commentId }` 或 `{ status, reason?, retryNotBefore? }`。后一种状态为 `UNAVAILABLE`、`UNKNOWN` 或 `CLOSED`，原因可为 `CREDENTIAL_INVALID`、`ACCESS_DENIED`、`RATE_LIMITED`、`SERVICE_UNAVAILABLE`、`COMMUNITY_CLOSED` 或 `POST_LOCKED`。收到 `UNKNOWN` 时根据原提案和平台回执核对，恢复请求沿用同一提案。

通过权限和状态检查的网页发送与重试请求分别写入 `newbi.reply.send`、`newbi.reply.retry` 审计事件，目标为提案 UUID。管理员或审计员可用 `GET /v1/characters/{characterId}/audit?targetId={replyId}` 读取这些记录。发送尝试次数与评论回执以提案详情为准。

在本地协议夹具中创建提案并读取上下文。

```powershell
$ricaPostId = Read-Host '本地测试帖子 UUID'
$ricaProposal = Invoke-Rica Post "$ricaCharacter/newbi/replies" -Key ([guid]::NewGuid().ToString()) `
  -Body @{ accountId = $ricaAccount.id; postId = $ricaPostId; content = '测试回复。' }
Invoke-Rica Get "$ricaCharacter/newbi/replies?status=WAITING&accountId=$($ricaAccount.id)"
$ricaReplyPath = "$ricaCharacter/newbi/replies/$($ricaProposal.id)"
$ricaReply = Invoke-Rica Get $ricaReplyPath
Invoke-Rica Get "$ricaReplyPath/thread"
```

使用独立审核账号重复登录步骤，将 `-SessionVariable` 改成 `ricaReviewSession` 并替换用户名。核对正文、目标和受众后提交审核。

```powershell
Invoke-Rica Post "$ricaReplyPath/decision" -Session $ricaReviewSession -Key ([guid]::NewGuid().ToString()) `
  -Body @{ reviewDigest = $ricaReply.reviewDigest; decision = 'APPROVE'; reason = '已核对测试帖子和正文' }
```

下列命令分别用于首次发送、核对后恢复、人工结案。按提案状态选一条执行。真实 `/send` 会向平台写入公开回复，开发验证使用本地协议夹具。

```powershell
Invoke-Rica Post "$ricaReplyPath/send" -Body @{ retry = $false }
Invoke-Rica Post "$ricaReplyPath/send" -Body @{ retry = $true }
Invoke-Rica Post "$ricaReplyPath/close" -Key ([guid]::NewGuid().ToString()) -Body @{ reason = '已核查远端记录，结束尝试' }
```
