BEGIN;

CREATE TABLE public.memory_corrections (
  character_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision int NOT NULL CHECK (revision > 1),
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id,memory_id,revision),
  FOREIGN KEY (character_id,memory_id) REFERENCES public.memories(character_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE FUNCTION public.rica_memory_provenance(target_character uuid,target_memory uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',m.id,'revision',m.revision,'status',m.status,'parentMemoryId',m.parent_memory_id,
    'sources',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'classification',s.classification,'revokedAt',s.revoked_at)
        ORDER BY s.id)
      FROM public.memory_sources l JOIN public.sources_registry s ON (s.character_id,s.id) = (l.character_id,l.source_id)
      WHERE (l.character_id,l.memory_id) = (m.character_id,m.id)
    ),'[]'::jsonb),
    'corrections',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('revision',v.revision,'actorId',v.actor_id,'reason',v.reason,'createdAt',v.created_at)
        ORDER BY v.revision)
      FROM public.memory_corrections v WHERE (v.character_id,v.memory_id) = (m.character_id,m.id)
    ),'[]'::jsonb))
  FROM public.memories m WHERE (m.character_id,m.id) = (target_character,target_memory)
$fn$;

CREATE FUNCTION public.rica_correct_memory(target_character uuid,target_memory uuid,expected int,
  replacement text,operator text,rationale text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  m public.memories%ROWTYPE;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  SELECT * INTO m FROM public.memories WHERE (character_id,id) = (target_character,target_memory) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF m.revision <> expected THEN RETURN 'STALE'; END IF;
  IF m.status <> 'ACTIVE' OR (m.expires_at IS NOT NULL AND m.expires_at <= statement_timestamp())
    OR NOT EXISTS (SELECT 1 FROM public.memory_sources l WHERE (l.character_id,l.memory_id) = (target_character,target_memory))
    OR EXISTS (
      SELECT 1 FROM public.memory_sources l JOIN public.sources_registry s ON (s.character_id,s.id) = (l.character_id,l.source_id)
      WHERE (l.character_id,l.memory_id) = (target_character,target_memory) AND s.revoked_at IS NOT NULL
    ) THEN RETURN 'UNAVAILABLE'; END IF;

  UPDATE public.memories SET content = replacement, revision = revision+1,
    core_approved_at = CASE WHEN scope = 'CORE' THEN statement_timestamp() ELSE core_approved_at END
  WHERE (character_id,id) = (target_character,target_memory);
  WITH RECURSIVE changed(id) AS (
    SELECT target_memory UNION ALL
    SELECT child.id FROM public.memories child JOIN changed p ON child.parent_memory_id = p.id
    WHERE child.character_id = target_character
  ), cleared AS (
    UPDATE public.memories d SET status = 'REVOKED', content = ''
    FROM changed WHERE (d.character_id,d.id) = (target_character,changed.id) AND d.id <> target_memory
  )
  UPDATE public.memory_grants g SET revoked_at = statement_timestamp()
  FROM changed WHERE (g.character_id,g.memory_id) = (target_character,changed.id) AND g.revoked_at IS NULL;
  INSERT INTO public.memory_corrections (character_id,memory_id,revision,actor_id,reason)
  VALUES (target_character,target_memory,expected+1,operator,rationale);
  UPDATE public.characters SET auth_epoch = auth_epoch+1 WHERE id = target_character;
  RETURN 'UPDATED';
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_memory_provenance(uuid,uuid),
  public.rica_correct_memory(uuid,uuid,int,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_memory_provenance(uuid,uuid),
  public.rica_correct_memory(uuid,uuid,int,text,text,text) TO rica_admin_api;
COMMIT;
