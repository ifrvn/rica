BEGIN;

ALTER TABLE public.newbi_event_checkpoints
  ADD COLUMN last_succeeded_at timestamptz,
  ADD COLUMN read_error text,
  ADD CONSTRAINT newbi_checkpoint_read_error CHECK (read_error IN ('AGENT_MISMATCH', 'CREDENTIAL_INVALID',
    'ACCESS_DENIED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'COMMUNITY_CLOSED', 'READ_FAILED'));

GRANT SELECT (last_succeeded_at, read_error) ON public.newbi_event_checkpoints TO rica_admin_api;

DROP FUNCTION public.rica_finish_newbi_event_page(uuid, uuid, integer, integer, jsonb, integer);

CREATE FUNCTION public.rica_finish_newbi_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer, failure text) RETURNS jsonb
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
  UPDATE public.newbi_event_checkpoints SET
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

  INSERT INTO public.newbi_events(account_id,seq,type,post_id,comment_id,occurred_at)
  SELECT account,item.seq,item.type,item."postId",item."commentId",item."createdAt"
  FROM jsonb_to_recordset(page->'items') AS item(
    seq text,type text,"postId" uuid,"commentId" uuid,"createdAt" timestamptz)
  ON CONFLICT (account_id,seq) DO NOTHING;
  GET DIAGNOSTICS saved = ROW_COUNT;
  RETURN jsonb_build_object('nextAt',due,'saved',saved,'historyLost',lost);
END
$$;

REVOKE ALL ON FUNCTION public.rica_finish_newbi_event_page(uuid, uuid, integer, integer, jsonb, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_finish_newbi_event_page(uuid, uuid, integer, integer, jsonb, integer, text) TO rica_newbi_poller;

COMMIT;
