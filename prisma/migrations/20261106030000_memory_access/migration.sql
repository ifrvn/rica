BEGIN;

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('CORE', 'IDENTITY', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "MemoryVisibility" AS ENUM ('PUBLIC', 'PERSONAL', 'CONFIDENTIAL', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "MemoryPurpose" AS ENUM ('INTERNAL_CONTEXT', 'DECISION_SUPPORT', 'PUBLIC_REFERENCE');

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID,
    "account_id" UUID,
    "scope" "MemoryScope" NOT NULL,
    "visibility" "MemoryVisibility" NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "content" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "expires_at" TIMESTAMPTZ,
    "core_approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources_registry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID,
    "account_id" UUID,
    "kind" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "classification" "MemoryVisibility" NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_sources" (
    "character_id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_sources_pkey" PRIMARY KEY ("character_id","memory_id","source_id")
);

-- CreateTable
CREATE TABLE "memory_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "recipient_identity_id" UUID NOT NULL,
    "recipient_account_id" UUID,
    "purpose" "MemoryPurpose" NOT NULL,
    "audience" TEXT,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_until" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "approved_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_character_id_status_scope_identity_id_account_id_idx" ON "memories"("character_id", "status", "scope", "identity_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "memories_character_id_id_key" ON "memories"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sources_registry_character_id_id_key" ON "sources_registry"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sources_registry_character_id_kind_source_key_key" ON "sources_registry"("character_id", "kind", "source_key");

-- CreateIndex
CREATE INDEX "memory_sources_character_id_source_id_idx" ON "memory_sources"("character_id", "source_id");

-- CreateIndex
CREATE INDEX "memory_grants_character_id_recipient_identity_id_purpose_me_idx" ON "memory_grants"("character_id", "recipient_identity_id", "purpose", "memory_id");

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_character_id_identity_id_fkey" FOREIGN KEY ("character_id", "identity_id") REFERENCES "identities"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_character_id_identity_id_account_id_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id") REFERENCES "platform_accounts"("character_id", "identity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sources_registry" ADD CONSTRAINT "sources_registry_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sources_registry" ADD CONSTRAINT "sources_registry_character_id_identity_id_fkey" FOREIGN KEY ("character_id", "identity_id") REFERENCES "identities"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sources_registry" ADD CONSTRAINT "sources_registry_character_id_identity_id_account_id_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id") REFERENCES "platform_accounts"("character_id", "identity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_character_id_memory_id_fkey" FOREIGN KEY ("character_id", "memory_id") REFERENCES "memories"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_character_id_source_id_fkey" FOREIGN KEY ("character_id", "source_id") REFERENCES "sources_registry"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_grants" ADD CONSTRAINT "memory_grants_character_id_memory_id_fkey" FOREIGN KEY ("character_id", "memory_id") REFERENCES "memories"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_grants" ADD CONSTRAINT "memory_grants_character_id_recipient_identity_id_fkey" FOREIGN KEY ("character_id", "recipient_identity_id") REFERENCES "identities"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_grants" ADD CONSTRAINT "memory_grants_character_id_recipient_identity_id_recipient_fkey" FOREIGN KEY ("character_id", "recipient_identity_id", "recipient_account_id") REFERENCES "platform_accounts"("character_id", "identity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_scope_requires_owner" CHECK (
    ("scope" = 'CORE' AND "identity_id" IS NULL AND "account_id" IS NULL AND "visibility" = 'PUBLIC' AND "core_approved_at" IS NOT NULL)
    OR ("scope" = 'IDENTITY' AND "identity_id" IS NOT NULL AND "account_id" IS NULL AND "core_approved_at" IS NULL)
    OR ("scope" = 'ACCOUNT' AND "identity_id" IS NOT NULL AND "account_id" IS NOT NULL AND "core_approved_at" IS NULL)
  ),
  ADD CONSTRAINT "memories_revision_positive" CHECK ("revision" > 0),
  ADD CONSTRAINT "memories_scores_in_range" CHECK ("importance" BETWEEN 0 AND 1 AND "confidence" BETWEEN 0 AND 1);

ALTER TABLE "sources_registry"
  ADD CONSTRAINT "sources_registry_scope_requires_owner" CHECK (
    ("account_id" IS NULL OR "identity_id" IS NOT NULL)
    AND ("classification" = 'PUBLIC' OR "identity_id" IS NOT NULL)
  );

ALTER TABLE "memory_grants"
  ADD CONSTRAINT "memory_grants_valid_window" CHECK ("valid_until" > "valid_from"),
  ADD CONSTRAINT "memory_grants_audience_matches_purpose" CHECK (
    ("purpose" = 'PUBLIC_REFERENCE' AND "audience" IS NOT NULL AND btrim("audience") <> '')
    OR ("purpose" <> 'PUBLIC_REFERENCE' AND "audience" IS NULL)
  );

COMMIT;
