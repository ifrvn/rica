BEGIN;

ALTER TYPE public."RunState" ADD VALUE 'SKIPPED';

DROP TRIGGER register_simulation_follow_up ON public.agent_runs;
DROP FUNCTION public.rica_register_simulation_follow_up();

ALTER TABLE public.agent_runs ADD COLUMN participation_decision jsonb;
GRANT UPDATE (participation_decision) ON public.agent_runs TO rica_runtime;
GRANT SELECT (participation_decision) ON public.agent_runs TO rica_admin_api;

CREATE FUNCTION public.rica_simulation_participation(target_run uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT v.role_profile->>'participation'
  FROM public.agent_runs r
  JOIN public.identities i ON (i.character_id, i.id, i.active_version)
    = (r.character_id, r.identity_id, r.identity_version)
  JOIN public.identity_versions v ON (v.character_id, v.identity_id, v.version)
    = (r.character_id, r.identity_id, r.identity_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY' AND i.status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION public.rica_simulation_participation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_participation(uuid) TO rica_runtime;

CREATE TABLE public.run_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL,
  run_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('DECISION', 'WRITING', 'REVIEW')),
  model text NOT NULL,
  system_prompt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs(character_id, id) ON DELETE CASCADE
);
CREATE INDEX run_model_calls_run_idx ON public.run_model_calls(character_id, run_id, created_at);
CREATE INDEX run_model_calls_retention_idx ON public.run_model_calls(created_at) WHERE system_prompt IS NOT NULL;

CREATE FUNCTION public.rica_record_run_model_call(target_run uuid, call_stage text, model_name text, prompt text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH saved AS (
    INSERT INTO public.run_model_calls (character_id, run_id, stage, model, system_prompt)
    SELECT r.character_id, r.id, call_stage, model_name, prompt
    FROM public.agent_runs r
    JOIN public.inbound_events e ON e.id = r.inbound_event_id AND e.character_id = r.character_id
    JOIN public.conversations c ON (c.character_id, c.identity_id, c.account_id, c.id)
      = (e.character_id, e.identity_id, e.account_id, e.conversation_id)
    WHERE r.id = target_run AND r.mode = 'SIMULATION' AND c.channel = 'PUBLIC'
      AND ((call_stage IN ('DECISION', 'WRITING') AND r.state = 'CONTEXT_READY')
        OR (call_stage = 'REVIEW' AND r.state = 'WAITING_APPROVAL'))
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM saved)
$$;

CREATE FUNCTION public.rica_run_model_calls(target_character uuid, target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'stage', m.stage, 'model', m.model, 'at', m.created_at,
    'systemPrompt', CASE WHEN r.references_expired_at IS NULL AND e.body_expired_at IS NULL
      AND m.created_at > statement_timestamp() - interval '30 days' THEN m.system_prompt END
  ) ORDER BY m.created_at, m.id), '[]'::jsonb)
  FROM public.run_model_calls m
  JOIN public.agent_runs r ON (r.character_id, r.id) = (m.character_id, m.run_id)
  JOIN public.inbound_events e ON e.id = r.inbound_event_id AND e.character_id = r.character_id
  WHERE (m.character_id, m.run_id) = (target_character, target_run)
$$;

CREATE FUNCTION public.rica_sweep_model_prompts() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH cleared AS (
    UPDATE public.run_model_calls SET system_prompt = NULL WHERE id IN (
      SELECT id FROM public.run_model_calls
      WHERE system_prompt IS NOT NULL AND created_at <= statement_timestamp() - interval '30 days'
      ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    RETURNING 1
  ) SELECT count(*)::integer FROM cleared
$$;

REVOKE ALL ON FUNCTION public.rica_record_run_model_call(uuid,text,text,text),
  public.rica_run_model_calls(uuid,uuid), public.rica_sweep_model_prompts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_record_run_model_call(uuid,text,text,text), public.rica_sweep_model_prompts() TO rica_runtime;
GRANT EXECUTE ON FUNCTION public.rica_run_model_calls(uuid,uuid) TO rica_admin_api;

COMMIT;
