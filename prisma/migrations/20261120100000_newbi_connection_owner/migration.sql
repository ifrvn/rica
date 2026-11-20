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

ALTER FUNCTION public.rica_newbi_poll_connection(uuid) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_newbi_poll_connection(uuid) RENAME TO poll_connection;
ALTER FUNCTION public.rica_newbi_send_connection(uuid) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_newbi_send_connection(uuid) RENAME TO send_connection;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.poll_connection(target_account uuid)
RETURNS TABLE(endpoint text, credential text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT c.endpoint, c.credential
  FROM public.rica_newbi_read_active_account_v1(target_account) a
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id;
$function$;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.send_connection(target_reply uuid)
RETURNS TABLE(endpoint text, credential text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT c.endpoint, c.credential
  FROM rica_plugin_newbi.replies r
  JOIN LATERAL public.rica_newbi_read_active_account_v1(r.account_id) a ON a.character_id = r.character_id
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE r.id = target_reply AND r.status IN ('READY', 'IN_FLIGHT', 'UNKNOWN');
$function$;

DO $migration$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_role
    FROM pg_catalog.pg_class WHERE oid = 'rica_plugin_newbi.credentials'::regclass;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.rica_newbi_read_active_account_v1(uuid) TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.poll_connection(uuid) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.send_connection(uuid) OWNER TO %I', owner_role);
END
$migration$;

COMMIT;
