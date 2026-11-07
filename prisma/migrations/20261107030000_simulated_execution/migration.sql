BEGIN;

-- CreateEnum
CREATE TYPE "SimulationAttemptStatus" AS ENUM ('PERMITTED', 'UNKNOWN', 'CONFIRMED', 'NOT_SENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunState" ADD VALUE 'EXECUTING';
ALTER TYPE "RunState" ADD VALUE 'RECONCILING';
ALTER TYPE "RunState" ADD VALUE 'SIMULATED';
ALTER TYPE "RunState" ADD VALUE 'BLOCKED';

-- CreateTable
CREATE TABLE "simulation_attempts" (
    "action_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "SimulationAttemptStatus" NOT NULL DEFAULT 'PERMITTED',
    "window_start" TIMESTAMPTZ NOT NULL,
    "permit_until" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_attempts_pkey" PRIMARY KEY ("action_id")
);

-- CreateTable
CREATE TABLE "simulation_receipts" (
    "action_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_receipts_pkey" PRIMARY KEY ("action_id")
);

-- CreateIndex
CREATE INDEX "simulation_attempts_account_id_window_start_idx" ON "simulation_attempts"("account_id", "window_start");

-- CreateIndex
CREATE INDEX "simulation_attempts_status_permit_until_idx" ON "simulation_attempts"("status", "permit_until");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_attempts_character_id_action_id_key" ON "simulation_attempts"("character_id", "action_id");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_receipts_character_id_action_id_key" ON "simulation_receipts"("character_id", "action_id");

-- AddForeignKey
ALTER TABLE "simulation_attempts" ADD CONSTRAINT "simulation_attempts_character_id_action_id_fkey" FOREIGN KEY ("character_id", "action_id") REFERENCES "action_proposals"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "simulation_receipts" ADD CONSTRAINT "simulation_receipts_character_id_action_id_fkey" FOREIGN KEY ("character_id", "action_id") REFERENCES "simulation_attempts"("character_id", "action_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Execution has separate credentials and never acquires platform or cognition privileges.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rica_simulation_executor') THEN
    CREATE ROLE rica_simulation_executor NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rica_simulation_executor'
    AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Unexpected privileges on Rica simulation executor';
  END IF;
END
$role$;

CREATE UNIQUE INDEX simulation_one_active_attempt_per_account ON public.simulation_attempts (account_id)
  WHERE status IN ('PERMITTED', 'UNKNOWN');

GRANT USAGE ON SCHEMA public TO rica_simulation_executor;
GRANT SELECT ON public.action_proposals, public.action_approvals, public.simulation_attempts,
  public.simulation_receipts TO rica_simulation_executor;
GRANT INSERT ON public.simulation_attempts, public.audit_log TO rica_simulation_executor;
GRANT UPDATE (status) ON public.simulation_attempts TO rica_simulation_executor;
GRANT SELECT (id, character_id, state, state_version, mode, account_id) ON public.agent_runs TO rica_simulation_executor;
GRANT UPDATE (state, state_version) ON public.agent_runs TO rica_simulation_executor;
GRANT SELECT (id) ON public.audit_log TO rica_simulation_executor;

CREATE FUNCTION public.rica_simulation_budget_clock(target_character uuid)
RETURNS TABLE ("windowStart" timestamptz, "localHour" int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  zone text;
  checked_at timestamptz;
BEGIN
  SELECT c.timezone INTO zone FROM public.characters c WHERE c.id = target_character FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  checked_at := clock_timestamp();
  RETURN QUERY SELECT date_trunc('day', checked_at, zone),
    extract(hour FROM checked_at AT TIME ZONE zone)::int;
END
$fn$;

-- A simulator needs proof of authorization, never the draft body.
CREATE FUNCTION public.rica_simulation_payload_allowed(target_character uuid, target_action uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_review_payload(target_character, target_action) IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.action_proposals a
      JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
      JOIN public.core_versions c ON (c.character_id, c.version) = (r.character_id, r.core_version)
      WHERE (a.character_id, a.id) = (target_character, target_action)
        AND jsonb_typeof(c.hard_profile->'aiDisclosure') = 'string'
        AND btrim(c.hard_profile->>'aiDisclosure') <> ''
    )
$fn$;

REVOKE ALL ON FUNCTION public.rica_simulation_budget_clock(uuid),
  public.rica_simulation_payload_allowed(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_budget_clock(uuid),
  public.rica_simulation_payload_allowed(uuid, uuid) TO rica_simulation_executor;

-- The local adapter cannot insert a receipt without a current permit. Binding is checked again
-- immediately before the local side effect, without returning plaintext or platform credentials.
CREATE FUNCTION public.rica_record_simulation_receipt(target_action uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  PERFORM 1 FROM public.characters c
  JOIN public.simulation_attempts s ON s.character_id = c.id
  WHERE s.action_id = target_action FOR SHARE OF c;

  INSERT INTO public.simulation_receipts (character_id, action_id)
  SELECT s.character_id, s.action_id
  FROM public.simulation_attempts s
  JOIN public.action_proposals a ON (a.character_id, a.id) = (s.character_id, s.action_id)
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  WHERE s.action_id = target_action AND s.status = 'PERMITTED' AND s.permit_until > clock_timestamp()
    AND r.mode = 'SIMULATION' AND r.state::text = 'EXECUTING'
    AND a.target = public.rica_simulated_review_target(r.id)
  FOR SHARE OF s
  ON CONFLICT (action_id) DO NOTHING;

  RETURN EXISTS (SELECT 1 FROM public.simulation_receipts WHERE action_id = target_action);
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_record_simulation_receipt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_record_simulation_receipt(uuid) TO rica_simulation_executor;
COMMIT;
