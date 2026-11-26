BEGIN;

ALTER TABLE public.run_model_calls
  DROP CONSTRAINT run_model_calls_stage_check,
  ADD CONSTRAINT run_model_calls_stage_check CHECK (stage IN ('DECISION', 'WRITING', 'DECISION_AND_WRITING', 'REVIEW'));

CREATE OR REPLACE FUNCTION public.rica_record_run_model_call(target_run uuid, call_stage text, model_name text, prompt text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  INSERT INTO public.run_model_calls (character_id, run_id, stage, model, system_prompt)
  SELECT r.character_id, r.id, call_stage, model_name, prompt
  FROM public.agent_runs r
  JOIN public.inbound_events e ON e.id = r.inbound_event_id AND e.character_id = r.character_id
  JOIN public.conversations c ON (c.character_id, c.identity_id, c.account_id, c.id)
    = (e.character_id, e.identity_id, e.account_id, e.conversation_id)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND c.channel = 'PUBLIC'
    AND ((call_stage IN ('DECISION', 'WRITING') AND r.state = 'CONTEXT_READY')
      OR (call_stage = 'DECISION_AND_WRITING' AND r.state = 'CONTEXT_READY'
        AND c.simulation_chat_id IS NOT NULL AND e.console_speaker_id IS NOT NULL)
      OR (call_stage = 'REVIEW' AND r.state = 'WAITING_APPROVAL'))
  RETURNING id
$$;

COMMIT;
