BEGIN;

-- CreateEnum
CREATE TYPE "ManagementRole" AS ENUM ('ADMIN', 'OPERATOR', 'REVIEWER', 'AUDITOR');

-- CreateTable
CREATE TABLE "management_memberships" (
    "character_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "role" "ManagementRole" NOT NULL,

    CONSTRAINT "management_memberships_pkey" PRIMARY KEY ("character_id","issuer","subject","role")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_idempotency" (
    "principal_id" TEXT NOT NULL,
    "route_scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_idempotency_pkey" PRIMARY KEY ("principal_id","route_scope","key")
);

-- CreateIndex
CREATE INDEX "management_memberships_issuer_subject_character_id_idx" ON "management_memberships"("issuer", "subject", "character_id");

-- CreateIndex
CREATE INDEX "audit_log_character_id_created_at_id_idx" ON "audit_log"("character_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "api_idempotency_expires_at_idx" ON "api_idempotency"("expires_at");

-- AddForeignKey
ALTER TABLE "management_memberships" ADD CONSTRAINT "management_memberships_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Separate management credentials from health, cognition and memory administration.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rica_admin_api') THEN
    CREATE ROLE rica_admin_api NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rica_admin_api'
      AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Unexpected privileges on Rica management group role';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO rica_admin_api;
GRANT SELECT, INSERT ON public.characters, public.core_versions, public.identities,
  public.identity_versions, public.platform_accounts, public.management_memberships, public.audit_log TO rica_admin_api;
GRANT DELETE ON public.management_memberships TO rica_admin_api;
GRANT SELECT, INSERT, UPDATE ON public.api_idempotency TO rica_admin_api;
GRANT UPDATE (active_core_version, auth_epoch, status) ON public.characters TO rica_admin_api;
GRANT UPDATE (active_version, status) ON public.identities TO rica_admin_api;
GRANT UPDATE (binding_version, status) ON public.platform_accounts TO rica_admin_api;
GRANT SELECT (id, character_id, identity_id, account_id, channel, private_contact_id)
  ON public.conversations TO rica_admin_api;
GRANT SELECT (id, character_id, identity_id, account_id, conversation_id, scope, visibility, status, expires_at, created_at)
  ON public.memories TO rica_admin_api;
GRANT SELECT, INSERT ON public.memory_grants TO rica_admin_api;
GRANT UPDATE (revoked_at) ON public.memory_grants TO rica_admin_api;

CREATE POLICY memories_management_metadata ON public.memories FOR SELECT TO rica_admin_api USING (true);
CREATE POLICY memory_grants_management ON public.memory_grants TO rica_admin_api
  USING (true) WITH CHECK (true);
COMMIT;
