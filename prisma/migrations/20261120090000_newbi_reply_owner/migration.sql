BEGIN;

CREATE FUNCTION public.rica_newbi_read_active_binding_v1(target_account uuid)
RETURNS TABLE(instance_key text, remote_account_id text, binding_version integer, auth_epoch integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT a.instance_key, a.remote_account_id, a.binding_version, c.auth_epoch
  FROM public.platform_accounts a
  JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
  WHERE a.id = target_account AND a.platform = 'newbi'
    AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
$function$;

REVOKE ALL ON FUNCTION public.rica_newbi_read_active_binding_v1(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rica_newbi_lock_poll_binding_v1(target_account uuid)
RETURNS TABLE(instance_key text, remote_account_id text, binding_version integer, auth_epoch integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = target_account AND a.platform = 'newbi' FOR UPDATE OF c;

  RETURN QUERY SELECT * FROM public.rica_newbi_read_active_binding_v1(target_account);
END
$function$;

COMMIT;
