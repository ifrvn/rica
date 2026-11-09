# Rica

[简体中文](README.md) · English

Rica is a runtime for AI characters that operate across platforms and social identities. A character can act through a company account, a personal account, or another persona while keeping a unified core self. Memory is isolated by identity by default. Cross-identity sharing requires authorization, and account permissions and approval rules govern platform actions.

Rica has passed M1–M4 simulation acceptance for ingestion, memory retrieval, human review, simulated receipts, scheduling, reflection, belief evolution, and autonomous goals. [Roadmap (Chinese)](docs/roadmap.md) · [Design specification (Chinese)](docs/多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md)

## 1. Install and start Rica

Use Node.js 22.12 or later in the 22.x line, Node.js 24, or Node.js 26. You also need the **pnpm** version pinned in `package.json` and Docker with Compose. These examples use PowerShell. After cloning, run the remaining commands from the repository root. The commands preserve an existing `.env` file.

Before initialization, point the database connection at an empty development database and use a dedicated Redis queue.

```powershell
git clone https://github.com/ifrvn/rica.git
Set-Location rica
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm run db:generate
pnpm run db:migrate
```

Compose starts PostgreSQL 18 and Redis 8 on local ports `55432` and `56379`. The example `DATABASE_URL` and `REDIS_URL` match those ports. Migrations use `MIGRATION_DATABASE_URL` when set and otherwise use `DATABASE_URL`. [Example environment](.env.example) · [Database roles (Chinese)](docs/database-roles.md)

Start each process in a separate terminal.

| Command | Purpose |
| --- | --- |
| `pnpm run dev:api` | API and health checks on `127.0.0.1:3000` by default. |
| `pnpm run dev:worker` | Cognition jobs, BullMQ consumers, the outbox relay, simulation schedules, and retention cleanup. Wait for the `ready` log event. |
| `pnpm run dev:admin` | Vue service status and human review. The development server proxies `/health` and `/v1` to the API. |

