BEGIN;

-- CreateEnum
CREATE TYPE "RunStateReason" AS ENUM ('ACCOUNT_UNAVAILABLE', 'BINDING_CHANGED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunState" ADD VALUE 'CONTEXT_READY';
ALTER TYPE "RunState" ADD VALUE 'CANCELED';

-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "run_id" UUID;

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "state_reason" "RunStateReason",
ADD COLUMN     "state_version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "outbox_type_run_id_key" ON "outbox"("type", "run_id");

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Queued runs created by the previous release must remain eligible for delivery.
INSERT INTO "outbox" ("event_id", "type", "run_id")
SELECT gen_random_uuid(), 'RunQueued.v1', "id" FROM "agent_runs" WHERE "state" = 'QUEUED';

ALTER TABLE "outbox"
  ADD CONSTRAINT "outbox_run_queued_requires_run" CHECK ("type" <> 'RunQueued.v1' OR "run_id" IS NOT NULL);
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_state_version_positive" CHECK ("state_version" > 0);

COMMIT;
