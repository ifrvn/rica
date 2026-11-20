BEGIN;

-- Serialize plugin writes with host authorization and binding changes.
CREATE FUNCTION public.rica_newbi_lock_poll_binding_v1(target_account uuid)
RETURNS TABLE(instance_key text, remote_account_id text, binding_version integer, auth_epoch integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = target_account AND a.platform = 'newbi' FOR UPDATE OF c;

  RETURN QUERY
    SELECT a.instance_key, a.remote_account_id, a.binding_version, c.auth_epoch
    FROM public.platform_accounts a
    JOIN public.characters c ON c.id = a.character_id
    JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
    WHERE a.id = target_account AND a.platform = 'newbi'
      AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
END
$function$;

REVOKE ALL ON FUNCTION public.rica_newbi_lock_poll_binding_v1(uuid) FROM PUBLIC;

ALTER FUNCTION public.rica_claim_newbi_event_page(uuid, text) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_claim_newbi_event_page(uuid, text) RENAME TO claim_event_page;
ALTER FUNCTION public.rica_finish_newbi_event_page(uuid, uuid, integer, integer, jsonb, integer, text) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_finish_newbi_event_page(uuid, uuid, integer, integer, jsonb, integer, text) RENAME TO finish_event_page;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.claim_event_page(account uuid, endpoint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  binding record;
  checkpoint rica_plugin_newbi.event_checkpoints%ROWTYPE;
  stamp timestamptz;
BEGIN
  SELECT b.remote_account_id, b.binding_version, b.auth_epoch INTO binding
  FROM public.rica_newbi_lock_poll_binding_v1(account) b
  WHERE b.instance_key = endpoint;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO rica_plugin_newbi.event_checkpoints(account_id) VALUES (account) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT checkpoint FROM rica_plugin_newbi.event_checkpoints WHERE account_id = account FOR UPDATE;
  stamp := clock_timestamp();
  IF greatest(checkpoint.next_poll_at,checkpoint.lease_until) > stamp THEN
    RETURN jsonb_build_object('nextAt',greatest(checkpoint.next_poll_at,checkpoint.lease_until));
  END IF;

  UPDATE rica_plugin_newbi.event_checkpoints SET ticket = gen_random_uuid(),lease_until = stamp+interval '30 seconds'
  WHERE account_id = account RETURNING * INTO checkpoint;
  RETURN jsonb_build_object('ticket',checkpoint.ticket,'cursor',checkpoint.cursor,'agentId',binding.remote_account_id,
    'bindingVersion',binding.binding_version,'authEpoch',binding.auth_epoch);
END
$$;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.finish_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer, failure text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  saved int := 0;
  lost boolean := coalesce((page->>'historyLost')::boolean,false);
  stamp timestamptz;
  due timestamptz;
BEGIN
  PERFORM 1 FROM public.rica_newbi_lock_poll_binding_v1(account) b
  WHERE b.binding_version = version AND b.auth_epoch = epoch;
  IF NOT FOUND THEN RETURN NULL; END IF;

  stamp := clock_timestamp();
  UPDATE rica_plugin_newbi.event_checkpoints SET
    cursor = coalesce(page->>'nextCursor',cursor),
    history_lost_count = history_lost_count+lost::int,
    last_history_lost_at = CASE WHEN lost THEN stamp ELSE last_history_lost_at END,
    last_succeeded_at = CASE WHEN page IS NOT NULL THEN stamp ELSE last_succeeded_at END,
    read_error = CASE WHEN page IS NOT NULL THEN NULL ELSE coalesce(failure,read_error) END,
    next_poll_at = stamp+make_interval(secs => greatest(delay_seconds,0)),
    ticket = NULL,lease_until = NULL
  WHERE account_id = account AND ticket = claim_ticket AND lease_until > stamp
  RETURNING next_poll_at INTO due;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO rica_plugin_newbi.events(account_id,seq,type,post_id,comment_id,occurred_at)
  SELECT account,item.seq,item.type,item."postId",item."commentId",item."createdAt"
  FROM jsonb_to_recordset(page->'items') AS item(
    seq text,type text,"postId" uuid,"commentId" uuid,"createdAt" timestamptz)
  ON CONFLICT (account_id,seq) DO NOTHING;
  GET DIAGNOSTICS saved = ROW_COUNT;
  RETURN jsonb_build_object('nextAt',due,'saved',saved,'historyLost',lost);
END
$$;

GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_newbi_poller;

DO $migration$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_role
    FROM pg_catalog.pg_class WHERE oid = 'rica_plugin_newbi.events'::regclass;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', owner_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.rica_newbi_lock_poll_binding_v1(uuid) TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.claim_event_page(uuid, text) OWNER TO %I', owner_role);
  EXECUTE format(
    'ALTER FUNCTION rica_plugin_newbi.finish_event_page(uuid, uuid, integer, integer, jsonb, integer, text) OWNER TO %I', owner_role
  );
END
$migration$;

COMMIT;
