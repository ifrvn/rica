ALTER TABLE public.characters
  ADD COLUMN simulation_limits_version integer NOT NULL DEFAULT 0,
  ADD COLUMN simulation_daily_limit integer NOT NULL DEFAULT 5,
  ADD COLUMN simulation_cooldown_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN simulation_quiet_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN simulation_quiet_from varchar(5) NOT NULL DEFAULT '22:00',
  ADD COLUMN simulation_quiet_until varchar(5) NOT NULL DEFAULT '08:00',
  ADD COLUMN simulation_quiet_for_chat boolean NOT NULL DEFAULT false,
  ADD COLUMN simulation_catch_up_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN simulation_proposal_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN simulation_model_budget integer,
  ADD CONSTRAINT characters_simulation_limits_check CHECK (
    simulation_limits_version >= 0 AND simulation_daily_limit BETWEEN 0 AND 10000
    AND simulation_cooldown_minutes BETWEEN 0 AND 1440
    AND simulation_quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND simulation_quiet_until ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND simulation_quiet_from <> simulation_quiet_until
    AND simulation_catch_up_minutes BETWEEN 1 AND 1440
    AND simulation_proposal_hours BETWEEN 1 AND 168
    AND simulation_model_budget BETWEEN 1024 AND 100000000
  );

GRANT UPDATE (simulation_limits_version, simulation_daily_limit, simulation_cooldown_minutes,
  simulation_quiet_enabled, simulation_quiet_from, simulation_quiet_until, simulation_quiet_for_chat,
  simulation_catch_up_minutes, simulation_proposal_hours, simulation_model_budget)
  ON public.characters TO rica_admin_api;

CREATE FUNCTION public.rica_simulation_next_open(checked_at timestamptz, zone_name text, quiet_from time, quiet_until time)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT CASE
    WHEN quiet_from < quiet_until AND local_time::time >= quiet_from AND local_time::time < quiet_until
      THEN (local_time::date + quiet_until) AT TIME ZONE zone_name
    WHEN quiet_from > quiet_until AND local_time::time >= quiet_from
      THEN (local_time::date + 1 + quiet_until) AT TIME ZONE zone_name
    WHEN quiet_from > quiet_until AND local_time::time < quiet_until
      THEN (local_time::date + quiet_until) AT TIME ZONE zone_name
    ELSE checked_at
  END
  FROM (SELECT checked_at AT TIME ZONE zone_name AS local_time) wall
