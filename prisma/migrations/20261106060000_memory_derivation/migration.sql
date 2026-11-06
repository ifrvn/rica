BEGIN;

-- AlterTable
ALTER TABLE "memories" ADD COLUMN     "parent_memory_id" UUID;

-- CreateIndex
CREATE INDEX "memories_character_id_parent_memory_id_idx" ON "memories"("character_id", "parent_memory_id");

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_character_id_parent_memory_id_fkey" FOREIGN KEY ("character_id", "parent_memory_id") REFERENCES "memories"("character_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Serialize new derivations and their source links with the character's revocation transaction.
CREATE FUNCTION public.rica_check_memory_derivation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  parent public.memories%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.character_id, NEW.identity_id, NEW.account_id, NEW.conversation_id, NEW.scope,
        NEW.visibility, NEW.expires_at, NEW.parent_memory_id)
      IS DISTINCT FROM
       (OLD.character_id, OLD.identity_id, OLD.account_id, OLD.conversation_id, OLD.scope,
        OLD.visibility, OLD.expires_at, OLD.parent_memory_id) THEN
      RAISE EXCEPTION 'Memory provenance and scope cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_memory_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM id FROM public.characters WHERE id = NEW.character_id FOR UPDATE;
  SELECT * INTO parent FROM public.memories
  WHERE character_id = NEW.character_id AND id = NEW.parent_memory_id AND status = 'ACTIVE'
    AND (expires_at IS NULL OR expires_at > statement_timestamp())
  FOR SHARE;

  IF NOT FOUND OR parent.id = NEW.id OR parent.scope = 'CORE'
    OR (NEW.identity_id, NEW.account_id, NEW.conversation_id, NEW.scope, NEW.visibility, NEW.expires_at)
      IS DISTINCT FROM
       (parent.identity_id, parent.account_id, parent.conversation_id, parent.scope, parent.visibility, parent.expires_at) THEN
    RAISE EXCEPTION 'Invalid memory derivation parent or scope' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.memory_sources ms
    WHERE (ms.character_id, ms.memory_id) = (parent.character_id, parent.id)
  ) OR EXISTS (
    SELECT 1 FROM public.memory_sources ms
    JOIN public.sources_registry src ON (src.character_id, src.id) = (ms.character_id, ms.source_id)
    WHERE (ms.character_id, ms.memory_id) = (parent.character_id, parent.id) AND src.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Memory derivation requires active sources' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memories_check_derivation
BEFORE INSERT OR UPDATE OF character_id, identity_id, account_id, conversation_id, scope, visibility, expires_at, parent_memory_id
ON public.memories FOR EACH ROW EXECUTE FUNCTION public.rica_check_memory_derivation();

CREATE FUNCTION public.rica_copy_memory_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  INSERT INTO public.memory_sources (character_id, memory_id, source_id)
  SELECT character_id, NEW.id, source_id FROM public.memory_sources
  WHERE (character_id, memory_id) = (NEW.character_id, NEW.parent_memory_id);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memories_copy_sources
AFTER INSERT ON public.memories FOR EACH ROW WHEN (NEW.parent_memory_id IS NOT NULL)
EXECUTE FUNCTION public.rica_copy_memory_sources();

-- The flattened source set stays valid by freezing each parent's links once derived.
CREATE FUNCTION public.rica_freeze_memory_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  PERFORM id FROM public.characters WHERE id = NEW.character_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.memories WHERE (character_id, parent_memory_id) = (NEW.character_id, NEW.memory_id)
  ) THEN
    RAISE EXCEPTION 'Memory source links are frozen after derivation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER memory_sources_freeze_after_derivation
BEFORE INSERT ON public.memory_sources FOR EACH ROW EXECUTE FUNCTION public.rica_freeze_memory_sources();

REVOKE UPDATE ON public.memory_sources FROM rica_memory_admin;

COMMIT;
