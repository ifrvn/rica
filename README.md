# Rica

简体中文 · [English](README.en.md)

Rica 是面向多平台、多身份 AI 虚拟角色的运行系统。设计上，同一个角色可以用公司号、个人号等不同身份活动，保有统一的核心自我。记忆默认按身份隔离，跨身份共享需要授权，发布和互动受账号权限及审批规则约束。

当前已搭建 M0 工程骨架，包括 Hono API、BullMQ Worker、Vue 3 管理端和事务出箱冒烟流程。M1 将用显式注册的模拟平台适配器和模型提供方，串起事件接入、身份绑定、记忆召回、决策、审批与模拟执行。完整路线见 [系统设计规范](docs/多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md)。

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

集成测试需要已迁移的 PostgreSQL 和 Redis。测试插入一条开发用出箱事件，启动 Worker，再检查事件是否经过 BullMQ 消费并写回 PostgreSQL。

## 代码入口

- `apps/api` 提供 Hono 服务与健康检查。
- `apps/worker` 提供 BullMQ 消费进程和最小出箱转发。
- `apps/admin` 提供 Vue 3 服务状态页。
- `packages` 提供跨进程契约、配置与数据库连接。
- `prisma` 包含数据模型与初始迁移。

出箱当前只处理内部冒烟事件。角色认证、身份记忆和审批属于后续实现，平台发送入口随 M1 模拟闭环引入。

## 开源许可

Rica 采用 GNU Affero 通用公共许可证第 3 版（AGPL-3.0-only）。完整许可文本见 [LICENSE](LICENSE)。
