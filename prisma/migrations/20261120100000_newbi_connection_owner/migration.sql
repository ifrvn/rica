BEGIN;

CREATE FUNCTION public.rica_newbi_read_active_account_v1(target_account uuid)
RETURNS TABLE(character_id uuid, instance_key text, remote_account_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT a.character_id, a.instance_key, a.remote_account_id
  FROM public.platform_accounts a
  WHERE a.id = target_account AND a.platform = 'newbi' AND a.status = 'ACTIVE';
$function$;
REVOKE ALL ON FUNCTION public.rica_newbi_read_active_account_v1(uuid) FROM PUBLIC;

COMMIT;
