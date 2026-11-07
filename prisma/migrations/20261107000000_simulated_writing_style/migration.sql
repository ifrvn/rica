BEGIN;

-- Only project a controlled style from the active identity version pinned to this run.
CREATE FUNCTION public.rica_simulated_writing_style(target_run uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE v.role_profile ->> 'writingStyle'
    WHEN 'formal' THEN 'formal'
    WHEN 'casual' THEN 'casual'
    WHEN 'concise' THEN 'concise'
    ELSE 'neutral'
  END
  FROM public.agent_runs r
  JOIN public.identities i ON (i.character_id, i.id, i.active_version)
    = (r.character_id, r.identity_id, r.identity_version)
  JOIN public.identity_versions v ON (v.character_id, v.identity_id, v.version)
    = (r.character_id, r.identity_id, r.identity_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND i.status = 'ACTIVE'
$fn$;

REVOKE ALL ON FUNCTION public.rica_simulated_writing_style(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulated_writing_style(uuid) TO rica_runtime;

COMMIT;
