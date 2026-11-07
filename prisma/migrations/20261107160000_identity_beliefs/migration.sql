BEGIN;

CREATE TABLE public.belief_versions (
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  belief_id uuid NOT NULL,
  version int NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('OPINION','PREFERENCE')),
  statement text NOT NULL CHECK (char_length(btrim(statement)) BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','DISPUTED')),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason text NOT NULL,
  actor_id text NOT NULL,
  restored_from int CHECK (restored_from > 0 AND restored_from < version),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id,identity_id,belief_id,version),
  FOREIGN KEY (character_id,identity_id) REFERENCES public.identities(character_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE public.belief_evidence (
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  belief_id uuid NOT NULL,
  version int NOT NULL,
  source_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  memory_revision int NOT NULL CHECK (memory_revision > 0),
  direction text NOT NULL CHECK (direction IN ('SUPPORT','OPPOSE')),
  weight double precision NOT NULL CHECK (weight BETWEEN 0 AND 1),
  PRIMARY KEY (character_id,identity_id,belief_id,version,source_id),
  FOREIGN KEY (character_id,identity_id,belief_id,version)
    REFERENCES public.belief_versions(character_id,identity_id,belief_id,version) ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY (character_id,memory_id,source_id)
    REFERENCES public.memory_sources(character_id,memory_id,source_id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX belief_evidence_character_id_memory_id_source_id_idx
  ON public.belief_evidence(character_id,memory_id,source_id);

-- Identity-wide opinions can only depend on native identity-wide records.
CREATE FUNCTION public.rica_belief_source(target_character uuid,target_identity uuid,target_memory uuid,expected int)
RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT s.id
  FROM public.memories m
  JOIN public.memory_sources ms ON (ms.character_id,ms.memory_id) = (m.character_id,m.id)
  JOIN public.sources_registry s ON (s.character_id,s.id) = (ms.character_id,ms.source_id)
  WHERE (m.character_id,m.identity_id,m.id,m.revision) = (target_character,target_identity,target_memory,expected)
    AND m.scope = 'IDENTITY' AND m.status = 'ACTIVE' AND m.visibility IN ('PUBLIC','PERSONAL')
    AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
    AND s.identity_id = target_identity AND s.account_id IS NULL AND s.conversation_id IS NULL
    AND s.classification IN ('PUBLIC','PERSONAL') AND s.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.memory_sources other
      WHERE (other.character_id,other.memory_id) = (ms.character_id,ms.memory_id) AND other.source_id <> ms.source_id)
$fn$;

CREATE FUNCTION public.rica_belief_evidence_valid(v public.belief_versions)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.belief_evidence e
    WHERE (e.character_id,e.identity_id,e.belief_id,e.version) = (v.character_id,v.identity_id,v.belief_id,v.version)
      AND e.source_id IS DISTINCT FROM public.rica_belief_source(e.character_id,e.identity_id,e.memory_id,e.memory_revision)
  )
$fn$;

CREATE FUNCTION public.rica_read_belief(target_character uuid,target_identity uuid,target_belief uuid,requested_version int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',v.belief_id,'identityId',v.identity_id,'version',v.version,'kind',v.kind,
    'status',CASE WHEN validity.ok THEN v.status ELSE 'INVALIDATED' END,
    'statement',CASE WHEN validity.ok THEN v.statement END,'confidence',CASE WHEN validity.ok THEN v.confidence END,
    'reason',CASE WHEN validity.ok THEN v.reason END,'restoredFrom',v.restored_from,'createdAt',v.created_at,
    'evidence',CASE WHEN validity.ok THEN (SELECT jsonb_agg(jsonb_build_object(
      'sourceId',e.source_id,'memoryId',e.memory_id,'memoryRevision',e.memory_revision,'direction',e.direction,'weight',e.weight)
      ORDER BY e.source_id) FROM public.belief_evidence e
      WHERE (e.character_id,e.identity_id,e.belief_id,e.version) = (v.character_id,v.identity_id,v.belief_id,v.version))
      ELSE '[]'::jsonb END)
  FROM public.belief_versions v
  CROSS JOIN LATERAL (SELECT public.rica_belief_evidence_valid(v) AS ok) validity
  WHERE (v.character_id,v.identity_id,v.belief_id) = (target_character,target_identity,target_belief)
    AND (requested_version IS NULL OR v.version = requested_version)
  ORDER BY v.version DESC LIMIT 1
$fn$;

CREATE FUNCTION public.rica_write_belief(target_character uuid,target_identity uuid,target_belief uuid,expected int,
  configuration jsonb,operator text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  latest public.belief_versions%ROWTYPE;
  previous public.belief_versions%ROWTYPE;
  restore_version int := (configuration->>'restoreVersion')::int;
  next_kind text := configuration->>'kind';
  next_statement text := configuration->>'statement';
  next_status text;
  next_confidence double precision;
  evidence jsonb;
  source_count int;
  distinct_count int;
  support_count int;
  strong_support boolean;
  strong_opposition boolean;
  net double precision;
  prior_net double precision := 0;
  prior_confidence double precision := 0.5;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.identities WHERE (character_id,id) = (target_character,target_identity))
    THEN RETURN 'MISSING'; END IF;
  SELECT * INTO latest FROM public.belief_versions
    WHERE (character_id,identity_id,belief_id) = (target_character,target_identity,target_belief)
    ORDER BY version DESC LIMIT 1;
  IF expected > 0 AND NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF COALESCE(latest.version,0) <> expected THEN RETURN 'STALE'; END IF;

  IF restore_version IS NOT NULL THEN
    SELECT * INTO previous FROM public.belief_versions
      WHERE (character_id,identity_id,belief_id,version) = (target_character,target_identity,target_belief,restore_version);
    IF NOT FOUND OR restore_version >= expected OR previous.status <> 'ACTIVE'
      OR NOT public.rica_belief_evidence_valid(previous) THEN RETURN 'RESTORE_BLOCKED'; END IF;
    next_kind := previous.kind;
    next_statement := previous.statement;
    next_status := previous.status;
    next_confidence := previous.confidence;
    SELECT jsonb_agg(to_jsonb(e)) INTO evidence FROM public.belief_evidence e
      WHERE (e.character_id,e.identity_id,e.belief_id,e.version) =
        (target_character,target_identity,target_belief,restore_version);
  ELSE
    IF next_kind IS NULL OR next_kind NOT IN ('OPINION','PREFERENCE')
      OR (latest.kind IS NOT NULL AND latest.kind <> next_kind) THEN RETURN 'KIND'; END IF;
    WITH supplied AS (
      SELECT x."memoryId" AS memory_id,x."memoryRevision" AS memory_revision,x.direction,x.weight,
        public.rica_belief_source(target_character,target_identity,x."memoryId",x."memoryRevision") AS source_id
      FROM jsonb_to_recordset(configuration->'evidence')
        AS x("memoryId" uuid,"memoryRevision" int,direction text,weight double precision)
    )
    SELECT count(*),count(DISTINCT source_id),jsonb_agg(to_jsonb(supplied))
    INTO source_count,distinct_count,evidence
    FROM supplied;
    IF source_count NOT BETWEEN 1 AND 16 OR evidence IS NULL
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) item WHERE item->>'source_id' IS NULL)
      THEN RETURN 'EVIDENCE'; END IF;
    IF source_count <> distinct_count THEN RETURN 'DUPLICATE_SOURCE'; END IF;

    SELECT count(*) FILTER (WHERE direction = 'SUPPORT' AND weight > 0),
      bool_or(direction = 'SUPPORT' AND weight >= 0.8),bool_or(direction = 'OPPOSE' AND weight >= 0.8),
      sum(CASE WHEN direction = 'SUPPORT' THEN weight ELSE -weight END)
    INTO support_count,strong_support,strong_opposition,net
    FROM jsonb_to_recordset(evidence) AS e(direction text,weight double precision);

    SELECT * INTO previous FROM public.belief_versions
      WHERE (character_id,identity_id,belief_id) = (target_character,target_identity,target_belief)
        AND status = 'ACTIVE'
      ORDER BY version DESC LIMIT 1;
    prior_net := 0;
    IF FOUND AND public.rica_belief_evidence_valid(previous) THEN
      prior_confidence := previous.confidence;
      SELECT sum(CASE WHEN direction = 'SUPPORT' THEN weight ELSE -weight END) INTO prior_net
      FROM public.belief_evidence
      WHERE (character_id,identity_id,belief_id,version) =
        (target_character,target_identity,target_belief,previous.version);
    END IF;
    -- Recalculate from the complete evidence set, bounded by the previous formal revision.
    next_confidence := greatest(0,prior_confidence-0.2,least(1,prior_confidence+0.2,
      prior_confidence + 0.1 * (net - prior_net)));
    next_status := CASE WHEN strong_support AND strong_opposition THEN 'DISPUTED'
      WHEN support_count >= 2 AND next_confidence >= 0.65 THEN 'ACTIVE' ELSE 'PENDING' END;
  END IF;

  INSERT INTO public.belief_versions (character_id,identity_id,belief_id,version,kind,statement,status,confidence,
    reason,actor_id,restored_from)
  VALUES (target_character,target_identity,target_belief,expected+1,next_kind,next_statement,next_status,
    next_confidence,configuration->>'reason',operator,restore_version);
  INSERT INTO public.belief_evidence (character_id,identity_id,belief_id,version,source_id,memory_id,
    memory_revision,direction,weight)
  SELECT target_character,target_identity,target_belief,expected+1,e.source_id,e.memory_id,e.memory_revision,e.direction,e.weight
    FROM jsonb_to_recordset(evidence) AS e(source_id uuid,memory_id uuid,memory_revision int,direction text,weight double precision);
  RETURN next_status;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_belief_source(uuid,uuid,uuid,int),
  public.rica_belief_evidence_valid(public.belief_versions),public.rica_read_belief(uuid,uuid,uuid,int),
  public.rica_write_belief(uuid,uuid,uuid,int,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_read_belief(uuid,uuid,uuid,int),
  public.rica_write_belief(uuid,uuid,uuid,int,jsonb,text) TO rica_admin_api;

COMMIT;
