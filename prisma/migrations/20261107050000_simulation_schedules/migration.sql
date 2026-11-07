BEGIN;

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('DAILY', 'REMINDER');

-- AlterEnum
ALTER TYPE "RunStateReason" ADD VALUE 'SCHEDULE_CHANGED';

-- CreateTable
CREATE TABLE "simulation_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "contact_id" UUID,
    "schedule_key" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "kind" "ScheduleKind" NOT NULL,
    "local_time" TEXT,
    "due_at" TIMESTAMPTZ,
    "next_at" TIMESTAMPTZ,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_occurrences" (
    "schedule_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "schedule_version" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,

    CONSTRAINT "schedule_occurrences_pkey" PRIMARY KEY ("schedule_id","scheduled_at")
);

-- CreateIndex
CREATE INDEX "simulation_schedules_enabled_next_at_id_idx" ON "simulation_schedules"("enabled", "next_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_schedules_character_id_id_key" ON "simulation_schedules"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_schedules_character_id_schedule_key_key" ON "simulation_schedules"("character_id", "schedule_key");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_occurrences_character_id_run_id_key" ON "schedule_occurrences"("character_id", "run_id");

-- AddForeignKey
ALTER TABLE "simulation_schedules" ADD CONSTRAINT "simulation_schedules_conversation_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "conversation_id") REFERENCES "conversations"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "simulation_schedules" ADD CONSTRAINT "simulation_schedules_contact_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "contact_id") REFERENCES "contacts"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_character_id_schedule_id_fkey" FOREIGN KEY ("character_id", "schedule_id") REFERENCES "simulation_schedules"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_character_id_run_id_fkey" FOREIGN KEY ("character_id", "run_id") REFERENCES "agent_runs"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.simulation_schedules ADD CONSTRAINT simulation_schedule_shape CHECK (
  version > 0 AND (
    (kind = 'DAILY' AND local_time IS NOT NULL AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND due_at IS NULL)
    OR (kind = 'REMINDER' AND due_at IS NOT NULL AND local_time IS NULL)
  ) AND (enabled OR next_at IS NULL)
);

-- Round-trip candidate offsets on either side of a clock change.
-- A missing wall time has no match; an overlap uses the earlier instant.
CREATE FUNCTION public.rica_daily_schedule_slot(zone_name text, wall_time time, reference_at timestamptz, backwards boolean)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  WITH days AS (
    SELECT (reference_at AT TIME ZONE zone_name)::date + n + wall_time AS nominal
    FROM generate_series(-3, 3) AS g(n)
  ), resolved AS (
    SELECT (
      SELECT min(candidate)
      FROM generate_series(-36, 36, 6) AS g(hours)
      CROSS JOIN LATERAL (SELECT (nominal AT TIME ZONE 'UTC') + make_interval(hours => g.hours) AS instant) p
      CROSS JOIN LATERAL (
        SELECT (nominal - ((p.instant AT TIME ZONE zone_name) - (p.instant AT TIME ZONE 'UTC')))
          AT TIME ZONE 'UTC' AS candidate
      ) matching
      WHERE candidate AT TIME ZONE zone_name = nominal
    ) AS slot
    FROM days
  )
  SELECT CASE WHEN backwards THEN max(slot) FILTER (WHERE slot <= reference_at)
    ELSE min(slot) FILTER (WHERE slot > reference_at) END
  FROM resolved
$fn$;

REVOKE ALL ON FUNCTION public.rica_daily_schedule_slot(text, time, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_daily_schedule_slot(text, time, timestamptz, boolean) TO rica_runtime, rica_admin_api;
GRANT SELECT ON public.simulation_schedules, public.schedule_occurrences TO rica_runtime;
GRANT INSERT ON public.schedule_occurrences TO rica_runtime;
GRANT UPDATE (next_at) ON public.simulation_schedules TO rica_runtime;
GRANT SELECT, INSERT ON public.simulation_schedules TO rica_admin_api;
GRANT UPDATE (zone, kind, local_time, due_at, next_at, enabled, version) ON public.simulation_schedules TO rica_admin_api;

-- Management already holds the character lock shared with cognition and permit issuance.
CREATE FUNCTION public.rica_cancel_previous_schedule_runs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  WITH canceled AS (
    UPDATE public.agent_runs r SET state = 'CANCELED', state_reason = 'SCHEDULE_CHANGED', state_version = r.state_version + 1
    FROM public.schedule_occurrences o
    WHERE o.schedule_id = NEW.id AND o.schedule_version <> NEW.version
      AND (r.character_id, r.id) = (o.character_id, o.run_id)
      AND r.state IN ('QUEUED', 'CONTEXT_READY', 'DRAFTED', 'WAITING_APPROVAL', 'READY')
    RETURNING r.id
  )
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  SELECT NEW.character_id, 'simulation-scheduler', 'schedule.invalidate', id, gen_random_uuid(),
    encode(sha256(convert_to(NEW.id::text || ':' || NEW.version::text, 'UTF8')), 'hex')
  FROM canceled;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_cancel_previous_schedule_runs() FROM PUBLIC;
CREATE TRIGGER schedules_cancel_previous_runs AFTER UPDATE OF version ON public.simulation_schedules
FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version)
EXECUTE FUNCTION public.rica_cancel_previous_schedule_runs();
CREATE FUNCTION public.rica_audit_schedule_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  VALUES (NEW.character_id, 'simulation-scheduler', 'schedule.fire', NEW.run_id, gen_random_uuid(),
    encode(sha256(convert_to(NEW.schedule_id::text || ':' || NEW.schedule_version::text || ':'
      || extract(epoch FROM NEW.scheduled_at)::text, 'UTF8')), 'hex'));
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_audit_schedule_occurrence() FROM PUBLIC;
CREATE TRIGGER schedule_occurrences_audit AFTER INSERT ON public.schedule_occurrences
FOR EACH ROW EXECUTE FUNCTION public.rica_audit_schedule_occurrence();

COMMIT;
