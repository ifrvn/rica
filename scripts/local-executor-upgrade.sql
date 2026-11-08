-- Run with psql against a disposable database at migration 20261108170000.
\set ON_ERROR_STOP on

INSERT INTO public.characters (id,slug) VALUES ('00000000-0000-0000-0000-000000000001','executor-upgrade');
INSERT INTO public.core_versions (character_id,version,hard_profile,actor_id,reason)
  VALUES ('00000000-0000-0000-0000-000000000001',1,'{}','fixture','upgrade fixture');
UPDATE public.characters SET status = 'ACTIVE',active_core_version = 1
  WHERE id = '00000000-0000-0000-0000-000000000001';
INSERT INTO public.identities (id,character_id,slug)
  VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','executor-upgrade');
INSERT INTO public.identity_versions (character_id,identity_id,version,role_profile,actor_id,reason)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'{}','fixture','upgrade fixture');
UPDATE public.identities SET status = 'ACTIVE',active_version = 1
  WHERE id = '00000000-0000-0000-0000-000000000002';
INSERT INTO public.platform_accounts (id,character_id,identity_id,platform,instance_key,remote_account_id,status)
  SELECT ('00000000-0000-0000-0000-00000000000' || slot)::uuid,
    i.character_id,i.id,'newbi','http://localhost:5000/agent-api/v1',
    '00000000-0000-0000-0000-00000000000' || (slot + 2),'ACTIVE'
  FROM public.identities i CROSS JOIN (VALUES (3),(4)) AS slots(slot)
  WHERE i.id = '00000000-0000-0000-0000-000000000002';

INSERT INTO public.newbi_replies (
  id,character_id,identity_id,account_id,auth_epoch,binding_version,post_id,content,review_digest,
  proposer_id,reviewer_id,status,attempts,remote_comment_id,expires_at
)
  SELECT ('00000000-0000-0000-0000-0000000000' || slot)::uuid,
    a.character_id,a.identity_id,a.id,c.auth_epoch,a.binding_version,
    '00000000-0000-0000-0000-000000000020','fixture',repeat('a',64),'proposer',
    CASE WHEN reply_status <> 'WAITING' THEN 'reviewer' END,reply_status,attempts,
    CASE WHEN reply_status = 'SENT' THEN '00000000-0000-0000-0000-000000000021'::uuid END,
    clock_timestamp()+interval '1 hour'
  FROM (VALUES (11,3,'WAITING',0),(12,3,'READY',0),(13,3,'UNKNOWN',1),
    (14,4,'READY',0),(15,4,'SENT',1)) AS fixture(slot,account_slot,reply_status,attempts)
  JOIN public.platform_accounts a ON a.id = ('00000000-0000-0000-0000-00000000000' || account_slot)::uuid
  JOIN public.characters c ON c.id = a.character_id;

SET ROLE rica_newbi_executor;
DO $test$
BEGIN
  IF public.rica_claim_newbi_reply('00000000-0000-0000-0000-000000000014',false,
    '00000000-0000-0000-0000-000000000006','http://localhost:5000/agent-api/v1') IS NULL THEN
    RAISE EXCEPTION 'Legacy executor did not acquire an in-flight ticket';
  END IF;
END
$test$;
RESET ROLE;

\ir ../prisma/migrations/20261108180000_local_executor_binding/migration.sql

SET ROLE rica_newbi_executor;
DO $test$
DECLARE
  original text := 'newbi-local-executor@1.0.0/1';
  replacement text := 'newbi-local-executor@2.0.0/1';
  endpoint text := 'http://localhost:5000/agent-api/v1';
  unknown uuid := '00000000-0000-0000-0000-000000000013';
  agent uuid := '00000000-0000-0000-0000-000000000005';
  recovery jsonb;
BEGIN
  IF has_function_privilege('public.rica_claim_newbi_reply(uuid,boolean,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Legacy claim remained callable';
  END IF;
  IF public.rica_newbi_execution_target('00000000-0000-0000-0000-000000000011',original) IS NOT NULL
    OR public.rica_newbi_execution_target('00000000-0000-0000-0000-000000000012',original) IS NOT NULL
    OR public.rica_claim_newbi_reply('00000000-0000-0000-0000-000000000012',false,agent,endpoint,original) IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy unsent approval remained executable';
  END IF;
  IF public.rica_claim_newbi_reply(unknown,true,agent,endpoint,replacement) IS NOT NULL THEN
    RAISE EXCEPTION 'Replacement executor retried an unknown legacy result';
  END IF;
  recovery := public.rica_claim_newbi_reply(unknown,true,agent,endpoint,original);
  IF (recovery->>'id')::uuid IS DISTINCT FROM unknown OR (recovery->>'attempt')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Original executor did not recover the original key';
  END IF;
  IF NOT public.rica_finish_newbi_reply('00000000-0000-0000-0000-000000000014',1,
    '00000000-0000-0000-0000-000000000022',0,false) THEN
    RAISE EXCEPTION 'In-flight legacy receipt was rejected';
  END IF;
END
$test$;
RESET ROLE;

DO $test$
BEGIN
  IF (SELECT remote_comment_id FROM public.newbi_replies
    WHERE id = '00000000-0000-0000-0000-000000000015') IS DISTINCT FROM '00000000-0000-0000-0000-000000000021'::uuid THEN
    RAISE EXCEPTION 'Confirmed legacy receipt changed';
  END IF;
END
$test$;
