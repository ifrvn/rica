# 管理 API 启用与使用

M1.3 提供管理 API 和受保护的 OpenAPI 契约。健康检查沿用现有路径。未配置管理连接和身份提供方时，服务不挂载管理路由。

## 启用

1. 使用迁移账号执行 `pnpm run db:migrate`。
2. 由数据库管理员创建独立登录并授予 `rica_admin_api`。该登录只用于 `RICA_MANAGEMENT_DATABASE_URL`。身份提供方的密钥和数据库凭据由部署环境注入。
3. 配置示例环境文件中列出的 `RICA_IDP_*` 变量。身份提供方需为 Rica 签发专用受众的访问令牌，并提供 HTTPS 令牌自省端点。Rica 使用 `client_secret_basic` 访问自省端点，要求有效响应包含 `active`、`iss`、`aud`、`sub`、`exp`，并检查存在的 `nbf`。[OAuth 2.0 令牌自省规范](https://www.rfc-editor.org/rfc/rfc7662)
4. 将获准创建角色的身份主体 `sub` 放入逗号分隔的 `RICA_ADMIN_CREATOR_SUBJECTS`。创建者自动获得所创建角色的 ADMIN 权限。已有角色可由数据库管理员按同一发行者及主体补充授权。
5. 在身份提供方完成登录后，以 `Authorization: Bearer <access-token>` 调用管理 API。API 只从该请求头获取令牌，部署时经 HTTPS 代理访问。OpenAPI 文档位于 `GET /v1/openapi.json`。

数据库登录使用普通权限。示例中的登录名称按部署替换。

```sql
GRANT rica_admin_api TO rica_management_login WITH INHERIT TRUE, SET TRUE;
```

给已有角色补充第一名管理员时，在同一事务中先锁定对应的 `characters` 行，再向 `management_memberships` 插入 `character_id`、`issuer`、`subject` 和 `role = 'ADMIN'`。后续可通过管理 API 授予或撤销权限。访问令牌中的角色声明不参与 Rica 授权。

## 已开放的入口

以下 `/c` 表示 `/v1/characters/{characterId}`。

| 入口 | 权限与操作 |
| --- | --- |
| `GET /v1/characters`、`GET /c` | 当前主体获准访问的角色与生效配置投影。 |
| `POST /v1/characters`、`PUT /c/core` | 指定主体创建初始暂停角色。ADMIN 提交新核心版本。 |
| `GET /c/identities`、`POST /c/identities`、`PUT /c/identities/{identityId}` | 成员读取。ADMIN 创建初始暂停身份或提交新身份版本。 |
| `GET /c/accounts`、`POST /c/accounts` | 成员读取脱敏列表。ADMIN 登记初始暂停的模拟账号。 |
| `POST /c/controls` | ADMIN 暂停或恢复角色、身份、模拟账号，也可撤销账号。恢复真实账号须走平台授权。 |
| `GET /c/memories`、`GET /c/memory-grants` | ADMIN 读取记忆元数据和共享授权。 |
| `POST /c/memory-grants`、`POST /c/memory-grants/{grantId}/revoke` | ADMIN 创建或撤销用途授权。公开引用绑定指定会话，私聊回复绑定确切的会话与联系人。 |
| `POST /c/memberships` | ADMIN 授予或撤销当前发行者下的角色权限。必须保留至少一名 ADMIN。 |
| `GET /c/audit` | ADMIN 和 AUDITOR 读取操作元数据、摘要哈希和请求 ID。 |
| `GET /c/actions`、`GET /c/actions/{actionId}` | REVIEWER 读取模拟待办和经复核的提案预览。列表不含正文。 |
| `POST /c/actions/{actionId}/decisions` | REVIEWER 提交批准或拒绝、reviewDigest 和理由。If-Match 使用提案详情的 ETag，例如 "run-v3"。 |

POST 带 `Idempotency-Key`。同一主体在同一路径使用相同键和相同输入，24 小时内会得到相同业务结果。键相同但输入不同返回 409。PUT 带强版本头，例如 `If-Match: "1"`。旧数据尚无生效版本时使用 `If-Match: "0"`。缺少版本返回 428，版本过时返回 412。无令牌或令牌无效返回 401，成员权限不足返回 403，跨角色资源返回 404。

列表默认 25 条，最多 100 条。后续请求把响应的 `nextCursor` 作为 `cursor` 传回。审计记录、状态修改和幂等结果一起提交，审计中保留摘要哈希及请求 ID。授权变化推进角色授权纪元，并沿用旧草稿清理规则。

## 模拟审批

使用 Vue 管理台的人工审批区，填入身份提供方签发的访问令牌，再选择角色。令牌仅保留在当前页面内存。批准将提案推进到 READY，等待已启用的独立模拟执行进程。拒绝会终止提案。同一次运行只有一份提案和一个有效决定。[模拟执行说明](simulation-execution.md)

预览和决定都会复核绑定、正文摘要和授权证据。撤权或配置版本更新时，待审和已批准提案会随授权纪元变化失效。适配器或策略版本不匹配、证据过期以及正文变化时，预览会隐藏正文。提交决定时会记录失效或过期状态和审计。后台过期扫描随调度接入。迁移前生成的草稿没有审批摘要，保留为 DRAFTED。真实平台 OAuth、执行许可和回执按后续工作包交付。
