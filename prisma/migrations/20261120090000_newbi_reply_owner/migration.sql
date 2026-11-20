BEGIN;

CREATE FUNCTION public.rica_newbi_read_active_binding_v1(target_account uuid)
RETURNS TABLE(instance_key text, remote_account_id text, binding_version integer, auth_epoch integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT a.instance_key, a.remote_account_id, a.binding_version, c.auth_epoch
  FROM public.platform_accounts a
  JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
  WHERE a.id = target_account AND a.platform = 'newbi'
    AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
$function$;

REVOKE ALL ON FUNCTION public.rica_newbi_read_active_binding_v1(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rica_newbi_lock_poll_binding_v1(target_account uuid)
RETURNS TABLE(instance_key text, remote_account_id text, binding_version integer, auth_epoch integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = target_account AND a.platform = 'newbi' FOR UPDATE OF c;

  RETURN QUERY SELECT * FROM public.rica_newbi_read_active_binding_v1(target_account);
END
$function$;

ALTER FUNCTION public.rica_claim_newbi_reply(uuid, boolean, uuid, text, text) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_claim_newbi_reply(uuid, boolean, uuid, text, text) RENAME TO claim_reply;
ALTER FUNCTION public.rica_close_newbi_reply(uuid, uuid, text) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_close_newbi_reply(uuid, uuid, text) RENAME TO close_reply;
ALTER FUNCTION public.rica_finish_newbi_reply(uuid, integer, uuid, integer, boolean) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_finish_newbi_reply(uuid, integer, uuid, integer, boolean) RENAME TO finish_reply;
ALTER FUNCTION public.rica_newbi_execution_target(uuid, text) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_newbi_execution_target(uuid, text) RENAME TO execution_target;
ALTER FUNCTION public.rica_newbi_reply_preflight(uuid, text, integer, boolean) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_newbi_reply_preflight(uuid, text, integer, boolean) RENAME TO reply_preflight;
ALTER FUNCTION public.rica_newbi_reply_matches_executor(rica_plugin_newbi.replies, text) SET SCHEMA rica_plugin_newbi;
ALTER FUNCTION rica_plugin_newbi.rica_newbi_reply_matches_executor(rica_plugin_newbi.replies, text) RENAME TO reply_matches_executor;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.claim_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  binding record;
  bound_account uuid;
  claimed rica_plugin_newbi.replies%ROWTYPE;
BEGIN
  SELECT account_id INTO bound_account FROM rica_plugin_newbi.replies WHERE id = reply;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT b.binding_version, b.auth_epoch INTO binding
  FROM public.rica_newbi_lock_poll_binding_v1(bound_account) b
  WHERE b.instance_key = endpoint AND b.remote_account_id = agent::text;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE rica_plugin_newbi.replies r SET status = 'IN_FLIGHT',attempts = attempts+1,
    lease_until = least(r.expires_at,clock_timestamp()+interval '30 seconds')
  WHERE r.id = reply AND r.account_id = bound_account AND rica_plugin_newbi.reply_matches_executor(r,executor)
    AND (r.auth_epoch,r.binding_version) = (binding.auth_epoch,binding.binding_version)
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

CREATE OR REPLACE FUNCTION rica_plugin_newbi.close_reply(reply uuid, owner_character uuid, reason text)
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

CREATE OR REPLACE FUNCTION rica_plugin_newbi.finish_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean)
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

CREATE OR REPLACE FUNCTION rica_plugin_newbi.execution_target(reply uuid, executor text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until,'retryNotBefore',(
      SELECT max(other.retry_not_before) FROM rica_plugin_newbi.replies other WHERE other.account_id = r.account_id
    ))
  FROM rica_plugin_newbi.replies r
  CROSS JOIN LATERAL public.rica_newbi_read_active_binding_v1(r.account_id) a
  WHERE r.id = reply AND rica_plugin_newbi.reply_matches_executor(r,executor)
    AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND (r.auth_epoch,r.binding_version) = (a.auth_epoch,a.binding_version)
$function$;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF post_locked THEN
    UPDATE rica_plugin_newbi.replies r SET status = 'CLOSED'
    WHERE r.id = reply AND r.status = 'READY' AND r.attempts = 0
      AND rica_plugin_newbi.reply_matches_executor(r,executor);
  ELSE
    PERFORM public.rica_newbi_lock_poll_binding_v1(r.account_id)
    FROM rica_plugin_newbi.replies r WHERE r.id = reply;
    UPDATE rica_plugin_newbi.replies r SET retry_not_before = greatest(r.retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds))
    WHERE r.id = reply AND retry_seconds > 0 AND r.status IN ('READY','IN_FLIGHT','UNKNOWN')
      AND rica_plugin_newbi.reply_matches_executor(r,executor);
  END IF;
  RETURN FOUND;
END
$function$;

GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_newbi_executor;

DO $migration$
DECLARE
  owner_role name;
  lock_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_role
    FROM pg_catalog.pg_class WHERE oid = 'rica_plugin_newbi.replies'::regclass;
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO STRICT lock_owner
    FROM pg_catalog.pg_proc WHERE oid = 'public.rica_newbi_lock_poll_binding_v1(uuid)'::regprocedure;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.rica_newbi_read_active_binding_v1(uuid) TO %I', lock_owner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.rica_newbi_read_active_binding_v1(uuid) TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.claim_reply(uuid, boolean, uuid, text, text) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.close_reply(uuid, uuid, text) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.finish_reply(uuid, integer, uuid, integer, boolean) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.execution_target(uuid, text) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.reply_preflight(uuid, text, integer, boolean) OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.reply_matches_executor(rica_plugin_newbi.replies, text) OWNER TO %I', owner_role);
END
$migration$;

COMMIT;
