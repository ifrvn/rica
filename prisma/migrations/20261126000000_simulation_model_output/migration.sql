BEGIN;

ALTER TABLE public.run_model_calls ADD COLUMN model_output text;

DROP FUNCTION public.rica_record_run_model_call(uuid,text,text,text);
CREATE FUNCTION public.rica_record_run_model_call(target_run uuid, call_stage text, model_name text, prompt text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  INSERT INTO public.run_model_calls (character_id, run_id, stage, model, system_prompt)
  SELECT r.character_id, r.id, call_stage, model_name, prompt
  FROM public.agent_runs r
  JOIN public.inbound_events e ON e.id = r.inbound_event_id AND e.character_id = r.character_id
  JOIN public.conversations c ON (c.character_id, c.identity_id, c.account_id, c.id)
    = (e.character_id, e.identity_id, e.account_id, e.conversation_id)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND c.channel = 'PUBLIC'
    AND ((call_stage IN ('DECISION', 'WRITING') AND r.state = 'CONTEXT_READY')
      OR (call_stage = 'REVIEW' AND r.state = 'WAITING_APPROVAL'))
  RETURNING id
$$;

CREATE FUNCTION public.rica_record_run_model_output(target_run uuid, target_call uuid, output text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH saved AS (
    UPDATE public.run_model_calls m SET model_output = output
    FROM public.agent_runs r
    JOIN public.characters c ON c.id = r.character_id
    JOIN public.inbound_events e ON e.id = r.inbound_event_id AND e.character_id = r.character_id
    WHERE (m.character_id, m.run_id) = (r.character_id, r.id)
      AND m.run_id = target_run AND m.id = target_call AND m.model_output IS NULL AND m.system_prompt IS NOT NULL
      AND r.references_expired_at IS NULL AND e.body_expired_at IS NULL
      AND r.auth_epoch = c.auth_epoch AND e.received_at > statement_timestamp() - interval '720 hours'
      AND m.created_at > statement_timestamp() - interval '30 days'
    RETURNING 1
  ) SELECT EXISTS (SELECT 1 FROM saved)
$$;

CREATE OR REPLACE FUNCTION public.rica_run_model_calls(target_character uuid, target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'stage', m.stage, 'model', m.model, 'at', m.created_at,
    'systemPrompt', CASE WHEN visibility.available THEN m.system_prompt END,
    'output', CASE WHEN visibility.available AND r.auth_epoch = c.auth_epoch
      AND e.received_at > statement_timestamp() - interval '720 hours' THEN m.model_output END
  ) ORDER BY m.created_at, m.id), '[]'::jsonb)
  FROM public.run_model_calls m
  JOIN public.agent_runs r ON (r.character_id, r.id) = (m.character_id, m.run_id)
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.inbound_events e ON e.id = r.inbound_event_id AND e.character_id = r.character_id
  CROSS JOIN LATERAL (SELECT r.references_expired_at IS NULL AND e.body_expired_at IS NULL
    AND m.created_at > statement_timestamp() - interval '30 days' AS available) visibility
  WHERE (m.character_id, m.run_id) = (target_character, target_run)
$$;

CREATE OR REPLACE FUNCTION public.rica_sweep_model_prompts() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH cleared AS (
    UPDATE public.run_model_calls SET system_prompt = NULL, model_output = NULL WHERE id IN (
      SELECT id FROM public.run_model_calls
      WHERE system_prompt IS NOT NULL AND created_at <= statement_timestamp() - interval '30 days'
      ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    RETURNING 1
  ) SELECT count(*)::integer FROM cleared
$$;

REVOKE ALL ON FUNCTION public.rica_record_run_model_call(uuid,text,text,text),
  public.rica_record_run_model_output(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_record_run_model_call(uuid,text,text,text),
  public.rica_record_run_model_output(uuid,uuid,text) TO rica_runtime;

COMMIT;