$$;
REVOKE ALL ON FUNCTION public.rica_simulation_next_open(timestamptz,text,time,time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_next_open(timestamptz,text,time,time) TO rica_runtime;

CREATE OR REPLACE FUNCTION public.rica_simulation_execution_wait(target_character uuid, target_action uuid, checking_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
DECLARE
  candidate record;
  checked_at timestamptz := coalesce(checking_at,clock_timestamp());
  local_time timestamp;
  quiet boolean;
  daily_reset timestamptz;
  cooling_until timestamptz;
  available_at timestamptz;
  reason text;
BEGIN
  SELECT a.run_id, r.account_id, nullif(a.target->>'contactId','')::uuid AS contact_id, c.timezone, a.expires_at,
    c.simulation_daily_limit, c.simulation_cooldown_minutes, c.simulation_quiet_enabled,
    c.simulation_quiet_from::time AS quiet_from, c.simulation_quiet_until::time AS quiet_until,
    c.simulation_quiet_for_chat
  INTO candidate
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id,r.id) = (a.character_id,a.run_id)
  JOIN public.characters c ON c.id = r.character_id
  WHERE (a.character_id,a.id) = (target_character,target_action) AND r.state = 'READY' AND r.mode = 'SIMULATION';
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF candidate.expires_at <= checked_at THEN
    RETURN jsonb_build_object('reason','PROPOSAL_EXPIRED','nextAt',NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM public.simulation_attempts s WHERE s.account_id = candidate.account_id AND s.status = 'UNKNOWN') THEN
    RETURN jsonb_build_object('reason','ACCOUNT_RECONCILING','nextAt',NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM public.simulation_attempts s WHERE s.account_id = candidate.account_id AND s.status = 'PERMITTED') THEN
    RETURN jsonb_build_object('reason','ACCOUNT_BUSY','nextAt',NULL);
  END IF;

  local_time := checked_at AT TIME ZONE candidate.timezone;
  quiet := candidate.simulation_quiet_enabled AND (candidate.simulation_quiet_for_chat
    OR public.rica_console_chat_for_run(target_character,candidate.run_id) IS NULL);
  available_at := checked_at;
  IF quiet AND public.rica_simulation_next_open(
    checked_at,candidate.timezone,candidate.quiet_from,candidate.quiet_until) > checked_at THEN
    reason := 'QUIET_HOURS';
  END IF;
  IF candidate.simulation_daily_limit > 0 AND (SELECT count(*) FROM public.simulation_attempts s WHERE s.account_id = candidate.account_id
    AND s.window_start = date_trunc('day',checked_at,candidate.timezone) AND s.status <> 'NOT_SENT') >= candidate.simulation_daily_limit THEN
    reason := 'DAILY_LIMIT';
    daily_reset := (local_time::date + 1)::timestamp AT TIME ZONE candidate.timezone;
    available_at := greatest(available_at,daily_reset);
  END IF;
  IF candidate.contact_id IS NOT NULL AND candidate.simulation_cooldown_minutes > 0 THEN
    SELECT max(coalesce(r.created_at,s.permit_until)) + make_interval(mins => candidate.simulation_cooldown_minutes) INTO cooling_until
    FROM public.simulation_attempts s
    LEFT JOIN public.simulation_receipts r ON (r.character_id,r.action_id) = (s.character_id,s.action_id)
    WHERE (s.account_id,s.contact_id) = (candidate.account_id,candidate.contact_id) AND s.status <> 'NOT_SENT';
    IF cooling_until > checked_at THEN
      reason := coalesce(reason,'CONTACT_COOLDOWN');
      available_at := greatest(available_at,cooling_until);
    END IF;
  END IF;
  IF reason IS NULL THEN RETURN NULL; END IF;
  IF quiet THEN
    available_at := public.rica_simulation_next_open(
      available_at,candidate.timezone,candidate.quiet_from,candidate.quiet_until);
  END IF;
  RETURN jsonb_build_object('reason',reason,'nextAt',CASE WHEN available_at < candidate.expires_at THEN available_at END);
END
$$;

CREATE OR REPLACE FUNCTION public.rica_reserve_model_budget(target_run uuid, units integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  target_character uuid;
  ceiling int;
  today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF units IS NULL OR units NOT BETWEEN 1 AND 1000000 THEN RETURN false; END IF;
  SELECT r.character_id,COALESCE(
    CASE WHEN r.mode = 'SIMULATION' THEN p.simulation_model_budget END,
    (c.hard_profile->>'dailyModelBudget')::int,10000000)
  INTO target_character,ceiling
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id,c.version) = (r.character_id,r.core_version)
  JOIN public.characters p ON p.id = r.character_id
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND public.rica_run_identity_state(r.id) IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Only the per-character daily counter is write-locked. The caller already holds the run binding locks.
  INSERT INTO public.model_daily_usage (character_id,utc_day) VALUES (target_character,today) ON CONFLICT DO NOTHING;
  UPDATE public.model_daily_usage SET reserved_units = reserved_units+units,calls = calls+1
    WHERE (character_id,utc_day) = (target_character,today) AND reserved_units <= ceiling-units;
  IF FOUND THEN RETURN true; END IF;
  UPDATE public.model_daily_usage SET denied = denied+1 WHERE (character_id,utc_day) = (target_character,today);
  RETURN false;
END
$$;
