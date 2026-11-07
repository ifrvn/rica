BEGIN;

CREATE TABLE public.model_daily_usage (
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  utc_day date NOT NULL,
  reserved_units int NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  calls int NOT NULL DEFAULT 0 CHECK (calls >= 0),
  denied int NOT NULL DEFAULT 0 CHECK (denied >= 0),
  PRIMARY KEY (character_id,utc_day)
);

CREATE INDEX simulation_receipts_character_id_created_at_idx ON public.simulation_receipts(character_id,created_at);

CREATE FUNCTION public.rica_reserve_model_budget(target_run uuid,units int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  target_character uuid;
  ceiling int;
  today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF units IS NULL OR units NOT BETWEEN 1 AND 1000000 THEN RETURN false; END IF;
  SELECT r.character_id,COALESCE((c.hard_profile->>'dailyModelBudget')::int,10000000)
  INTO target_character,ceiling
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id,c.version) = (r.character_id,r.core_version)
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
$fn$;

CREATE FUNCTION public.rica_simulation_daily_metrics(target_character uuid,first_day date,last_day date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH bounds AS (
    SELECT first_day::timestamp AT TIME ZONE 'UTC' AS starts,(last_day+1)::timestamp AT TIME ZONE 'UTC' AS ends
    WHERE last_day-first_day BETWEEN 0 AND 30
  ), proposals AS (
    SELECT (p.created_at AT TIME ZONE 'UTC')::date AS day,count(*) AS proposed,
      count(*) FILTER (WHERE a.decision = 'APPROVE') AS approved,
      count(*) FILTER (WHERE a.decision = 'REJECT') AS rejected,
      count(*) FILTER (WHERE p.cross_platform_duplicate) AS flagged,
      round(avg(greatest(0,extract(epoch FROM p.created_at-r.created_at)*1000))) AS draft_latency
    FROM bounds b JOIN public.action_proposals p ON p.created_at >= b.starts AND p.created_at < b.ends
    JOIN public.agent_runs r ON (r.character_id,r.id) = (p.character_id,p.run_id) AND r.mode = 'SIMULATION'
    LEFT JOIN public.action_approvals a ON (a.character_id,a.action_id) = (p.character_id,p.id)
    WHERE p.character_id = target_character
    GROUP BY 1
  ), account_receipts AS (
    SELECT (rc.created_at AT TIME ZONE 'UTC')::date AS day,s.account_id,count(*) AS receipts,
      count(*) FILTER (WHERE p.cross_platform_duplicate) AS flagged,
      count(*) FILTER (WHERE a.decision IS DISTINCT FROM 'APPROVE') AS without_approval
    FROM bounds b JOIN public.simulation_receipts rc ON rc.created_at >= b.starts AND rc.created_at < b.ends
    JOIN public.simulation_attempts s ON (s.character_id,s.action_id) = (rc.character_id,rc.action_id)
    JOIN public.action_proposals p ON (p.character_id,p.id) = (s.character_id,s.action_id)
    LEFT JOIN public.action_approvals a ON (a.character_id,a.action_id) = (p.character_id,p.id)
    WHERE rc.character_id = target_character
    GROUP BY 1,2
  ), receipts AS (
    SELECT day,sum(receipts) AS receipts,max(receipts) AS peak_account_receipts,sum(flagged) AS flagged,
      sum(without_approval) AS without_approval FROM account_receipts GROUP BY day
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('utcDay',d.day,
    'proposals',COALESCE(p.proposed,0),'approvals',COALESCE(p.approved,0),'rejections',COALESCE(p.rejected,0),
    'duplicateFlags',COALESCE(p.flagged,0),'draftLatencyMs',p.draft_latency,
    'receipts',COALESCE(r.receipts,0),'peakAccountReceipts',COALESCE(r.peak_account_receipts,0),
    'flaggedReceipts',COALESCE(r.flagged,0),'receiptsWithoutApproval',COALESCE(r.without_approval,0),
    'reservedUnits',COALESCE(u.reserved_units,0),'modelCalls',COALESCE(u.calls,0),'budgetDenials',COALESCE(u.denied,0)
  ) ORDER BY d.day),'[]'::jsonb)
  FROM bounds CROSS JOIN LATERAL generate_series(0,last_day-first_day) AS n
  CROSS JOIN LATERAL (SELECT first_day+n AS day) d
  LEFT JOIN proposals p ON p.day = d.day LEFT JOIN receipts r ON r.day = d.day
  LEFT JOIN public.model_daily_usage u ON (u.character_id,u.utc_day) = (target_character,d.day)
$fn$;

REVOKE ALL ON FUNCTION public.rica_reserve_model_budget(uuid,int),
  public.rica_simulation_daily_metrics(uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_reserve_model_budget(uuid,int) TO rica_runtime;
GRANT EXECUTE ON FUNCTION public.rica_simulation_daily_metrics(uuid,date,date) TO rica_admin_api;

COMMIT;
