BEGIN;

ALTER TABLE public.agent_runs ADD COLUMN references_expired_at timestamptz;
ALTER TABLE public.inbound_events
  ADD COLUMN body_expired_at timestamptz,
  DROP CONSTRAINT inbound_events_adapter_pair,
  ADD CONSTRAINT inbound_events_adapter_pair CHECK (
    (adapter_id IS NULL AND adapter_version IS NULL)
    OR (adapter_id IN ('mock-a','mock-b') AND adapter_id IS NOT NULL
      AND adapter_version IS NOT NULL AND adapter_version <> ''
      AND (message_text IS NOT NULL OR body_expired_at IS NOT NULL))
  ),
  ADD CONSTRAINT inbound_events_expired_body_absent CHECK (body_expired_at IS NULL OR message_text IS NULL);

CREATE FUNCTION public.rica_sweep_simulation_retention()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  target uuid;
  observed_at timestamptz := statement_timestamp();
  body_cutoff timestamptz := observed_at - interval '720 hours';
  reference_cutoff timestamptz := observed_at - interval '2160 hours';
  compacted uuid[];
  changed int;
  total int := 0;
BEGIN
  -- Match the character lock used by drafting, approval, and the receipt writer.
  SELECT c.id INTO target FROM public.characters c
  WHERE EXISTS (
    SELECT 1 FROM public.inbound_events e JOIN public.agent_runs r ON r.inbound_event_id = e.id
    WHERE e.character_id = c.id AND r.mode = 'SIMULATION' AND e.received_at <= body_cutoff AND e.message_text IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.simulated_drafts d JOIN public.agent_runs r ON (r.character_id,r.id) = (d.character_id,d.run_id)
    WHERE d.character_id = c.id AND r.mode = 'SIMULATION' AND d.created_at <= body_cutoff AND d.content IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.agent_runs r WHERE r.character_id = c.id AND r.mode = 'SIMULATION'
      AND r.created_at <= reference_cutoff AND r.references_expired_at IS NULL
  )
  ORDER BY c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;

  UPDATE public.inbound_events SET message_text = NULL,body_expired_at = observed_at WHERE id IN (
    SELECT e.id FROM public.inbound_events e JOIN public.agent_runs r ON r.inbound_event_id = e.id
    WHERE e.character_id = target AND r.mode = 'SIMULATION' AND e.received_at <= body_cutoff AND e.message_text IS NOT NULL
    ORDER BY e.received_at,e.id LIMIT 50
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  total := total + changed;

  UPDATE public.simulated_drafts SET content = NULL WHERE character_id = target AND run_id IN (
    SELECT d.run_id FROM public.simulated_drafts d JOIN public.agent_runs r ON (r.character_id,r.id) = (d.character_id,d.run_id)
    WHERE d.character_id = target AND r.mode = 'SIMULATION' AND d.created_at <= body_cutoff AND d.content IS NOT NULL
    ORDER BY d.created_at,d.run_id LIMIT 50
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  total := total + changed;

  SELECT ARRAY(
    SELECT r.id FROM public.agent_runs r WHERE r.character_id = target AND r.mode = 'SIMULATION'
      AND r.created_at <= reference_cutoff AND r.references_expired_at IS NULL
    ORDER BY r.created_at,r.id LIMIT 50
  ) INTO compacted;
  DELETE FROM public.context_snapshot_evidence e USING public.context_snapshots s
    WHERE (e.character_id,e.snapshot_id) = (s.character_id,s.id)
      AND s.character_id = target AND s.run_id = ANY(compacted);
  DELETE FROM public.context_snapshots WHERE character_id = target AND run_id = ANY(compacted);
  UPDATE public.simulated_drafts SET decision_evidence_ids = '{}', writing_evidence_ids = '{}',
    citation_ids = '{}', belief_refs = '[]' WHERE character_id = target AND run_id = ANY(compacted);
  UPDATE public.agent_runs SET references_expired_at = observed_at,goal_refs = '[]',
    state = CASE WHEN state IN ('QUEUED','CONTEXT_READY','DRAFTED','WAITING_APPROVAL','READY') THEN 'EXPIRED' ELSE state END,
    state_version = state_version + CASE WHEN state IN ('QUEUED','CONTEXT_READY','DRAFTED','WAITING_APPROVAL','READY') THEN 1 ELSE 0 END
    WHERE character_id = target AND id = ANY(compacted);

  RETURN total + cardinality(compacted);
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_sweep_simulation_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_sweep_simulation_retention() TO rica_runtime;

CREATE OR REPLACE FUNCTION public.rica_replay_run_with_time(target_character uuid,target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_replay_simulation_run(target_character,target_run)
    || jsonb_build_object('contextTimezone',r.context_timezone,'goalRefs',r.goal_refs,
      'referencesExpiredAt',r.references_expired_at,'beliefRefs',COALESCE(d.belief_refs,'[]'::jsonb))
    || CASE WHEN r.references_expired_at IS NOT NULL THEN jsonb_build_object('schedule',NULL) ELSE '{}'::jsonb END
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
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND e.message_text IS NOT NULL
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
