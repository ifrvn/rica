BEGIN;

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterEnum
ALTER TYPE "RunStateReason" ADD VALUE 'CONVERSATION_UNAVAILABLE';

-- AlterEnum
ALTER TYPE "MemoryScope" ADD VALUE 'CONVERSATION';

-- AlterEnum
ALTER TYPE "MemoryPurpose" ADD VALUE 'PRIVATE_REPLY';

-- AlterTable
ALTER TABLE "inbound_events" ADD COLUMN     "contact_id" UUID,
ADD COLUMN     "conversation_id" UUID;

-- AlterTable
ALTER TABLE "memories" ADD COLUMN     "conversation_id" UUID;

-- AlterTable
ALTER TABLE "sources_registry" ADD COLUMN     "conversation_id" UUID;

-- AlterTable
ALTER TABLE "memory_grants" ADD COLUMN     "recipient_contact_id" UUID,
ADD COLUMN     "recipient_conversation_id" UUID;

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "remote_key" TEXT NOT NULL,
    "display_label" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "remote_key" TEXT NOT NULL,
    "channel" "ConversationChannel" NOT NULL,
    "private_contact_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_character_id_identity_id_account_id_id_key" ON "contacts"("character_id", "identity_id", "account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_account_id_remote_key_key" ON "contacts"("account_id", "remote_key");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_character_id_identity_id_account_id_id_key" ON "conversations"("character_id", "identity_id", "account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_private_recipient_key" ON "conversations"("character_id", "identity_id", "account_id", "id", "private_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_account_id_remote_key_key" ON "conversations"("account_id", "remote_key");

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_character_id_identity_id_account_id_convers_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "conversation_id") REFERENCES "conversations"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_character_id_identity_id_account_id_contact_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "contact_id") REFERENCES "contacts"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_character_id_identity_id_account_id_conversation__fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "conversation_id") REFERENCES "conversations"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sources_registry" ADD CONSTRAINT "sources_registry_character_id_identity_id_account_id_conve_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "conversation_id") REFERENCES "conversations"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_grants" ADD CONSTRAINT "memory_grants_private_recipient_fkey" FOREIGN KEY ("character_id", "recipient_identity_id", "recipient_account_id", "recipient_conversation_id", "recipient_contact_id") REFERENCES "conversations"("character_id", "identity_id", "account_id", "id", "private_contact_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_character_id_identity_id_account_id_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id") REFERENCES "platform_accounts"("character_id", "identity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_character_id_identity_id_account_id_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id") REFERENCES "platform_accounts"("character_id", "identity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_character_id_identity_id_account_id_private__fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "private_contact_id") REFERENCES "contacts"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_channel_matches_recipient" CHECK (
    ("channel" = 'PRIVATE' AND "private_contact_id" IS NOT NULL)
    OR ("channel" = 'PUBLIC' AND "private_contact_id" IS NULL)
  );

ALTER TABLE "memories"
  DROP CONSTRAINT "memories_scope_requires_owner",
  ADD CONSTRAINT "memories_scope_requires_owner" CHECK (
    ("scope" = 'CORE' AND "identity_id" IS NULL AND "account_id" IS NULL AND "conversation_id" IS NULL AND "visibility" = 'PUBLIC' AND "core_approved_at" IS NOT NULL)
    OR ("scope" = 'IDENTITY' AND "identity_id" IS NOT NULL AND "account_id" IS NULL AND "conversation_id" IS NULL AND "core_approved_at" IS NULL)
    OR ("scope" = 'ACCOUNT' AND "identity_id" IS NOT NULL AND "account_id" IS NOT NULL AND "conversation_id" IS NULL AND "core_approved_at" IS NULL)
    OR ("scope"::text = 'CONVERSATION' AND "identity_id" IS NOT NULL AND "account_id" IS NOT NULL AND "conversation_id" IS NOT NULL AND "core_approved_at" IS NULL)
  );

ALTER TABLE "sources_registry"
  ADD CONSTRAINT "sources_registry_conversation_requires_account" CHECK ("conversation_id" IS NULL OR "account_id" IS NOT NULL);

ALTER TABLE "memory_grants"
  ADD CONSTRAINT "memory_grants_private_recipient_required" CHECK (
    ("purpose"::text = 'PRIVATE_REPLY' AND "recipient_account_id" IS NOT NULL
      AND "recipient_conversation_id" IS NOT NULL AND "recipient_contact_id" IS NOT NULL)
    OR ("purpose"::text <> 'PRIVATE_REPLY' AND "recipient_conversation_id" IS NULL AND "recipient_contact_id" IS NULL)
  );

-- A private thread must never expose old conversation memory to a different recipient.
CREATE FUNCTION keep_conversation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.character_id, NEW.identity_id, NEW.account_id, NEW.remote_key, NEW.channel, NEW.private_contact_id)
     IS DISTINCT FROM
     (OLD.character_id, OLD.identity_id, OLD.account_id, OLD.remote_key, OLD.channel, OLD.private_contact_id) THEN
    RAISE EXCEPTION 'Conversation binding cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_keep_binding
BEFORE UPDATE ON "conversations"
FOR EACH ROW EXECUTE FUNCTION keep_conversation_binding();

COMMIT;
