# Rica

[简体中文](README.md) · English

Rica is a runtime for AI characters that operate across platforms and social identities. One character can act through a company account, a personal account, or another persona while keeping a unified core self. Memory is isolated by identity by default. Sharing across identities requires authorization, and account permissions and approval rules govern posting and interactions.

Rica has passed M1–M4 simulation acceptance. It covers ingestion on two simulated platforms, identity-scoped retrieval, human approval, simulated receipts and reconciliation, daily reflection, belief evolution, autonomous goals, and longitudinal evaluation. Live platforms have a separate pilot acceptance process. See the [roadmap (Chinese)](docs/roadmap.md) and [design specification (Chinese)](docs/多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md).

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

Integration tests require dedicated Redis and migrated PostgreSQL instances. They cover authorization and isolation, approval and execution, scheduling, longitudinal simulation, and BullMQ outbox recovery.

## Project structure

- `apps/api` contains the Hono management API and health checks.
- `apps/worker` contains BullMQ consumers, the outbox relay, scheduling, and the separate simulation executor.
- `apps/admin` contains the Vue 3 service status and human review interfaces.
- `packages` contains shared contracts, configuration, and database connectivity.
- `prisma` contains the data model, authorization policies, and versioned migrations.

For the dedicated credentials required to review proposals and record simulated receipts, see the [management API](docs/management-api.md) and [simulation executor](docs/simulation-execution.md) guides.

## License

Rica is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See [LICENSE](LICENSE) for the full text.
