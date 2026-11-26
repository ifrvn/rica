BEGIN;

ALTER TYPE public."RunStateReason" ADD VALUE 'MODEL_DECISION_INVALID_OUTPUT';
ALTER TYPE public."RunStateReason" ADD VALUE 'MODEL_WRITING_INVALID_OUTPUT';

DROP FUNCTION public.rica_simulated_writing_profile(uuid);
CREATE FUNCTION public.rica_simulated_writing_profile(target_run uuid)
RETURNS TABLE (style text, prompt text, model_profile text, group_chat boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  SELECT CASE v.role_profile ->> 'writingStyle'
    WHEN 'formal' THEN 'formal'
    WHEN 'casual' THEN 'casual'
    WHEN 'concise' THEN 'concise'
    ELSE 'neutral'
  END, CASE WHEN jsonb_typeof(v.role_profile -> 'writingPrompt') = 'string'
    THEN v.role_profile ->> 'writingPrompt' END,
  CASE WHEN jsonb_typeof(v.role_profile -> 'draftModelProfile') = 'string'
    THEN v.role_profile ->> 'draftModelProfile' END,
  coalesce(v.role_profile -> 'groupChat' = 'true'::jsonb, false)
  FROM public.agent_runs r
  JOIN public.identities i ON (i.character_id, i.id, i.active_version)
    = (r.character_id, r.identity_id, r.identity_version)
  JOIN public.identity_versions v ON (v.character_id, v.identity_id, v.version)
    = (r.character_id, r.identity_id, r.identity_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND i.status = 'ACTIVE'
$$;

REVOKE ALL ON FUNCTION public.rica_simulated_writing_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulated_writing_profile(uuid) TO rica_runtime;

COMMIT;
