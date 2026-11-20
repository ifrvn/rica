BEGIN;

CREATE OR REPLACE FUNCTION public.rica_simulation_payload_allowed(target_character uuid, target_action uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT public.rica_review_payload(target_character, target_action) IS NOT NULL
$$;

ALTER FUNCTION public.rica_simulation_disclosure(uuid) RENAME TO rica_simulation_core_prompt;

CREATE OR REPLACE FUNCTION public.rica_simulation_core_prompt(target_run uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT btrim(c.hard_profile->>'aiDisclosure', E' \t\r\n')
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id, c.version) = (r.character_id, r.core_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND jsonb_typeof(c.hard_profile->'aiDisclosure') = 'string'
    AND char_length(btrim(c.hard_profile->>'aiDisclosure', E' \t\r\n')) BETWEEN 1 AND 3000
    AND translate(c.hard_profile->>'aiDisclosure', E'\t\r\n', '') !~ '[[:cntrl:]]'
$$;

CREATE FUNCTION public.rica_run_system_prompts(target_character uuid, target_run uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'core', CASE WHEN jsonb_typeof(c.hard_profile->'aiDisclosure') = 'string'
      THEN btrim(c.hard_profile->>'aiDisclosure', E' \t\r\n') END,
    'identity', CASE WHEN jsonb_typeof(v.role_profile->'writingPrompt') = 'string'
      THEN v.role_profile->>'writingPrompt' END
  )
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id, c.version) = (r.character_id, r.core_version)
  JOIN public.identity_versions v ON (v.character_id, v.identity_id, v.version)
    = (r.character_id, r.identity_id, r.identity_version)
  JOIN public.simulated_drafts d ON (d.character_id, d.run_id) = (r.character_id, r.id)
  JOIN public.action_proposals a ON (a.character_id, a.run_id) = (r.character_id, r.id)
  WHERE (r.character_id, r.id) = (target_character, target_run) AND r.mode = 'SIMULATION'
    AND a.policy_version >= 4 AND a.target->>'audience' = 'PUBLIC'
    AND r.references_expired_at IS NULL AND d.content IS NOT NULL
    AND d.created_at > statement_timestamp() - interval '720 hours'
$$;
REVOKE ALL ON FUNCTION public.rica_run_system_prompts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_run_system_prompts(uuid, uuid) TO rica_admin_api;

COMMIT;
