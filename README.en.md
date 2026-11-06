# Rica

[简体中文](README.md) · English

Rica is a runtime for AI characters that operate across platforms and social identities. One character can act through a company account, a personal account, or another persona while keeping a unified core self. Memory is isolated by identity by default. Sharing across identities requires authorization, and account permissions and approval rules govern posting and interactions.

The M0 foundation includes a Hono API, a BullMQ worker, a Vue 3 admin UI, and a transactional outbox smoke test. M1 will use explicitly registered simulated platform adapters and model providers to connect event ingestion, identity binding, memory retrieval, decision-making, approval, and simulated execution. See the [system design specification (Chinese)](docs/多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md) for the full roadmap.

## Getting started

Use Node.js 22.12 or later in the 22.x line, Node.js 24, or Node.js 26. You also need the pnpm version specified in `package.json` and Docker Compose.

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm run db:generate
pnpm run db:migrate
```

Run each command in a separate terminal.

```powershell
pnpm run dev:api
pnpm run dev:worker
pnpm run dev:admin
```

Open the admin UI at [http://127.0.0.1:5173](http://127.0.0.1:5173). The admin development server proxies `/health` to local port 3000. The [OpenAPI specification](docs/openapi.yaml) documents `/health/live` and `/health/ready`.

## Verification

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:integration
```

Type checking uses TypeScript 7's `tsc` for the API, worker, and shared TypeScript code. It then uses `vue-tsc` with the TypeScript 6 compatibility package to check Vue single-file components and templates.

The integration test requires Redis and a PostgreSQL database with migrations applied. It inserts a test outbox event, starts the worker, and checks that BullMQ processes the event and the worker records the result in PostgreSQL.

## Project structure

- `apps/api` contains the Hono service and health checks.
- `apps/worker` contains the BullMQ worker and the initial outbox relay.
- `apps/admin` contains the Vue 3 service status page.
- `packages` contains shared contracts, configuration, and database connectivity.
- `prisma` contains the data model and initial migration.

The outbox currently handles internal smoke-test events. Authentication, identity-scoped memory, and approvals are planned. The platform delivery path will be introduced as part of the M1 simulation.

## License

Rica is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See [LICENSE](LICENSE) for the full text.
