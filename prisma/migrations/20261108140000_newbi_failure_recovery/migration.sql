BEGIN;

ALTER TABLE public.newbi_replies
  ADD COLUMN retry_not_before timestamptz,
  ADD COLUMN closure_reason varchar(240),
  DROP CONSTRAINT newbi_replies_status_check,
  ADD CONSTRAINT newbi_replies_status_check
    CHECK (status IN ('WAITING','READY','REJECTED','IN_FLIGHT','UNKNOWN','SENT','CLOSED')),
  ADD CONSTRAINT newbi_replies_closure_reason_check
    CHECK (closure_reason IS NULL OR (status = 'CLOSED' AND length(btrim(closure_reason)) > 0));

CREATE OR REPLACE FUNCTION public.rica_newbi_execution_target(reply uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until,'retryNotBefore',(
      SELECT max(other.retry_not_before) FROM public.newbi_replies other WHERE other.account_id = r.account_id
    ))
  FROM public.newbi_replies r JOIN public.platform_accounts a ON a.id = r.account_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.characters c ON c.id = r.character_id
  WHERE r.id = reply AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND a.platform = 'newbi' AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
$fn$;

CREATE OR REPLACE FUNCTION public.rica_claim_newbi_reply(reply uuid,allow_retry boolean,agent uuid,endpoint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE claimed public.newbi_replies%ROWTYPE;
BEGIN
  PERFORM c.id FROM public.characters c JOIN public.newbi_replies r ON r.character_id = c.id
    WHERE r.id = reply FOR UPDATE OF c;
  UPDATE public.newbi_replies r SET status = 'IN_FLIGHT',attempts = attempts+1,
    lease_until = least(r.expires_at,clock_timestamp()+interval '30 seconds')
  FROM public.platform_accounts a,public.identities i,public.characters c
  WHERE r.id = reply AND a.id = r.account_id AND (i.character_id,i.id) = (r.character_id,r.identity_id)
    AND c.id = r.character_id AND a.platform = 'newbi' AND a.instance_key = endpoint
    AND a.remote_account_id = agent::text AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
    AND NOT EXISTS (
      SELECT 1 FROM public.newbi_replies other
      WHERE other.account_id = r.account_id AND other.id <> r.id AND other.status IN ('IN_FLIGHT','UNKNOWN')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.newbi_replies other
      WHERE other.account_id = r.account_id AND other.retry_not_before > clock_timestamp()
    )
    AND r.content IS NOT NULL AND r.attempts < 3 AND r.expires_at > clock_timestamp()+interval '10 seconds'
    AND (r.status = 'READY' OR (allow_retry AND (r.status = 'UNKNOWN'
      OR (r.status = 'IN_FLIGHT' AND r.lease_until <= clock_timestamp()))))
  RETURNING r.* INTO claimed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',claimed.id,'postId',claimed.post_id,'content',claimed.content,'attempt',claimed.attempts);
END
$fn$;

CREATE FUNCTION public.rica_finish_newbi_reply(
  reply uuid,ticket int,remote_comment uuid,retry_seconds int,post_locked boolean
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- A preflight limit precedes the send claim and must not consume an attempt.
  IF ticket IS NULL AND post_locked THEN
    UPDATE public.newbi_replies SET status = 'CLOSED'
    WHERE id = reply AND status = 'READY' AND attempts = 0;
  ELSIF ticket IS NULL THEN
    PERFORM c.id FROM public.characters c JOIN public.newbi_replies r ON r.character_id = c.id
      WHERE r.id = reply FOR UPDATE OF c;
    UPDATE public.newbi_replies SET retry_not_before = greatest(retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds))
    WHERE id = reply AND retry_seconds > 0 AND status IN ('READY','IN_FLIGHT','UNKNOWN');
  ELSE
    UPDATE public.newbi_replies SET status = CASE
        WHEN remote_comment IS NOT NULL THEN 'SENT'
        WHEN post_locked AND ticket = 1 THEN 'CLOSED'
        ELSE 'UNKNOWN' END,
      remote_comment_id = remote_comment,lease_until = NULL,
      retry_not_before = CASE WHEN retry_seconds > 0 THEN greatest(retry_not_before,
        clock_timestamp()+make_interval(secs => retry_seconds)) ELSE retry_not_before END
    WHERE id = reply AND attempts = ticket AND status = 'IN_FLIGHT';
  END IF;
  RETURN FOUND;
END
$fn$;

CREATE FUNCTION public.rica_close_newbi_reply(reply uuid,owner_character uuid,reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  UPDATE public.newbi_replies SET status = 'CLOSED',closure_reason = reason,lease_until = NULL
  WHERE id = reply AND character_id = owner_character AND (
    status = 'UNKNOWN' OR (status = 'IN_FLIGHT' AND lease_until <= clock_timestamp()
      AND (attempts >= 3 OR expires_at <= clock_timestamp()))
  );
  RETURN FOUND;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_finish_newbi_reply(uuid,int,uuid,int,boolean),
  public.rica_close_newbi_reply(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_finish_newbi_reply(uuid,int,uuid,int,boolean) TO rica_newbi_executor;
GRANT EXECUTE ON FUNCTION public.rica_close_newbi_reply(uuid,uuid,text) TO rica_admin_api;

COMMIT;
