BEGIN;

CREATE FUNCTION public.rica_remaining_belief_evidence(v public.belief_versions)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'supportingSources',count(*) FILTER (WHERE e.direction = 'SUPPORT' AND e.weight > 0),
    'opposingSources',count(*) FILTER (WHERE e.direction = 'OPPOSE' AND e.weight > 0),
    'confidence',0.5 + greatest(-0.2,least(0.2,0.1 * COALESCE(
      sum(CASE WHEN e.direction = 'SUPPORT' THEN e.weight ELSE -e.weight END),0))))
  FROM public.belief_evidence e
  WHERE (e.character_id,e.identity_id,e.belief_id,e.version) = (v.character_id,v.identity_id,v.belief_id,v.version)
    AND e.source_id = public.rica_belief_source(e.character_id,e.identity_id,e.memory_id,e.memory_revision)
$fn$;

REVOKE ALL ON FUNCTION public.rica_remaining_belief_evidence(public.belief_versions) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rica_read_belief(target_character uuid,target_identity uuid,target_belief uuid,requested_version int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',v.belief_id,'identityId',v.identity_id,'version',v.version,'kind',v.kind,
    'status',CASE WHEN validity.ok THEN v.status ELSE 'INVALIDATED' END,
    'remainingEvidence',CASE WHEN NOT validity.ok THEN public.rica_remaining_belief_evidence(v) END,
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

COMMIT;
