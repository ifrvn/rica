BEGIN;

ALTER TABLE public.newbi_replies
  ADD COLUMN executor_key text,
  ADD COLUMN approved_executor_key text,
  ADD CONSTRAINT newbi_replies_executor_approval_check
    CHECK (approved_executor_key IS NULL OR
      (executor_key IS NOT NULL AND executor_key = approved_executor_key));

GRANT UPDATE (approved_executor_key) ON public.newbi_replies TO rica_admin_api;

CREATE FUNCTION public.rica_guard_newbi_reply_executor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.executor_key IS NULL OR NEW.status <> 'WAITING' OR NEW.approved_executor_key IS NOT NULL THEN
      RAISE EXCEPTION 'A current executor binding is required for new replies' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.executor_key IS DISTINCT FROM OLD.executor_key THEN
      RAISE EXCEPTION 'The reply executor binding is immutable' USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'READY' OR NEW.approved_executor_key IS DISTINCT FROM OLD.approved_executor_key)
      AND NOT (OLD.status = 'WAITING' AND NEW.status = 'READY' AND NEW.approved_executor_key IS NOT NULL) THEN
      RAISE EXCEPTION 'Approval must bind the reply executor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER newbi_replies_guard_executor
  BEFORE INSERT OR UPDATE OF executor_key,approved_executor_key,status ON public.newbi_replies
  FOR EACH ROW EXECUTE FUNCTION public.rica_guard_newbi_reply_executor();

CREATE FUNCTION public.rica_newbi_reply_matches_executor(r public.newbi_replies,executor text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE
    WHEN r.executor_key IS NOT NULL THEN r.approved_executor_key = executor
    -- Before this migration only the original implementation could claim these attempts.
    ELSE r.attempts > 0 AND r.status IN ('UNKNOWN','IN_FLIGHT') AND executor = 'newbi-local-executor@1.0.0/1'
  END
$fn$;

CREATE OR REPLACE FUNCTION public.rica_newbi_execution_target(reply uuid,executor text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until,'retryNotBefore',(
      SELECT max(other.retry_not_before) FROM public.newbi_replies other WHERE other.account_id = r.account_id
    ))
  FROM public.newbi_replies r JOIN public.platform_accounts a ON a.id = r.account_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.characters c ON c.id = r.character_id
  WHERE r.id = reply AND public.rica_newbi_reply_matches_executor(r,executor)
    AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND a.platform = 'newbi' AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
$fn$;

CREATE OR REPLACE FUNCTION public.rica_claim_newbi_reply(reply uuid,allow_retry boolean,agent uuid,endpoint text,executor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE claimed public.newbi_replies%ROWTYPE;
BEGIN
  PERFORM c.id FROM public.characters c JOIN public.newbi_replies r ON r.character_id = c.id
    WHERE r.id = reply FOR UPDATE OF c;
  UPDATE public.newbi_replies r SET status = 'IN_FLIGHT',attempts = attempts+1,
    lease_until = least(r.expires_at,clock_timestamp()+interval '30 seconds')
  FROM public.platform_accounts a,public.identities i,public.characters c
  WHERE r.id = reply AND public.rica_newbi_reply_matches_executor(r,executor)
    AND a.id = r.account_id AND (i.character_id,i.id) = (r.character_id,r.identity_id)
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

CREATE OR REPLACE FUNCTION public.rica_finish_newbi_reply(
  reply uuid,ticket int,remote_comment uuid,retry_seconds int,post_locked boolean
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF ticket IS NULL THEN RETURN false; END IF;
  UPDATE public.newbi_replies SET status = CASE
      WHEN remote_comment IS NOT NULL THEN 'SENT'
      WHEN post_locked AND ticket = 1 THEN 'CLOSED'
      ELSE 'UNKNOWN' END,
    remote_comment_id = remote_comment,lease_until = NULL,
    retry_not_before = CASE WHEN retry_seconds > 0 THEN greatest(retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds)) ELSE retry_not_before END
  WHERE id = reply AND attempts = ticket AND status = 'IN_FLIGHT';
  RETURN FOUND;
END
$fn$;

CREATE FUNCTION public.rica_newbi_reply_preflight(reply uuid,executor text,retry_seconds int,post_locked boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF post_locked THEN
    UPDATE public.newbi_replies r SET status = 'CLOSED'
    WHERE r.id = reply AND r.status = 'READY' AND r.attempts = 0
      AND public.rica_newbi_reply_matches_executor(r,executor);
  ELSE
    PERFORM c.id FROM public.characters c JOIN public.newbi_replies r ON r.character_id = c.id
      WHERE r.id = reply FOR UPDATE OF c;
    UPDATE public.newbi_replies r SET retry_not_before = greatest(r.retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds))
    WHERE r.id = reply AND retry_seconds > 0 AND r.status IN ('READY','IN_FLIGHT','UNKNOWN')
      AND public.rica_newbi_reply_matches_executor(r,executor);
  END IF;
  RETURN FOUND;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.rica_newbi_execution_target(uuid),
  public.rica_claim_newbi_reply(uuid,boolean,uuid,text) FROM rica_newbi_executor;

REVOKE ALL ON FUNCTION public.rica_guard_newbi_reply_executor(),
  public.rica_newbi_reply_matches_executor(public.newbi_replies,text),
  public.rica_newbi_execution_target(uuid,text),
  public.rica_claim_newbi_reply(uuid,boolean,uuid,text,text),
  public.rica_newbi_reply_preflight(uuid,text,int,boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.rica_newbi_execution_target(uuid,text),
  public.rica_claim_newbi_reply(uuid,boolean,uuid,text,text),
  public.rica_newbi_reply_preflight(uuid,text,int,boolean) TO rica_newbi_executor;

COMMIT;
