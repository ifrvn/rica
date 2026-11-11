BEGIN;

CREATE TABLE public.simulation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 72),
  zone text NOT NULL,
  kind public."ScheduleKind" NOT NULL,
  local_time text,
  due_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'AI')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT simulation_plan_timing CHECK (
    (kind = 'DAILY' AND local_time IS NOT NULL AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND due_at IS NULL)
    OR (kind = 'REMINDER' AND local_time IS NULL AND due_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX simulation_plans_character_id_id_key ON public.simulation_plans (character_id, id);
CREATE INDEX simulation_plans_character_id_created_at_id_idx ON public.simulation_plans (character_id, created_at, id);
CREATE UNIQUE INDEX simulation_schedules_scope_key ON public.simulation_schedules (character_id, identity_id, account_id, id);

CREATE TABLE public.simulation_plan_participants (
  plan_id uuid NOT NULL,
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  account_id uuid NOT NULL,
  schedule_id uuid,
  task text NOT NULL CHECK (char_length(btrim(task)) BETWEEN 1 AND 300),
  included boolean NOT NULL DEFAULT true,
  PRIMARY KEY (plan_id, account_id),
  FOREIGN KEY (character_id, plan_id) REFERENCES public.simulation_plans(character_id, id) ON DELETE RESTRICT,
  CONSTRAINT simulation_plan_participants_character_id_identity_id_acco_fkey
    FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT,
  CONSTRAINT simulation_plan_participants_schedule_fkey
    FOREIGN KEY (character_id, identity_id, account_id, schedule_id)
    REFERENCES public.simulation_schedules(character_id, identity_id, account_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX simulation_plan_participants_schedule_key
  ON public.simulation_plan_participants (character_id, identity_id, account_id, schedule_id);
CREATE UNIQUE INDEX simulation_plan_participants_included_identity
  ON public.simulation_plan_participants (plan_id, identity_id) WHERE included;

GRANT SELECT, INSERT ON public.simulation_plans, public.simulation_plan_participants TO rica_admin_api;
GRANT UPDATE (title, zone, kind, local_time, due_at, enabled, version) ON public.simulation_plans TO rica_admin_api;
GRANT UPDATE (task, included) ON public.simulation_plan_participants TO rica_admin_api;

CREATE FUNCTION public.rica_create_plan_conversation(target_character uuid, target_identity uuid, target_account uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  INSERT INTO public.conversations (character_id, identity_id, account_id, remote_key, channel)
  SELECT character_id, identity_id, id, 'plan:' || gen_random_uuid(), 'PUBLIC'
  FROM public.platform_accounts
  WHERE (character_id, identity_id, id) = (target_character, target_identity, target_account)
    AND platform IN ('mock-a', 'mock-b') AND status <> 'REVOKED'
  RETURNING id
$fn$;

CREATE FUNCTION public.rica_latest_plan_runs(target_character uuid, target_plans uuid[])
RETURNS TABLE ("scheduleId" uuid, "runId" uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT participant.schedule_id, latest.run_id
  FROM public.simulation_plan_participants participant
  CROSS JOIN LATERAL (
    SELECT occurrence.run_id FROM public.schedule_occurrences occurrence
    WHERE (occurrence.character_id, occurrence.schedule_id) = (participant.character_id, participant.schedule_id)
    ORDER BY occurrence.scheduled_at DESC LIMIT 1
  ) latest
  WHERE participant.character_id = target_character AND participant.plan_id = ANY(target_plans) AND participant.included
$fn$;

REVOKE ALL ON FUNCTION public.rica_create_plan_conversation(uuid, uuid, uuid), public.rica_latest_plan_runs(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_create_plan_conversation(uuid, uuid, uuid), public.rica_latest_plan_runs(uuid, uuid[]) TO rica_admin_api;

COMMIT;
