BEGIN;

-- CreateEnum
CREATE TYPE "CommitmentState" AS ENUM ('OPEN', 'DEFERRED', 'FULFILLED', 'CANCELED', 'EXPIRED');

-- CreateTable
CREATE TABLE "simulation_commitments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "state" "CommitmentState" NOT NULL DEFAULT 'OPEN',
    "due_at" TIMESTAMPTZ NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commitment_revisions" (
    "commitment_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "CommitmentState" NOT NULL,
    "due_at" TIMESTAMPTZ NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commitment_revisions_pkey" PRIMARY KEY ("commitment_id","version")
);

-- CreateIndex
CREATE INDEX "simulation_commitments_character_id_created_at_id_idx" ON "simulation_commitments"("character_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_commitments_character_id_id_key" ON "simulation_commitments"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_commitments_character_id_action_id_key" ON "simulation_commitments"("character_id", "action_id");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_commitments_character_id_schedule_id_key" ON "simulation_commitments"("character_id", "schedule_id");

-- AddForeignKey
ALTER TABLE "simulation_commitments" ADD CONSTRAINT "simulation_commitments_character_id_action_id_fkey" FOREIGN KEY ("character_id", "action_id") REFERENCES "simulation_receipts"("character_id", "action_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "simulation_commitments" ADD CONSTRAINT "simulation_commitments_character_id_schedule_id_fkey" FOREIGN KEY ("character_id", "schedule_id") REFERENCES "simulation_schedules"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "commitment_revisions" ADD CONSTRAINT "commitment_revisions_character_id_commitment_id_fkey" FOREIGN KEY ("character_id", "commitment_id") REFERENCES "simulation_commitments"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.simulation_commitments
  ADD CONSTRAINT simulation_commitments_valid CHECK (version > 0 AND char_length(btrim(title)) BETWEEN 1 AND 120);
ALTER TABLE public.commitment_revisions
  ADD CONSTRAINT commitment_revisions_valid CHECK (version > 0 AND char_length(btrim(reason)) BETWEEN 1 AND 240);

GRANT SELECT, INSERT ON public.simulation_commitments, public.commitment_revisions TO rica_admin_api;
GRANT UPDATE (state, due_at, version) ON public.simulation_commitments TO rica_admin_api;

-- Resolve a confirmed local receipt to its bound recipient without exposing content or raw receipts.
CREATE FUNCTION public.rica_confirmed_commitment_scope(target_character uuid, target_action uuid)
RETURNS TABLE ("accountId" uuid, "identityId" uuid, "conversationId" uuid, "contactId" uuid, zone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT r.account_id, r.identity_id, i.conversation_id, i.contact_id, c.timezone
  FROM public.simulation_receipts receipt
  JOIN public.simulation_attempts attempt
    ON (attempt.character_id, attempt.action_id) = (receipt.character_id, receipt.action_id)
  JOIN public.action_proposals a ON (a.character_id, a.id) = (receipt.character_id, receipt.action_id)
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.inbound_events i ON i.id = r.inbound_event_id
  JOIN public.characters c ON c.id = r.character_id
  WHERE (receipt.character_id, receipt.action_id) = (target_character, target_action)
    AND attempt.status = 'CONFIRMED' AND r.mode = 'SIMULATION' AND r.state = 'SIMULATED'
    AND i.conversation_id IS NOT NULL
$fn$;

REVOKE ALL ON FUNCTION public.rica_confirmed_commitment_scope(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_confirmed_commitment_scope(uuid, uuid) TO rica_admin_api;
COMMIT;
