CREATE TABLE public.newbi_credentials (
  endpoint text NOT NULL,
  agent_id uuid NOT NULL,
  credential text NOT NULL,
  PRIMARY KEY (endpoint, agent_id)
);

GRANT SELECT, INSERT, UPDATE ON public.newbi_credentials TO rica_admin_api;

CREATE FUNCTION public.rica_newbi_poll_connection(target_account uuid)
RETURNS TABLE(endpoint text, credential text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT c.endpoint, c.credential
  FROM public.platform_accounts a
  JOIN public.newbi_credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE a.id = target_account AND a.platform = 'newbi' AND a.status = 'ACTIVE';
$$;
REVOKE ALL ON FUNCTION public.rica_newbi_poll_connection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_newbi_poll_connection(uuid) TO rica_newbi_poller;

CREATE FUNCTION public.rica_newbi_send_connection(target_reply uuid)
RETURNS TABLE(endpoint text, credential text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT c.endpoint, c.credential
  FROM public.newbi_replies r
  JOIN public.platform_accounts a ON a.id = r.account_id AND a.character_id = r.character_id
  JOIN public.newbi_credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE r.id = target_reply AND a.platform = 'newbi' AND a.status = 'ACTIVE'
    AND r.status IN ('READY', 'IN_FLIGHT', 'UNKNOWN');
$$;
REVOKE ALL ON FUNCTION public.rica_newbi_send_connection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_newbi_send_connection(uuid) TO rica_newbi_executor;
