BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rica_newbi_executor') THEN
    CREATE ROLE rica_newbi_executor NOLOGIN NOBYPASSRLS;
  END IF;
END
$role$;

CREATE TABLE public.newbi_replies (
  id uuid PRIMARY KEY,
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  account_id uuid NOT NULL,
  auth_epoch int NOT NULL,
  binding_version int NOT NULL,
  post_id uuid NOT NULL,
  content text CHECK (content IS NULL OR char_length(btrim(content)) BETWEEN 1 AND 4000),
  review_digest varchar(64) NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  proposer_id text NOT NULL,
  reviewer_id text,
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','READY','REJECTED','IN_FLIGHT','UNKNOWN','SENT')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_until timestamptz,
  remote_comment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (character_id,identity_id,account_id)
    REFERENCES public.platform_accounts(character_id,identity_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  UNIQUE (account_id,remote_comment_id),
  CHECK ((status = 'SENT') = (remote_comment_id IS NOT NULL)),
  CHECK ((status = 'IN_FLIGHT') = (lease_until IS NOT NULL)),
  CHECK ((status = 'WAITING') = (reviewer_id IS NULL)),
  CHECK (reviewer_id IS NULL OR reviewer_id <> proposer_id)
);
GRANT SELECT, INSERT ON public.newbi_replies TO rica_admin_api;
GRANT UPDATE (status,reviewer_id) ON public.newbi_replies TO rica_admin_api;

CREATE FUNCTION public.rica_newbi_execution_target(reply uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until)
  FROM public.newbi_replies r JOIN public.platform_accounts a ON a.id = r.account_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.characters c ON c.id = r.character_id
  WHERE r.id = reply AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND a.platform = 'newbi' AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
$fn$;

CREATE FUNCTION public.rica_claim_newbi_reply(reply uuid,allow_retry boolean,agent uuid,endpoint text)
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
    AND r.content IS NOT NULL AND r.attempts < 3 AND r.expires_at > clock_timestamp()+interval '10 seconds'
    AND (r.status = 'READY' OR (allow_retry AND (r.status = 'UNKNOWN'
      OR (r.status = 'IN_FLIGHT' AND r.lease_until <= clock_timestamp()))))
  RETURNING r.* INTO claimed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',claimed.id,'postId',claimed.post_id,'content',claimed.content,'attempt',claimed.attempts);
END
$fn$;

CREATE FUNCTION public.rica_finish_newbi_reply(reply uuid,ticket int,remote_comment uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  UPDATE public.newbi_replies SET status = CASE WHEN remote_comment IS NULL THEN 'UNKNOWN' ELSE 'SENT' END,
    remote_comment_id = remote_comment,lease_until = NULL
  WHERE id = reply AND attempts = ticket AND status = 'IN_FLIGHT';
  RETURN FOUND;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_newbi_execution_target(uuid),public.rica_claim_newbi_reply(uuid,boolean,uuid,text),
  public.rica_finish_newbi_reply(uuid,int,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rica_newbi_executor;
GRANT EXECUTE ON FUNCTION public.rica_newbi_execution_target(uuid),public.rica_claim_newbi_reply(uuid,boolean,uuid,text),
  public.rica_finish_newbi_reply(uuid,int,uuid) TO rica_newbi_executor;

CREATE FUNCTION public.rica_sweep_newbi_retention()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE changed int;
BEGIN
  UPDATE public.newbi_replies SET content = NULL WHERE id IN (
    SELECT id FROM public.newbi_replies
    WHERE content IS NOT NULL AND created_at <= statement_timestamp()-interval '720 hours'
      AND expires_at <= statement_timestamp()
    ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_sweep_newbi_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_sweep_newbi_retention() TO rica_runtime;

COMMIT;
