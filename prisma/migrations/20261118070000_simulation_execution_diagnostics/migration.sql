ALTER TYPE public."RunStateReason" ADD VALUE 'APPROVAL_INVALID';
ALTER TYPE public."RunStateReason" ADD VALUE 'ADAPTER_MISMATCH';
ALTER TYPE public."RunStateReason" ADD VALUE 'PAYLOAD_INVALID';
ALTER TYPE public."RunStateReason" ADD VALUE 'PROPOSAL_EXPIRED';
ALTER TYPE public."RunStateReason" ADD VALUE 'MODEL_BUDGET_EXHAUSTED';
ALTER TYPE public."RunStateReason" ADD VALUE 'MODEL_NO_REPLY';
GRANT UPDATE (state_reason) ON public.agent_runs TO rica_simulation_executor;

CREATE FUNCTION public.rica_simulation_execution_wait(target_character uuid, target_action uuid, checking_at timestamptz DEFAULT NULL)
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
  SELECT a.run_id, r.account_id, nullif(a.target->>'contactId','')::uuid AS contact_id, c.timezone, a.expires_at
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
  quiet := public.rica_console_chat_for_run(target_character,candidate.run_id) IS NULL;
  available_at := checked_at;
  IF quiet AND (local_time::time < time '08:00' OR local_time::time >= time '22:00') THEN
    reason := 'QUIET_HOURS';
  END IF;
  IF (SELECT count(*) FROM public.simulation_attempts s WHERE s.account_id = candidate.account_id
    AND s.window_start = date_trunc('day',checked_at,candidate.timezone) AND s.status <> 'NOT_SENT') >= 5 THEN
    reason := 'DAILY_LIMIT';
    daily_reset := (local_time::date + 1)::timestamp AT TIME ZONE candidate.timezone;
    available_at := greatest(available_at,daily_reset);
  END IF;
  IF candidate.contact_id IS NOT NULL THEN
    SELECT max(coalesce(r.created_at,s.permit_until)) + interval '1 hour' INTO cooling_until
    FROM public.simulation_attempts s
    LEFT JOIN public.simulation_receipts r ON (r.character_id,r.action_id) = (s.character_id,s.action_id)
    WHERE (s.account_id,s.contact_id) = (candidate.account_id,candidate.contact_id) AND s.status <> 'NOT_SENT';
    IF cooling_until > checked_at THEN
      reason := coalesce(reason,'CONTACT_COOLDOWN');
      available_at := greatest(available_at,cooling_until);
    END IF;
  END IF;
  IF reason IS NULL THEN RETURN NULL; END IF;
  local_time := available_at AT TIME ZONE candidate.timezone;
  IF quiet AND local_time::time < time '08:00' THEN
    available_at := (local_time::date + time '08:00') AT TIME ZONE candidate.timezone;
  ELSIF quiet AND local_time::time >= time '22:00' THEN
    available_at := (local_time::date + 1 + time '08:00') AT TIME ZONE candidate.timezone;
  END IF;
  RETURN jsonb_build_object('reason',reason,'nextAt',CASE WHEN available_at < candidate.expires_at THEN available_at END);
END
$$;
REVOKE ALL ON FUNCTION public.rica_simulation_execution_wait(uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_execution_wait(uuid,uuid,timestamptz) TO rica_admin_api,rica_simulation_executor;
