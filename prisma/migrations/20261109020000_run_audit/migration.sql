BEGIN;

CREATE INDEX audit_log_character_target_created_idx ON public.audit_log(character_id, target_id, created_at, id);

CREATE FUNCTION public.rica_run_audit_outbox(target_character uuid, target_run uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT o.event_id
  FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
  WHERE (r.character_id, r.id) = (target_character, target_run)
$fn$;

REVOKE ALL ON FUNCTION public.rica_run_audit_outbox(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_run_audit_outbox(uuid, uuid) TO rica_admin_api;

COMMIT;
