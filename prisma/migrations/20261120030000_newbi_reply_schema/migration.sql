BEGIN;

ALTER TABLE public.newbi_replies SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_replies RENAME TO replies;

CREATE OR REPLACE FUNCTION public.rica_claim_newbi_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE claimed rica_plugin_newbi.replies%ROWTYPE;
BEGIN
  PERFORM c.id FROM public.characters c JOIN rica_plugin_newbi.replies r ON r.character_id = c.id
    WHERE r.id = reply FOR UPDATE OF c;
  UPDATE rica_plugin_newbi.replies r SET status = 'IN_FLIGHT',attempts = attempts+1,
    lease_until = least(r.expires_at,clock_timestamp()+interval '30 seconds')
  FROM public.platform_accounts a,public.identities i,public.characters c
  WHERE r.id = reply AND public.rica_newbi_reply_matches_executor(r,executor)
    AND a.id = r.account_id AND (i.character_id,i.id) = (r.character_id,r.identity_id)
    AND c.id = r.character_id AND a.platform = 'newbi' AND a.instance_key = endpoint
    AND a.remote_account_id = agent::text AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
    AND NOT EXISTS (
      SELECT 1 FROM rica_plugin_newbi.replies other
      WHERE other.account_id = r.account_id AND other.id <> r.id AND other.status IN ('IN_FLIGHT','UNKNOWN')
    )
    AND NOT EXISTS (
      SELECT 1 FROM rica_plugin_newbi.replies other
      WHERE other.account_id = r.account_id AND other.retry_not_before > clock_timestamp()
    )
    AND r.content IS NOT NULL AND r.attempts < 3 AND r.expires_at > clock_timestamp()+interval '10 seconds'
    AND (r.status = 'READY' OR (allow_retry AND (r.status = 'UNKNOWN'
      OR (r.status = 'IN_FLIGHT' AND r.lease_until <= clock_timestamp()))))
  RETURNING r.* INTO claimed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',claimed.id,'postId',claimed.post_id,'content',claimed.content,'attempt',claimed.attempts);
END
$function$;

CREATE OR REPLACE FUNCTION public.rica_close_newbi_reply(reply uuid, owner_character uuid, reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  UPDATE rica_plugin_newbi.replies SET status = 'CLOSED',closure_reason = reason,lease_until = NULL
  WHERE id = reply AND character_id = owner_character AND (
    status = 'UNKNOWN' OR (status = 'IN_FLIGHT' AND lease_until <= clock_timestamp()
      AND (attempts >= 3 OR expires_at <= clock_timestamp()))
  );
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION public.rica_finish_newbi_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF ticket IS NULL THEN RETURN false; END IF;
  UPDATE rica_plugin_newbi.replies SET status = CASE
      WHEN remote_comment IS NOT NULL THEN 'SENT'
      WHEN post_locked AND ticket = 1 THEN 'CLOSED'
      ELSE 'UNKNOWN' END,
    remote_comment_id = remote_comment,lease_until = NULL,
    retry_not_before = CASE WHEN retry_seconds > 0 THEN greatest(retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds)) ELSE retry_not_before END
  WHERE id = reply AND attempts = ticket AND status = 'IN_FLIGHT';
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION public.rica_newbi_execution_target(reply uuid, executor text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until,'retryNotBefore',(
      SELECT max(other.retry_not_before) FROM rica_plugin_newbi.replies other WHERE other.account_id = r.account_id
    ))
  FROM rica_plugin_newbi.replies r JOIN public.platform_accounts a ON a.id = r.account_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.characters c ON c.id = r.character_id
  WHERE r.id = reply AND public.rica_newbi_reply_matches_executor(r,executor)
    AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND a.platform = 'newbi' AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
$function$;

CREATE OR REPLACE FUNCTION public.rica_newbi_reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF post_locked THEN
    UPDATE rica_plugin_newbi.replies r SET status = 'CLOSED'
    WHERE r.id = reply AND r.status = 'READY' AND r.attempts = 0
      AND public.rica_newbi_reply_matches_executor(r,executor);
  ELSE
    PERFORM c.id FROM public.characters c JOIN rica_plugin_newbi.replies r ON r.character_id = c.id
      WHERE r.id = reply FOR UPDATE OF c;
    UPDATE rica_plugin_newbi.replies r SET retry_not_before = greatest(r.retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds))
    WHERE r.id = reply AND retry_seconds > 0 AND r.status IN ('READY','IN_FLIGHT','UNKNOWN')
      AND public.rica_newbi_reply_matches_executor(r,executor);
  END IF;
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION public.rica_newbi_send_connection(target_reply uuid)
 RETURNS TABLE(endpoint text, credential text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT c.endpoint, c.credential
  FROM rica_plugin_newbi.replies r
  JOIN public.platform_accounts a ON a.id = r.account_id AND a.character_id = r.character_id
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE r.id = target_reply AND a.platform = 'newbi' AND a.status = 'ACTIVE'
    AND r.status IN ('READY', 'IN_FLIGHT', 'UNKNOWN');
$function$;

CREATE OR REPLACE FUNCTION public.rica_sweep_newbi_retention()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE changed int;
BEGIN
  UPDATE rica_plugin_newbi.replies SET content = NULL, review_prompt = NULL WHERE id IN (
    SELECT id FROM rica_plugin_newbi.replies
    WHERE (content IS NOT NULL OR review_prompt IS NOT NULL)
      AND created_at <= statement_timestamp() - interval '720 hours' AND expires_at <= statement_timestamp()
    ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$function$;

COMMIT;
