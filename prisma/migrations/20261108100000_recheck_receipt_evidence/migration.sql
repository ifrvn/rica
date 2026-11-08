BEGIN;

CREATE FUNCTION public.rica_memory_allowed_at(m public.memories, checked_at timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  s record;
  native boolean;
  grant_eligible boolean;
BEGIN
  SELECT * INTO s FROM public.rica_memory_scope();
  IF NOT COALESCE(
    m.character_id = s.character_id AND s.identity_id IS NOT NULL AND s.account_id IS NOT NULL
    AND m.status = 'ACTIVE' AND m.visibility <> 'RESTRICTED'
    AND (m.scope <> 'CONVERSATION' OR m.conversation_id = s.conversation_id)
    AND (m.expires_at IS NULL OR m.expires_at > checked_at),
    false
  ) THEN
    RETURN false;
  END IF;

  native := s.purpose IN ('INTERNAL_CONTEXT', 'DECISION_SUPPORT') AND (
    m.scope = 'CORE'
    OR (m.scope = 'IDENTITY' AND m.identity_id = s.identity_id)
    OR (m.scope = 'ACCOUNT' AND m.account_id = s.account_id)
    OR (m.scope = 'CONVERSATION' AND m.conversation_id = s.conversation_id)
  );
  IF native IS NOT TRUE THEN
    grant_eligible := (s.purpose IN ('INTERNAL_CONTEXT', 'DECISION_SUPPORT') AND m.visibility IN ('PUBLIC', 'PERSONAL'))
      OR (s.purpose = 'PUBLIC_REFERENCE' AND s.channel IS DISTINCT FROM 'PRIVATE' AND m.visibility = 'PUBLIC')
      OR (s.purpose = 'PRIVATE_REPLY' AND s.channel = 'PRIVATE' AND s.contact_id IS NOT NULL
          AND m.visibility IN ('PUBLIC', 'PERSONAL'));
    IF grant_eligible IS NOT TRUE OR NOT EXISTS (
      SELECT 1 FROM public.memory_grants g
      WHERE g.character_id = m.character_id AND g.memory_id = m.id
        AND g.recipient_identity_id = s.identity_id
        AND (g.recipient_account_id IS NULL OR g.recipient_account_id = s.account_id)
        AND g.purpose::text = s.purpose AND g.audience IS NOT DISTINCT FROM s.audience
        AND (g.purpose <> 'PRIVATE_REPLY' OR (
          g.recipient_conversation_id = s.conversation_id AND g.recipient_contact_id = s.contact_id
        ))
        AND g.valid_from <= checked_at AND g.valid_until > checked_at
        AND g.revoked_at IS NULL
    ) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN (
    SELECT count(*) > 0 AND NOT COALESCE(bool_or(
        source.revoked_at IS NOT NULL OR source.classification = 'RESTRICTED'
        OR (source.conversation_id IS NOT NULL AND source.conversation_id IS DISTINCT FROM s.conversation_id)
        OR (s.purpose = 'PRIVATE_REPLY' AND source.classification = 'CONFIDENTIAL')
        OR (source.classification <> 'PUBLIC' AND (
          m.scope = 'CORE' OR s.purpose = 'PUBLIC_REFERENCE'
          OR source.identity_id IS DISTINCT FROM s.identity_id
          OR (source.account_id IS NOT NULL AND source.account_id <> s.account_id)
        ))
    ), false)
    FROM public.memory_sources ms
    JOIN public.sources_registry source ON (source.character_id, source.id) = (ms.character_id, ms.source_id)
    WHERE (ms.character_id, ms.memory_id) = (m.character_id, m.id)
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_memory_allowed_at(public.memories, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_memory_allowed_at(public.memories, timestamptz) TO rica_memory_reader;

CREATE OR REPLACE FUNCTION public.rica_memory_allowed(m public.memories) RETURNS boolean
LANGUAGE sql STABLE
RETURN public.rica_memory_allowed_at(m, pg_catalog.statement_timestamp());

CREATE FUNCTION public.rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
SET rica.memory_scope = '' AS $fn$
DECLARE
  candidate record;
  evidence record;
  checked_at timestamptz := CASE WHEN writing_receipt THEN clock_timestamp() ELSE statement_timestamp() END;
BEGIN
  SELECT r.id AS run_id, r.character_id, r.identity_id, r.account_id, a.target, d.content,
    d.decision_evidence_ids, d.writing_evidence_ids
  INTO candidate
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.simulated_drafts d ON (d.character_id, d.run_id) = (a.character_id, a.run_id)
  WHERE (a.character_id, a.id) = (target_character, target_action)
    AND ((writing_receipt AND r.state = 'EXECUTING') OR (NOT writing_receipt AND r.state IN ('WAITING_APPROVAL', 'READY')))
    AND a.expires_at > checked_at
    AND a.target = public.rica_simulated_review_target(r.id)
    -- The target validates belief revisions. Check their expiry at the post-lock receipt clock as well.
    AND (NOT writing_receipt OR NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(d.belief_refs) AS ref(id uuid,version int)
      JOIN public.belief_evidence e ON (e.character_id,e.identity_id,e.belief_id,e.version)
        = (r.character_id,r.identity_id,ref.id,ref.version)
      JOIN public.memories m ON (m.character_id,m.id) = (e.character_id,e.memory_id)
      WHERE m.expires_at <= checked_at
    ))
    AND a.payload_hash = encode(sha256(convert_to(d.content, 'UTF8')), 'hex');

  IF NOT FOUND THEN RETURN NULL; END IF;

  FOR evidence IN
    SELECT 'DECISION_SUPPORT'::text AS purpose, ''::text AS audience_key, candidate.decision_evidence_ids AS ids
    UNION ALL
    SELECT CASE WHEN candidate.target->>'audience' = 'PRIVATE' THEN 'PRIVATE_REPLY' ELSE 'PUBLIC_REFERENCE' END,
      CASE WHEN candidate.target->>'audience' = 'PRIVATE' THEN '' ELSE candidate.target->>'conversationId' END,
      candidate.writing_evidence_ids
    UNION ALL
    SELECT 'INTERNAL_CONTEXT'::text, 'self-model.v1'::text, ARRAY(
      SELECT se.memory_id FROM public.context_snapshots s JOIN public.context_snapshot_evidence se
        ON (s.character_id,s.id) = (se.character_id,se.snapshot_id)
      WHERE (s.character_id,s.run_id,s.purpose::text,s.audience_key)
        = (candidate.character_id,candidate.run_id,'INTERNAL_CONTEXT','self-model.v1')
    )
  LOOP
    PERFORM set_config('rica.memory_scope', jsonb_build_object(
      'character_id', candidate.character_id, 'identity_id', candidate.identity_id, 'account_id', candidate.account_id,
      'conversation_id', candidate.target->>'conversationId', 'contact_id', candidate.target->>'contactId',
      'channel', candidate.target->>'audience', 'purpose', evidence.purpose, 'audience', NULLIF(evidence.audience_key, '')
    )::text, true);
    IF EXISTS (
      SELECT 1 FROM unnest(evidence.ids) AS used(memory_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.context_snapshots s
        JOIN public.context_snapshot_evidence se ON (se.character_id, se.snapshot_id) = (s.character_id, s.id)
        JOIN public.memories m ON (m.character_id, m.id, m.revision) = (se.character_id, se.memory_id, se.memory_revision)
        WHERE (s.character_id, s.run_id, s.purpose::text, s.audience_key)
          = (candidate.character_id, candidate.run_id, evidence.purpose, evidence.audience_key)
          AND se.memory_id = used.memory_id AND public.rica_memory_allowed_at(m, checked_at)
      )
    ) THEN RETURN NULL; END IF;
  END LOOP;
  RETURN candidate.content;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_bound_simulation_payload(uuid, uuid, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
RETURN public.rica_bound_simulation_payload(target_character, target_action, false);

CREATE OR REPLACE FUNCTION public.rica_record_simulation_receipt(target_action uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  PERFORM 1 FROM public.characters c
  JOIN public.simulation_attempts s ON s.character_id = c.id
  WHERE s.action_id = target_action FOR SHARE OF c;

  -- Serialize the final local side effect with a concurrent inbound opt-out.
  PERFORM p.id FROM public.contacts p
  JOIN public.simulation_attempts s
    ON (p.character_id,p.account_id,p.id) = (s.character_id,s.account_id,s.contact_id)
  WHERE s.action_id = target_action FOR SHARE OF p;

  INSERT INTO public.simulation_receipts (character_id, action_id)
  SELECT s.character_id, s.action_id
  FROM public.simulation_attempts s
  JOIN public.action_proposals a ON (a.character_id, a.id) = (s.character_id, s.action_id)
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  WHERE s.action_id = target_action AND s.status = 'PERMITTED' AND s.permit_until > clock_timestamp()
    AND r.mode = 'SIMULATION' AND r.state::text = 'EXECUTING'
    AND public.rica_bound_simulation_payload(s.character_id, s.action_id, true) IS NOT NULL
  FOR SHARE OF s
  ON CONFLICT (action_id) DO NOTHING;

  RETURN EXISTS (SELECT 1 FROM public.simulation_receipts WHERE action_id = target_action);
END
$fn$;

COMMIT;
