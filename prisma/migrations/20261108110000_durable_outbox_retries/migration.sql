BEGIN;

ALTER TABLE public.outbox
  ADD COLUMN generation int NOT NULL DEFAULT 0 CHECK (generation >= 0),
  ADD COLUMN attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  ADD COLUMN attempt_until timestamptz,
  ADD COLUMN quarantined_at timestamptz,
  ADD CONSTRAINT outbox_quarantine_valid CHECK (
    quarantined_at IS NULL OR (attempts = 4 AND attempt_until IS NULL AND processed_at IS NULL)
  );

-- A committed reservation also counts attempts lost to a process crash.
CREATE FUNCTION public.rica_begin_outbox_attempt(target_event uuid,event_type text,expected_generation int)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE ticket int;
BEGIN
  UPDATE public.outbox SET attempts = attempts+1,attempt_until = clock_timestamp()+interval '30 seconds'
  WHERE event_id = target_event AND type = event_type AND generation = expected_generation
    AND processed_at IS NULL AND quarantined_at IS NULL AND attempts < 4
    AND (attempt_until IS NULL OR attempt_until <= clock_timestamp())
  RETURNING attempts INTO ticket;
  IF FOUND THEN RETURN ticket; END IF;

  UPDATE public.outbox SET quarantined_at = clock_timestamp(),attempt_until = NULL
  WHERE event_id = target_event AND type = event_type AND generation = expected_generation
    AND processed_at IS NULL AND quarantined_at IS NULL AND attempts = 4
    AND (attempt_until IS NULL OR attempt_until <= clock_timestamp());
  RETURN NULL;
END
$fn$;

CREATE FUNCTION public.rica_fail_outbox_attempt(target_event uuid,expected_generation int,ticket int)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE public.outbox SET attempt_until = NULL,
    quarantined_at = CASE WHEN attempts = 4 THEN clock_timestamp() END
  WHERE event_id = target_event AND generation = expected_generation AND attempts = ticket
    AND processed_at IS NULL AND quarantined_at IS NULL
$fn$;

CREATE FUNCTION public.rica_quarantined_outbox(target_character uuid,after_event uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',o.event_id,'runId',o.run_id,'type',o.type,'generation',o.generation,'attempts',o.attempts,'quarantinedAt',o.quarantined_at
  ) ORDER BY o.event_id),'[]'::jsonb)
  FROM (
    SELECT o.* FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
    WHERE r.character_id = target_character AND r.mode = 'SIMULATION' AND o.type IN ('RunQueued.v1','SimulatedDraftQueued.v1')
      AND o.quarantined_at IS NOT NULL AND (after_event IS NULL OR o.event_id > after_event)
    ORDER BY o.event_id LIMIT 26
  ) o
$fn$;

CREATE FUNCTION public.rica_retry_outbox(target_character uuid,target_event uuid,expected_generation int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE current_generation int;
BEGIN
  UPDATE public.outbox o SET generation = generation+1,attempts = 0,
    enqueued_at = NULL,attempt_until = NULL,quarantined_at = NULL
  FROM public.agent_runs r WHERE r.id = o.run_id AND r.character_id = target_character AND r.mode = 'SIMULATION' AND o.type IN ('RunQueued.v1','SimulatedDraftQueued.v1')
    AND o.event_id = target_event AND o.generation = expected_generation AND o.quarantined_at IS NOT NULL;
  IF FOUND THEN RETURN 'UPDATED'; END IF;
  SELECT o.generation INTO current_generation FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
    WHERE o.event_id = target_event AND r.character_id = target_character AND r.mode = 'SIMULATION';
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF current_generation <> expected_generation THEN RETURN 'STALE'; END IF;
  RETURN 'NOT_QUARANTINED';
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_begin_outbox_attempt(uuid,text,int),public.rica_fail_outbox_attempt(uuid,int,int),
  public.rica_quarantined_outbox(uuid,uuid),public.rica_retry_outbox(uuid,uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_begin_outbox_attempt(uuid,text,int),public.rica_fail_outbox_attempt(uuid,int,int)
  TO rica_runtime;
GRANT EXECUTE ON FUNCTION public.rica_quarantined_outbox(uuid,uuid),public.rica_retry_outbox(uuid,uuid,int)
  TO rica_admin_api;

CREATE OR REPLACE FUNCTION public.rica_simulation_backlog(target_character uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'observedAt', statement_timestamp(),
    'outbox', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(o.created_at),
        'enqueued', count(*) FILTER (WHERE o.enqueued_at IS NOT NULL AND o.quarantined_at IS NULL),
        'quarantined', count(*) FILTER (WHERE o.quarantined_at IS NOT NULL))
      FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
      WHERE r.character_id = target_character AND r.mode = 'SIMULATION' AND o.processed_at IS NULL
    ),
    'approvals', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(a.created_at))
      FROM public.action_proposals a JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
      WHERE a.character_id = target_character AND r.mode = 'SIMULATION' AND r.state = 'WAITING_APPROVAL'
        AND a.expires_at > statement_timestamp()
    ),
    'reconciliation', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(s.permit_until))
      FROM public.simulation_attempts s
      WHERE s.character_id = target_character AND s.status = 'UNKNOWN'
    ),
    'schedules', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(s.next_at))
      FROM public.simulation_schedules s
      WHERE s.character_id = target_character AND s.enabled AND s.next_at <= statement_timestamp()
    )
  )
$fn$;
COMMIT;
