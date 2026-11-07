BEGIN;

ALTER TABLE public.simulated_drafts ADD COLUMN belief_refs jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(belief_refs) = 'array' AND jsonb_array_length(belief_refs) <= 8);

CREATE FUNCTION public.rica_formal_beliefs(target_character uuid,target_identity uuid)
RETURNS SETOF public.belief_versions
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT DISTINCT ON (v.belief_id) v.*
  FROM public.belief_versions v
  WHERE (v.character_id,v.identity_id) = (target_character,target_identity) AND v.status = 'ACTIVE'
  ORDER BY v.belief_id,v.version DESC
$fn$;

CREATE FUNCTION public.rica_run_beliefs(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',v.belief_id,'version',v.version,'kind',v.kind,'statement',v.statement,
    'confidence',v.confidence,'subjective',true
  ) ORDER BY v.confidence DESC,v.belief_id),'[]'::jsonb)
  FROM (
    SELECT b.* FROM public.agent_runs r
    CROSS JOIN LATERAL public.rica_formal_beliefs(r.character_id,r.identity_id) b
    WHERE r.id = target_run AND r.state = 'CONTEXT_READY'
      AND public.rica_simulated_review_target(r.id) IS NOT NULL
      AND public.rica_belief_evidence_valid(b)
    ORDER BY b.confidence DESC,b.belief_id LIMIT 8
  ) v
$fn$;

CREATE FUNCTION public.rica_belief_refs_valid(target_character uuid,target_identity uuid,refs jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(refs) AS ref(id uuid,version int)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rica_formal_beliefs(target_character,target_identity) b
      WHERE (b.belief_id,b.version) = (ref.id,ref.version) AND public.rica_belief_evidence_valid(b)
    )
  )
$fn$;

REVOKE ALL ON FUNCTION public.rica_formal_beliefs(uuid,uuid),public.rica_run_beliefs(uuid),
  public.rica_belief_refs_valid(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_run_beliefs(uuid) TO rica_runtime;

CREATE OR REPLACE FUNCTION public.rica_replay_run_with_time(target_character uuid,target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_replay_simulation_run(target_character,target_run)
    || jsonb_build_object('contextTimezone',r.context_timezone,'goalRefs',r.goal_refs,
      'beliefRefs',COALESCE(d.belief_refs,'[]'::jsonb))
  FROM public.agent_runs r LEFT JOIN public.simulated_drafts d ON (d.character_id,d.run_id) = (r.character_id,r.id)
  WHERE (r.character_id,r.id) = (target_character,target_run)
$fn$;

CREATE OR REPLACE FUNCTION public.rica_simulated_review_target(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'platform', a.platform, 'instance', a.instance_key, 'accountId', a.id,
    'account', a.remote_account_id, 'identity', i.slug, 'identityId', i.id,
    'conversationId', t.id, 'conversation', t.remote_key, 'audience', t.channel,
    'contactId', p.id, 'contact', p.remote_key, 'message', e.source_key
  )
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
  JOIN public.inbound_events e ON e.id = r.inbound_event_id
  JOIN public.conversations t ON (t.character_id, t.identity_id, t.account_id, t.id)
    = (r.character_id, r.identity_id, r.account_id, e.conversation_id)
  LEFT JOIN public.contacts p ON (p.character_id, p.identity_id, p.account_id, p.id)
    = (r.character_id, r.identity_id, r.account_id, e.contact_id)
  WHERE r.id = target_run AND r.mode = 'SIMULATION'
    AND a.platform IN ('mock-a', 'mock-b') AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.core_version, r.identity_version, r.binding_version, r.auth_epoch)
      = (c.active_core_version, i.active_version, a.binding_version, c.auth_epoch)
    AND (t.channel = 'PUBLIC' OR t.private_contact_id = p.id)
    AND p.no_contact_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.simulated_drafts d
      WHERE (d.character_id,d.run_id) = (r.character_id,r.id)
        AND NOT public.rica_belief_refs_valid(r.character_id,r.identity_id,d.belief_refs)
    )
    AND (p.id IS NULL OR r.contact_boundary_version = p.boundary_version
      OR (r.contact_boundary_version IS NULL AND (p.boundary_changed_at IS NULL OR p.boundary_changed_at <= r.created_at)))
$fn$;

COMMIT;