Open the [local console](http://localhost:5173/) and check [API readiness](http://127.0.0.1:3000/health/ready). Press Ctrl+C to stop the application processes. Use `docker compose stop` to stop the database and Redis while keeping their volumes.

## 2. Enable the management API and create a local account

1. After applying migrations, create a dedicated PostgreSQL login, grant it `rica_admin_api`, and set its connection URL in `RICA_MANAGEMENT_DATABASE_URL`. Use the following command to open psql in the local Compose database. `\password` prompts for a password. Use the resulting username and password in the connection URL, with percent encoding for special characters in the password.

   ```powershell
   docker compose exec postgres psql -U character -d character
   ```

   ```sql
   CREATE ROLE rica_management_login LOGIN;
   \password rica_management_login
   GRANT rica_admin_api TO rica_management_login WITH INHERIT TRUE, SET TRUE;
   ```

2. Use PowerShell 7 to create the initial local administrator. The command reads a 12–128 character password from stdin and uses the migration database login. `--creator` allows this account to create characters.

   ```powershell
   Read-Host -MaskInput 'Rica administrator password' | pnpm run admin:user add admin --creator
   ```

3. Set `RICA_ADMIN_ORIGIN` to the browser's address and restart the API. Sign in to the [local console](http://localhost:5173/) with your username and password. Open the Passkey section and confirm your password to register a device. Next time, use the Passkey sign-in button.
4. Create local reviewer accounts with `pnpm run admin:user add <username>`, then grant their roles through the management API. [Account recovery (Chinese)](docs/management-api.md#本地账号与会话)

Local development uses `http://localhost:5173`. Use a stable HTTPS origin for deployments. The browser stores its session in an HttpOnly cookie.

## 3. Create your first character

Run this PowerShell 7 example with the local account created using `--creator`. The response includes the character ID you will use for identities, accounts, and membership.

```powershell
$ricaOrigin = 'http://localhost:5173'
$ricaApi = "$ricaOrigin/v1"
$ricaPassword = Read-Host -MaskInput 'Rica administrator password'
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
    aiDisclosure = 'This is an AI character.'
  }
} | ConvertTo-Json -Depth 4)
$ricaCharacter.id
```

In the console, open **Character and identities → Platform account pool** and add an account. To try a simulation, select `mock-a`, enter `sandbox` for the instance and `demo-account` for the account identifier. Each character has its own pool. You can add an account before creating any identities. On the identity you want to use, choose **Associate account** and select an available account. Resume the character, the identity, and the newly associated account in that order before starting a simulation from **Runs**.

The management API also offers separate pool registration and association endpoints. Use `/controls` to enable the resources. New characters and identities start paused. Use `/memberships` to grant the character's `REVIEWER` role to the reviewer's local username. Rica grants `ADMIN` and `REVIEWER` independently. When retrying the same idempotent request, reuse its key and body. [Management API endpoints and permissions (Chinese)](docs/management-api.md#已开放的入口)

To set an identity's writing prompt, open that identity in **Character and identities** and fill in **Identity prompt**. The writing model receives the prompt from the identity version used for the run. The built-in simulation model uses template replies.

## 4. Daily use and management

| Task | Where to do it |
| --- | --- |
| Check service status and review proposals | Sign in to the console and select a character, check the identity, account, destination, and content, then enter a reason and approve or reject. |
| Manage characters, identities, accounts, members, and memory sharing | An `ADMIN` can configure resources, pause or resume bindings, and grant or revoke member permissions in the console. |
| Inspect runs, audit records, budgets, and queue health | Open Runs or Audit as an `ADMIN` or `AUDITOR`. Runs links to simulation metrics and quarantined outbox events. |
| Run a simulation | The test fixtures supply inbound events and approval data. With a simulated account and conversation already configured, you can also create simulation schedules through the API. The separate `pnpm run dev:simulation` process records local receipts for `READY` proposals. Configure its dedicated database login and `RICA_SIMULATION_EXECUTION_DATABASE_URL` first. |

The console supports character, identity, and account setup, role membership, memory grants, simulation schedules, run history, audit records, and evaluation metrics. Create local sign-in accounts with the CLI. Approval updates the proposal state. The separate simulation executor then records a receipt. [Management API](docs/management-api.md) · [Simulation scheduling](docs/simulation-scheduling.md) · [Simulation execution and reconciliation](docs/simulation-execution.md) (Chinese)

| Symptom | What to check |
| --- | --- |
| Management routes return `404` | Check the management database URL and restart the API. If only a particular resource returns `404`, check its ID and character scope. |
| Sign-in or management requests return `401` | Check your password or Passkey, or sign in again if the session expired. |
| You see `403` or an empty character list | Check the signed-in subject's character membership and the role required by the operation. |
| A proposal remains `READY` | Check the separate simulation executor and quiet hours. |

## 5. Verify and deploy

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:integration
```

Integration tests use their own identity and platform fixtures to verify the approval and receipt flow. Point `DATABASE_URL` and `REDIS_URL` at dedicated test services and apply migrations before running them. `pnpm run build` writes the console's static files to `apps/admin/dist`.

Use a fresh development database and Redis queue when switching versions. Run the API, worker, and executor from the same version. In a split deployment, give migration, runtime, management, and executor processes separate credentials. Serve the console through an HTTPS reverse proxy that forwards same-origin `/v1` and `/health` requests to the API. The Compose credentials are for local development. [Database roles (Chinese)](docs/database-roles.md) · [Retention and recovery (Chinese)](docs/management-api.md#模拟数据保留期)

## Project structure

- `apps/api` contains the management API and health checks.
- `apps/worker` contains cognition jobs, schedules, and the separate simulation executor.
- `apps/admin` contains the service status and human review interfaces.
- `packages` contains shared contracts, runtime logic, and persistence.
- `prisma` contains the data model, authorization policies, and migrations.

## License

Rica is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). [Full license](LICENSE)
