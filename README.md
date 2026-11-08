# Rica

简体中文 · [English](README.en.md)

Rica 是面向多平台、多身份 AI 虚拟角色的运行系统。设计上，同一个角色可以用公司号、个人号等不同身份活动，保有统一的核心自我。记忆默认按身份隔离，跨身份共享需要授权，发布和互动受账号权限及审批规则约束。

Rica 已通过 M1–M4 模拟验收，覆盖双模拟平台入站、隔离检索、人工审批、模拟回执与对账，以及每日反思、观点演化、自主目标和长期评测。真实平台按独立试点验收。详见[开发路线图](docs/roadmap.md)和[系统设计规范](docs/多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md)。

## 本地启动

需要 Node.js 22.12+、24 或 26，以及 `package.json` 指定版本的 pnpm 和 Docker Compose。

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm run db:generate
pnpm run db:migrate
```

分别在三个终端运行：

```powershell
pnpm run dev:api
pnpm run dev:worker
pnpm run dev:admin
```

管理端地址为 http://127.0.0.1:5173。API 的 /health/live 和 /health/ready 见 [接口定义](docs/openapi.yaml)。开发管理端把 /health 转发到本地 3000 端口。

## 验证

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:integration
```

类型检查先用 TypeScript 7 的 `tsc` 检查 API、Worker 和共享 TypeScript 源码，再用 `vue-tsc` 和 TypeScript 6 兼容包检查 Vue 单文件组件及模板。

集成测试需要专用的已迁移 PostgreSQL 和 Redis，覆盖权限隔离、审批执行、调度、长期模拟评测与 BullMQ 出箱恢复。

## 代码入口

- `apps/api` 提供 Hono 管理 API 与健康检查。
- `apps/worker` 提供 BullMQ 消费、出箱转发、调度与独立模拟执行。
- `apps/admin` 提供 Vue 3 服务状态与人工审批界面。
- `packages` 提供跨进程契约、配置与数据库连接。
- `prisma` 包含数据模型、授权策略与版本化迁移。

配置审批和模拟回执所需的独立凭据见[管理 API](docs/management-api.md)和[模拟执行进程](docs/simulation-execution.md)。

## 开源许可

Rica 采用 GNU Affero 通用公共许可证第 3 版（AGPL-3.0-only）。完整许可文本见 [LICENSE](LICENSE)。
