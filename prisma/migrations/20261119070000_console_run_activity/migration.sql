BEGIN;

CREATE FUNCTION public.rica_console_run_activity(target_character uuid,
  before_time timestamptz, before_id uuid, page_size integer)
RETURNS TABLE(id uuid, kind text, platform text, identity text, account text, account_id uuid, state text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT r.id, 'SIMULATION', a.platform, coalesce(v.role_profile->>'displayName', i.slug),
    a.remote_account_id, r.account_id, r.state::text, r.created_at
  FROM public.agent_runs r
  JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
  JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
  JOIN public.identity_versions v
    ON (v.character_id, v.identity_id, v.version) = (r.character_id, r.identity_id, r.identity_version)
  WHERE r.character_id = target_character AND r.mode = 'SIMULATION'
    AND (before_time IS NULL OR (r.created_at, r.id) <= (before_time, before_id))
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT greatest(1, least(page_size, 102))
$fn$;

REVOKE ALL ON FUNCTION public.rica_console_run_activity(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_console_run_activity(uuid, timestamptz, uuid, integer) TO rica_admin_api;

COMMIT;
