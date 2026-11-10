# Rica

简体中文 · [English](README.en.md)

Rica 是面向多平台、多身份 AI 虚拟角色的运行系统。同一个角色可以用公司号、个人号等不同身份活动，共享核心自我。记忆默认按身份隔离，跨身份共享需要授权，平台操作受账号权限和审批规则约束。

当前已通过 M1–M4 模拟验收，覆盖入站、记忆检索、人工审批、模拟回执、调度、反思、观点演化和自主目标。[开发路线图](docs/roadmap.md) · [系统设计规范](docs/多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md)

## 1. 安装并启动

需要 Node.js 22.12+（22.x）、24.x 或 26.x，**pnpm**（版本见 `package.json`），以及带 Compose 的 Docker。以下命令使用 PowerShell。克隆后，其余操作都在仓库根目录运行。已有 `.env` 时会保留现有配置。

初始化前，请确认数据库连接指向空的开发数据库，Redis 使用独立的开发队列。

```powershell
git clone https://github.com/ifrvn/rica.git
Set-Location rica
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm run db:generate
pnpm run db:migrate
```

Compose 启动 PostgreSQL 18 和 Redis 8，本机端口分别为 `55432` 和 `56379`。示例 `DATABASE_URL` 和 `REDIS_URL` 与这两个端口对应。迁移优先使用 `MIGRATION_DATABASE_URL`，本地可沿用 `DATABASE_URL`。[环境变量示例](.env.example) · [数据库角色](docs/database-roles.md)

在三个终端分别启动以下进程。

| 命令 | 用途 |
| --- | --- |
| `pnpm run dev:api` | API 与健康检查，默认监听 `127.0.0.1:3000`。 |
| `pnpm run dev:worker` | 认知任务、BullMQ 消费、出箱转发、模拟调度和数据保留期清理。等待日志出现 `ready`。 |
| `pnpm run dev:admin` | Vue 服务状态和人工审批台。开发代理把 `/health` 与 `/v1` 转发到 API。 |

