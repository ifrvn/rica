BEGIN;

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'REJECT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunState" ADD VALUE 'WAITING_APPROVAL';
ALTER TYPE "RunState" ADD VALUE 'READY';
ALTER TYPE "RunState" ADD VALUE 'REJECTED';
ALTER TYPE "RunState" ADD VALUE 'EXPIRED';

-- CreateTable
CREATE TABLE "action_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "target" JSONB NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "review_digest" VARCHAR(64) NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "proposer_id" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_approvals" (
    "action_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "review_digest" VARCHAR(64) NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_approvals_pkey" PRIMARY KEY ("action_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_run_id_key" ON "action_proposals"("run_id");

-- CreateIndex
CREATE INDEX "action_proposals_character_id_created_at_id_idx" ON "action_proposals"("character_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_character_id_id_key" ON "action_proposals"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_character_id_run_id_key" ON "action_proposals"("character_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "action_approvals_character_id_action_id_key" ON "action_approvals"("character_id", "action_id");

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_character_id_run_id_fkey" FOREIGN KEY ("character_id", "run_id") REFERENCES "simulated_drafts"("character_id", "run_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_character_id_action_id_fkey" FOREIGN KEY ("character_id", "action_id") REFERENCES "action_proposals"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.action_proposals
  ADD CONSTRAINT action_proposals_digests CHECK (payload_hash ~ '^[0-9a-f]{64}$' AND review_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT action_proposals_expiry CHECK (expires_at > created_at AND policy_version > 0);
ALTER TABLE public.action_approvals
  ADD CONSTRAINT action_approvals_digest CHECK (review_digest ~ '^[0-9a-f]{64}$');

GRANT SELECT, INSERT ON public.action_proposals TO rica_runtime;
GRANT SELECT ON public.action_proposals TO rica_admin_api;
GRANT SELECT, INSERT ON public.action_approvals TO rica_admin_api;
GRANT SELECT (id, character_id, state, state_version) ON public.agent_runs TO rica_admin_api;

-- Only the already bound simulated account can supply a review target.
CREATE FUNCTION public.rica_simulated_review_target(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'platform', a.platform, 'instance', a.instance_key, 'accountId', a.id,
    'account', a.remote_account_id, 'identity', i.slug, 'identityId', i.id,
    'conversationId', t.id, 'conversation', t.remote_key, 'audience', t.channel,
    'contactId', p.id, 'contact', p.remote_key, 'message', e.source_key
  )
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
  JOIN public.inbound_events e ON e.id = r.inbound_event_id
  JOIN public.conversations t ON (t.character_id, t.identity_id, t.account_id, t.id)
    = (r.character_id, r.identity_id, r.account_id, e.conversation_id)
  LEFT JOIN public.contacts p ON (p.character_id, p.identity_id, p.account_id, p.id)
    = (r.character_id, r.identity_id, r.account_id, e.contact_id)
  WHERE r.id = target_run AND r.mode = 'SIMULATION'
    AND a.platform IN ('mock-a', 'mock-b') AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.core_version, r.identity_version, r.binding_version, r.auth_epoch)
      = (c.active_core_version, i.active_version, a.binding_version, c.auth_epoch)
    AND (t.channel = 'PUBLIC' OR t.private_contact_id = p.id)
$fn$;

-- Use the same authorization predicate as recall and recheck both model input sets.
-- The function-local scope is restored automatically on return.
CREATE FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET rica.memory_scope = '' AS $fn$
DECLARE
  candidate record;
  evidence record;
BEGIN
  SELECT r.id AS run_id, r.character_id, r.identity_id, r.account_id, a.target, d.content,
    d.decision_evidence_ids, d.writing_evidence_ids
  INTO candidate
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.simulated_drafts d ON (d.character_id, d.run_id) = (a.character_id, a.run_id)
  WHERE (a.character_id, a.id) = (target_character, target_action)
    AND r.state::text IN ('WAITING_APPROVAL', 'READY')
    AND a.expires_at > statement_timestamp()
    AND a.target = public.rica_simulated_review_target(r.id)
    AND a.payload_hash = encode(sha256(convert_to(d.content, 'UTF8')), 'hex');

  IF NOT FOUND THEN RETURN NULL; END IF;

  FOR evidence IN
    SELECT 'DECISION_SUPPORT'::text AS purpose, ''::text AS audience_key, candidate.decision_evidence_ids AS ids
    UNION ALL
    SELECT CASE WHEN candidate.target->>'audience' = 'PRIVATE' THEN 'PRIVATE_REPLY' ELSE 'PUBLIC_REFERENCE' END,
      CASE WHEN candidate.target->>'audience' = 'PRIVATE' THEN '' ELSE candidate.target->>'conversationId' END,
      candidate.writing_evidence_ids
  LOOP
    PERFORM set_config('rica.memory_scope', jsonb_build_object(
      'character_id', candidate.character_id, 'identity_id', candidate.identity_id, 'account_id', candidate.account_id,
      'conversation_id', candidate.target->>'conversationId', 'contact_id', candidate.target->>'contactId',
      'channel', candidate.target->>'audience', 'purpose', evidence.purpose, 'audience', NULLIF(evidence.audience_key, '')
    )::text, true);
    IF EXISTS (
      SELECT 1 FROM unnest(evidence.ids) AS used(memory_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.context_snapshots s
        JOIN public.context_snapshot_evidence se ON (se.character_id, se.snapshot_id) = (s.character_id, s.id)
        JOIN public.memories m ON (m.character_id, m.id, m.revision) = (se.character_id, se.memory_id, se.memory_revision)
        WHERE (s.character_id, s.run_id, s.purpose::text, s.audience_key)
          = (candidate.character_id, candidate.run_id, evidence.purpose, evidence.audience_key)
          AND se.memory_id = used.memory_id AND public.rica_memory_allowed(m)
      )
    ) THEN RETURN NULL; END IF;
  END LOOP;
  RETURN candidate.content;
END
$fn$;

CREATE FUNCTION public.rica_finish_action_review(
  target_character uuid, target_run uuid, expected_version int, next_state public."RunState"
) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE public.agent_runs r SET state = next_state, state_version = r.state_version + 1
  WHERE (r.character_id, r.id, r.state_version) = (target_character, target_run, expected_version)
    AND r.state::text = 'WAITING_APPROVAL' AND next_state::text IN ('READY', 'REJECTED', 'CANCELED', 'EXPIRED')
    AND EXISTS (
      SELECT 1 FROM public.action_proposals a WHERE (a.character_id, a.run_id) = (r.character_id, r.id)
        AND (next_state::text IN ('CANCELED', 'EXPIRED')
          OR public.rica_review_payload(a.character_id, a.id) IS NOT NULL)
    )
  RETURNING r.state_version
$fn$;

REVOKE ALL ON FUNCTION public.rica_simulated_review_target(uuid),
  public.rica_review_payload(uuid, uuid),
  public.rica_finish_action_review(uuid, uuid, int, public."RunState") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulated_review_target(uuid) TO rica_runtime;
GRANT EXECUTE ON FUNCTION public.rica_review_payload(uuid, uuid),
  public.rica_finish_action_review(uuid, uuid, int, public."RunState") TO rica_admin_api;
-- An authorization change cancels any outstanding or approved simulation in the same transaction.
CREATE FUNCTION public.rica_invalidate_action_reviews() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  WITH invalidated AS (
    UPDATE public.agent_runs r SET state = 'CANCELED', state_version = r.state_version + 1
    FROM public.action_proposals a
    WHERE (r.character_id, r.id) = (a.character_id, a.run_id)
      AND r.character_id = NEW.id AND r.state::text IN ('WAITING_APPROVAL', 'READY')
    RETURNING a.id, a.review_digest
  )
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  SELECT NEW.id, 'system', 'action.invalidate', id, gen_random_uuid(), review_digest FROM invalidated;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_invalidate_action_reviews() FROM PUBLIC;
CREATE TRIGGER characters_invalidate_action_reviews
AFTER UPDATE OF auth_epoch ON public.characters
FOR EACH ROW WHEN (OLD.auth_epoch IS DISTINCT FROM NEW.auth_epoch)
EXECUTE FUNCTION public.rica_invalidate_action_reviews();

COMMIT;
