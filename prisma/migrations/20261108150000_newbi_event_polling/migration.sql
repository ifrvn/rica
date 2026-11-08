BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rica_newbi_poller') THEN
    CREATE ROLE rica_newbi_poller NOLOGIN NOBYPASSRLS;
  END IF;
END
$role$;

CREATE TABLE public.newbi_event_checkpoints (
  account_id uuid PRIMARY KEY REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
  cursor varchar(2048),
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  ticket uuid,
  lease_until timestamptz,
  history_lost_count int NOT NULL DEFAULT 0 CHECK (history_lost_count >= 0),
  last_history_lost_at timestamptz,
  CHECK ((ticket IS NULL) = (lease_until IS NULL)),
  CHECK ((history_lost_count = 0) = (last_history_lost_at IS NULL))
);

CREATE TABLE public.newbi_events (
  account_id uuid NOT NULL REFERENCES public.platform_accounts(id) ON DELETE CASCADE,
  seq varchar(40) NOT NULL CHECK (seq ~ '^[1-9][0-9]*$'),
  type text NOT NULL CHECK (type IN ('POST_REPLIED','COMMENT_REPLIED','AGENT_MENTIONED')),
  post_id uuid NOT NULL,
  comment_id uuid,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (account_id,seq)
);
CREATE INDEX newbi_events_account_id_occurred_at_idx ON public.newbi_events(account_id,occurred_at);
CREATE INDEX newbi_events_occurred_at_idx ON public.newbi_events(occurred_at);

CREATE FUNCTION public.rica_claim_newbi_event_page(account uuid,endpoint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  binding record;
  checkpoint public.newbi_event_checkpoints%ROWTYPE;
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

  INSERT INTO public.newbi_event_checkpoints(account_id) VALUES (account) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT checkpoint FROM public.newbi_event_checkpoints WHERE account_id = account FOR UPDATE;
  stamp := clock_timestamp();
  IF greatest(checkpoint.next_poll_at,checkpoint.lease_until) > stamp THEN
    RETURN jsonb_build_object('nextAt',greatest(checkpoint.next_poll_at,checkpoint.lease_until));
  END IF;

  UPDATE public.newbi_event_checkpoints SET ticket = gen_random_uuid(),lease_until = stamp+interval '30 seconds'
  WHERE account_id = account RETURNING * INTO checkpoint;
  RETURN jsonb_build_object('ticket',checkpoint.ticket,'cursor',checkpoint.cursor,'agentId',binding.remote_account_id,
    'bindingVersion',binding.binding_version,'authEpoch',binding.auth_epoch);
END
$fn$;

CREATE FUNCTION public.rica_finish_newbi_event_page(
  account uuid,claim_ticket uuid,version int,epoch int,page jsonb,delay_seconds int
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
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
$fn$;

CREATE FUNCTION public.rica_sweep_newbi_events() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE changed int;
BEGIN
  DELETE FROM public.newbi_events WHERE (account_id,seq) IN (
    SELECT account_id,seq FROM public.newbi_events WHERE occurred_at <= statement_timestamp()-interval '720 hours'
    ORDER BY occurred_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_claim_newbi_event_page(uuid,text),
  public.rica_finish_newbi_event_page(uuid,uuid,int,int,jsonb,int),public.rica_sweep_newbi_events() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rica_newbi_poller;
GRANT EXECUTE ON FUNCTION public.rica_claim_newbi_event_page(uuid,text),
  public.rica_finish_newbi_event_page(uuid,uuid,int,int,jsonb,int) TO rica_newbi_poller;
GRANT EXECUTE ON FUNCTION public.rica_sweep_newbi_events() TO rica_runtime;
GRANT SELECT (account_id,next_poll_at,history_lost_count,last_history_lost_at)
  ON public.newbi_event_checkpoints TO rica_admin_api;
GRANT SELECT ON public.newbi_events TO rica_admin_api;

COMMIT;