打开[本地控制台](http://localhost:5173/)并检查 [API 就绪状态](http://127.0.0.1:3000/health/ready)。按 Ctrl+C 停止应用进程。`docker compose stop` 停止数据库和 Redis，保留数据卷。

## 2. 启用管理 API 并创建本地账号

1. 应用迁移后，为管理 API 创建一个专用 PostgreSQL 登录，授予 `rica_admin_api`，并把连接串填入 `RICA_MANAGEMENT_DATABASE_URL`。本地 Compose 可用下面的命令进入 psql。`\password` 会交互式设置密码。把连接串中的用户名和密码替换为实际值，对密码中的 URL 特殊字符进行百分号编码。

   ```powershell
   docker compose exec postgres psql -U character -d character
   ```

   ```sql
   CREATE ROLE rica_management_login LOGIN;
   \password rica_management_login
   GRANT rica_admin_api TO rica_management_login WITH INHERIT TRUE, SET TRUE;
   ```

2. 使用 PowerShell 7 初始化本地管理员。密码通过标准输入传递，长度为 12–128 个字符。命令使用迁移数据库登录，`--creator` 允许该账号创建角色。

   ```powershell
   Read-Host -MaskInput 'Rica 管理员密码' | pnpm run admin:user add admin --creator
   ```

3. 确认 `RICA_ADMIN_ORIGIN` 与浏览器地址一致，重启 API，然后在 [本地控制台](http://localhost:5173/) 用用户名和密码登录。登录后可在「添加 Passkey」中确认密码并登记设备。下次可直接点「使用 Passkey」。
4. 需要审批人时，用 `pnpm run admin:user add <username>` 创建其本地账号，然后通过管理 API 授权。[账号恢复](docs/management-api.md#本地账号与会话)

本机开发使用 `http://localhost:5173`。部署时使用固定 HTTPS 地址。浏览器会话存入 HttpOnly Cookie。

## 3. 创建第一个角色

用带 `--creator` 的本地账号运行以下 PowerShell 7 示例。创建请求会返回角色 ID，后续身份、账号和权限操作都使用这个 ID。

```powershell
$ricaOrigin = 'http://localhost:5173'
$ricaApi = "$ricaOrigin/v1"
$ricaPassword = Read-Host -MaskInput 'Rica 管理员密码'
Invoke-RestMethod -Method Post -Uri "$ricaApi/auth/login" -SessionVariable ricaSession -Headers @{
  Origin = $ricaOrigin
} -ContentType 'application/json' -Body (@{ username = 'admin'; password = $ricaPassword } | ConvertTo-Json)
Remove-Variable ricaPassword
$ricaCreateHeaders = @{ Origin = $ricaOrigin; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
$ricaCharacter = Invoke-RestMethod -Method Post -Uri "$ricaApi/characters" -WebSession $ricaSession -Headers $ricaCreateHeaders -ContentType 'application/json' -Body (@{
  slug = 'demo-character'
  timezone = 'Asia/Hong_Kong'
  coreProfile = @{
    name = 'Rica Demo'
    aiDisclosure = '这是一名 AI 虚拟角色。'
  }
} | ConvertTo-Json -Depth 4)
$ricaCharacter.id
```

登录控制台后，在「角色与身份 → 平台账号池」添加账号。体验模拟流程时可选 `mock-a`，实例标识填 `sandbox`，账号标识填 `demo-account`。账号池按角色独立，可以先添加账号再创建身份。到对应身份点「关联账号」，从池里选择一条未关联的账号。关联后的账号初始为暂停，依次恢复角色、身份和账号即可在「运行」发起模拟。

通过管理 API 操作时，可用账号池接口登记和关联，再通过 `/controls` 启用。新角色和新身份初始为暂停。用 `/memberships` 将目标角色的 `REVIEWER` 权限授予审批人的本地用户名。`ADMIN` 与 `REVIEWER` 分别授权。带幂等键的请求在重试同一操作时应复用原键和请求体。[管理 API 接口与权限](docs/management-api.md#已开放的入口)

身份可设置专用写作提示词。在「角色与身份」编辑对应身份，填写「身份提示词」并保存。提示词随身份版本传给回复生成模型。

### 用真实模型试写

在 Worker 的 `.env` 中设置 `RICA_MODEL_PROVIDER`、`RICA_MODEL_NAME` 和对应的 API 密钥，然后重启 `pnpm run dev:worker`。模型 ID 使用供应商为你的账号提供的文本模型 ID。每个 Worker 选择一个模型提供方。

| `RICA_MODEL_PROVIDER` | Worker 环境变量 | 接口 |
| --- | --- | --- |
| `simulated`（默认） | 无 | 本地模板 |
| `openai` | `OPENAI_API_KEY` | OpenAI Chat Completions |
| `anthropic` | `ANTHROPIC_API_KEY` | Claude Messages |
| `gemini` | `GEMINI_API_KEY` | Gemini Developer API 的 `generateContent`，填写不带 `models/` 的模型 ID |
| `openai-compatible` | `RICA_MODEL_API_KEY`、`RICA_MODEL_BASE_URL` | Chat Completions 兼容接口，填写包含 API 版本路径的 HTTPS 基础地址 |

控制台使用 `mock-a` 或 `mock-b` 从「运行 → 发起模拟」输入测试消息。运行详情的草稿阶段显示供应商和配置的模型名。用有 REVIEWER 权限的账号进入「审批 → 模拟提案」看拟回复。兼有运行查看权限的审批员可以从运行详情点「查看模拟提案」。验收人设时，可保存不同版本的身份提示词，再用同一输入各发起一次，直接比较提案正文。

启用真实模型后，公开模拟的写作请求会把模拟输入、身份写作指令和允许公开引用的记忆摘录发送给所选供应商，可能产生 API 费用。是否回复仍在本地判断，私聊模拟仍使用本地模板。生成正文后继续走原有审批。批准后的模拟回执仍写入本地账本。API 密钥只配置在 Worker 环境中。请求失败时在 Worker 日志查找 `model_request_failed`，按脱敏错误码和 HTTP 状态排查。

## 4. 日常使用和管理

| 要做的事 | 入口 |
| --- | --- |
| 查看服务状态和审批提案 | 登录控制台，选择角色，核对身份、账号、目标与正文，再填写理由并批准或拒绝。 |
| 配置角色、身份、账号、成员与记忆共享 | `ADMIN` 使用「角色与身份」「角色成员」和「记忆与授权」。 |
| 查看运行轨迹、审计、额度与队列 | `ADMIN` 或 `AUDITOR` 使用「运行」和「审计」。模拟指标和隔离出箱从「运行」打开。 |
| 运行模拟流程 | 测试夹具提供入站事件和审批数据。已有模拟账号及会话时，也可通过管理 API 建立模拟计划。`READY` 提案由独立的 `pnpm run dev:simulation` 执行并生成本地回执。先配置专用数据库登录和 `RICA_SIMULATION_EXECUTION_DATABASE_URL`。 |

控制台可配置角色、身份和平台账号，管理角色成员、记忆授权和模拟计划，并查询运行、审计与评测。本地登录账号通过 CLI 创建。批准只更新提案状态。独立的模拟执行进程随后生成回执。[管理 API](docs/management-api.md) · [模拟调度](docs/simulation-scheduling.md) · [模拟执行与对账](docs/simulation-execution.md) · [控制台功能规划](docs/console-roadmap.md)

| 现象 | 检查项 |
| --- | --- |
| 管理路由返回 `404` | 检查是否已配置管理数据库连接并重启 API。仅特定资源返回 `404` 时检查其 ID 和角色归属。 |
| 登录或管理请求返回 `401` | 检查密码或 Passkey，或重新登录刷新过期会话。 |
| 返回 `403` 或角色列表为空 | 检查登录主体在 Rica 中是否已加入对应角色，以及是否具备操作所需权限。 |
| 提案停在 `READY` | 检查独立模拟执行进程和静默时段。 |

## 5. 验证与部署

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:integration
```

集成测试使用独立的已迁移 PostgreSQL 和 Redis，运行自带的身份和平台夹具，可以验证审批及回执全链路。请为测试设置专用 `DATABASE_URL` 和 `REDIS_URL`。`pnpm run build` 生成控制台静态文件，位于 `apps/admin/dist`。

版本切换使用新的开发数据库和 Redis 队列，API、Worker 与执行器运行同一版本。分离部署时使用独立的迁移、运行、管理和执行凭据。通过 HTTPS 反向代理提供控制台静态文件，并将同源的 `/v1` 和 `/health` 转发给 API。Compose 中的开发凭据用于本地环境。[数据库角色](docs/database-roles.md) · [数据保留与恢复](docs/management-api.md#模拟数据保留期)

## 代码入口

- `apps/api` 提供管理 API 与健康检查。
- `apps/worker` 提供认知任务、调度和独立模拟执行。
- `apps/admin` 提供服务状态与人工审批界面。
- `packages` 包含共享契约、运行逻辑和持久化实现。
- `prisma` 包含数据模型、授权策略与迁移。

## 开源许可

Rica 采用 GNU Affero General Public License v3.0 only（AGPL-3.0-only）。[完整许可](LICENSE)
