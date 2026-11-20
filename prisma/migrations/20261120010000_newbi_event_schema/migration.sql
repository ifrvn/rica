BEGIN;

ALTER TABLE public.newbi_event_checkpoints SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_event_checkpoints RENAME TO event_checkpoints;
ALTER TABLE public.newbi_events SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_events RENAME TO events;

CREATE OR REPLACE FUNCTION public.rica_claim_newbi_event_page(account uuid, endpoint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  binding record;
  checkpoint rica_plugin_newbi.event_checkpoints%ROWTYPE;
  stamp timestamptz;
BEGIN
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = account FOR UPDATE OF c;

  SELECT a.remote_account_id,a.binding_version,c.auth_epoch INTO binding
  FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (a.character_id,a.identity_id)
  WHERE a.id = account AND a.platform = 'newbi' AND a.instance_key = endpoint
    AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
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

CREATE OR REPLACE FUNCTION public.rica_finish_newbi_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer, failure text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  saved int := 0;
  lost boolean := coalesce((page->>'historyLost')::boolean,false);
  stamp timestamptz;
  due timestamptz;
BEGIN
  -- Management takes the same character lock before changing authorization or binding.
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = account FOR UPDATE OF c;
  PERFORM 1 FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (a.character_id,a.identity_id)
  WHERE a.id = account AND a.platform = 'newbi' AND a.binding_version = version AND c.auth_epoch = epoch
    AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
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

CREATE OR REPLACE FUNCTION public.rica_sweep_newbi_events() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE changed int;
BEGIN
  DELETE FROM rica_plugin_newbi.events WHERE (account_id,seq) IN (
    SELECT account_id,seq FROM rica_plugin_newbi.events WHERE occurred_at <= statement_timestamp()-interval '720 hours'
    ORDER BY occurred_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;

COMMIT;
