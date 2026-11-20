BEGIN;

CREATE SCHEMA rica_plugin_newbi;
ALTER TABLE public.newbi_credentials SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_credentials RENAME TO credentials;

CREATE VIEW rica_plugin_newbi.account_profiles AS
  SELECT endpoint, agent_id, username, avatar_url
  FROM rica_plugin_newbi.credentials;

GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_admin_api;
GRANT SELECT ON rica_plugin_newbi.account_profiles TO rica_admin_api;

CREATE OR REPLACE FUNCTION public.rica_newbi_poll_connection(target_account uuid)
RETURNS TABLE(endpoint text, credential text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT c.endpoint, c.credential
  FROM public.platform_accounts a
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE a.id = target_account AND a.platform = 'newbi' AND a.status = 'ACTIVE';
$$;

CREATE OR REPLACE FUNCTION public.rica_newbi_send_connection(target_reply uuid)
RETURNS TABLE(endpoint text, credential text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT c.endpoint, c.credential
  FROM public.newbi_replies r
  JOIN public.platform_accounts a ON a.id = r.account_id AND a.character_id = r.character_id
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE r.id = target_reply AND a.platform = 'newbi' AND a.status = 'ACTIVE'
    AND r.status IN ('READY', 'IN_FLIGHT', 'UNKNOWN');
$$;

COMMIT;
