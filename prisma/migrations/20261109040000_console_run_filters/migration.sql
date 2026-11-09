BEGIN;

DROP FUNCTION public.rica_console_simulation_runs(uuid, uuid, integer);

CREATE FUNCTION public.rica_console_simulation_runs(target_character uuid, after_run uuid, page_size integer,
  filter_state public."RunState", filter_identity uuid, filter_account uuid, from_day date, through_day date)
RETURNS TABLE(id uuid, state text, "identityId" uuid, "accountId" uuid, platform text, "createdAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT r.id, r.state::text, r.identity_id, r.account_id, a.platform, r.created_at
  FROM public.agent_runs r
  JOIN public.platform_accounts a ON (a.character_id, a.id) = (r.character_id, r.account_id)
  WHERE r.character_id = target_character AND r.mode = 'SIMULATION'
    AND (filter_state IS NULL OR r.state = filter_state)
    AND (filter_identity IS NULL OR r.identity_id = filter_identity)
    AND (filter_account IS NULL OR r.account_id = filter_account)
    AND (from_day IS NULL OR r.created_at >= (from_day::timestamp AT TIME ZONE 'UTC'))
    AND (through_day IS NULL OR r.created_at < ((through_day + 1)::timestamp AT TIME ZONE 'UTC'))
    AND (after_run IS NULL OR
    (r.created_at, r.id) < (
      SELECT cursor_run.created_at, cursor_run.id FROM public.agent_runs cursor_run
      WHERE (cursor_run.character_id, cursor_run.id) = (target_character, after_run) AND cursor_run.mode = 'SIMULATION'
    ))
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT greatest(1, least(page_size, 101))
$fn$;

REVOKE ALL ON FUNCTION public.rica_console_simulation_runs(uuid, uuid, integer, public."RunState", uuid, uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_console_simulation_runs(uuid, uuid, integer, public."RunState", uuid, uuid, date, date) TO rica_admin_api;

COMMIT;
