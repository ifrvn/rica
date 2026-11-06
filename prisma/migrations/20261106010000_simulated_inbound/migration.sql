BEGIN;

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'REAUTH_REQUIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "InboundKind" AS ENUM ('POST', 'REPLY', 'MENTION');

-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('SIMULATION');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('QUEUED');

-- CreateTable
CREATE TABLE "characters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'PAUSED',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "active_core_version" INTEGER,
    "auth_epoch" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core_versions" (
    "character_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "hard_profile" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_versions_pkey" PRIMARY KEY ("character_id","version")
);

-- CreateTable
CREATE TABLE "identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'PAUSED',
    "active_version" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_versions" (
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "role_profile" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_versions_pkey" PRIMARY KEY ("character_id","identity_id","version")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "instance_key" TEXT NOT NULL,
    "remote_account_id" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING',
    "binding_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source_key" VARCHAR(256) NOT NULL,
    "kind" "InboundKind" NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "inbound_event_id" UUID NOT NULL,
    "core_version" INTEGER NOT NULL,
    "identity_version" INTEGER NOT NULL,
    "binding_version" INTEGER NOT NULL,
    "auth_epoch" INTEGER NOT NULL,
    "mode" "RunMode" NOT NULL DEFAULT 'SIMULATION',
    "state" "RunState" NOT NULL DEFAULT 'QUEUED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "characters_slug_key" ON "characters"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "identities_character_id_id_key" ON "identities"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "identities_character_id_slug_key" ON "identities"("character_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "platform_accounts_character_id_identity_id_id_key" ON "platform_accounts"("character_id", "identity_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_accounts_platform_instance_key_remote_account_id_key" ON "platform_accounts"("platform", "instance_key", "remote_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_account_id_source_key_key" ON "inbound_events"("account_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_character_id_identity_id_account_id_id_key" ON "inbound_events"("character_id", "identity_id", "account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_inbound_event_id_key" ON "agent_runs"("inbound_event_id");

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_id_active_core_version_fkey" FOREIGN KEY ("id", "active_core_version") REFERENCES "core_versions"("character_id", "version") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "core_versions" ADD CONSTRAINT "core_versions_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_character_id_id_active_version_fkey" FOREIGN KEY ("character_id", "id", "active_version") REFERENCES "identity_versions"("character_id", "identity_id", "version") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "identity_versions" ADD CONSTRAINT "identity_versions_character_id_identity_id_fkey" FOREIGN KEY ("character_id", "identity_id") REFERENCES "identities"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_character_id_identity_id_fkey" FOREIGN KEY ("character_id", "identity_id") REFERENCES "identities"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_character_id_identity_id_account_id_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id") REFERENCES "platform_accounts"("character_id", "identity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_character_id_identity_id_account_id_inbound_eve_fkey" FOREIGN KEY ("character_id", "identity_id", "account_id", "inbound_event_id") REFERENCES "inbound_events"("character_id", "identity_id", "account_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_character_id_core_version_fkey" FOREIGN KEY ("character_id", "core_version") REFERENCES "core_versions"("character_id", "version") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_character_id_identity_id_identity_version_fkey" FOREIGN KEY ("character_id", "identity_id", "identity_version") REFERENCES "identity_versions"("character_id", "identity_id", "version") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- An active character or identity must point to an existing in-scope profile revision.
ALTER TABLE "characters"
  ADD CONSTRAINT "characters_active_core_required" CHECK ("status" <> 'ACTIVE' OR "active_core_version" IS NOT NULL),
  ADD CONSTRAINT "characters_auth_epoch_nonnegative" CHECK ("auth_epoch" >= 0);
ALTER TABLE "identities"
  ADD CONSTRAINT "identities_active_version_required" CHECK ("status" <> 'ACTIVE' OR "active_version" IS NOT NULL);
ALTER TABLE "core_versions"
  ADD CONSTRAINT "core_versions_version_positive" CHECK ("version" > 0);
ALTER TABLE "identity_versions"
  ADD CONSTRAINT "identity_versions_version_positive" CHECK ("version" > 0);
ALTER TABLE "platform_accounts"
  ADD CONSTRAINT "platform_accounts_binding_version_positive" CHECK ("binding_version" > 0);
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_binding_version_positive" CHECK ("binding_version" > 0),
  ADD CONSTRAINT "agent_runs_auth_epoch_nonnegative" CHECK ("auth_epoch" >= 0);

COMMIT;
