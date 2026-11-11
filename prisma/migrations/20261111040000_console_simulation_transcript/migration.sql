BEGIN;

CREATE FUNCTION public.rica_validate_simulation_payload(target_character uuid, target_action uuid, access_mode text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "rica.memory_scope" TO ''
    AS $$
DECLARE
  candidate record;
  evidence record;
  checked_at timestamptz := CASE WHEN access_mode = 'RECEIPT' THEN clock_timestamp() ELSE statement_timestamp() END;
BEGIN
  SELECT r.id AS run_id, r.character_id, r.identity_id, r.account_id, a.target, d.content,
    d.decision_evidence_ids, d.writing_evidence_ids
  INTO candidate
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.simulated_drafts d ON (d.character_id, d.run_id) = (a.character_id, a.run_id)
  WHERE (a.character_id, a.id) = (target_character, target_action)
    AND (
      (access_mode = 'RECEIPT' AND r.state = 'EXECUTING' AND a.expires_at > checked_at)
      OR (access_mode = 'REVIEW' AND r.state IN ('WAITING_APPROVAL', 'READY') AND a.expires_at > checked_at)
      OR (access_mode = 'REPLAY' AND r.state = 'SIMULATED' AND r.references_expired_at IS NULL
        AND d.created_at > checked_at - interval '720 hours')
    )
    AND a.target = public.rica_simulated_review_target(r.id)
    -- The target validates belief revisions. Check their expiry at the post-lock receipt clock as well.
    AND (access_mode <> 'RECEIPT' OR NOT EXISTS (
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
$$;

CREATE OR REPLACE FUNCTION public.rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean)
RETURNS text LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_validate_simulation_payload(target_character, target_action,
    CASE WHEN writing_receipt THEN 'RECEIPT' WHEN NOT writing_receipt THEN 'REVIEW' END)
$fn$;

CREATE FUNCTION public.rica_console_simulation_transcript(target_character uuid, target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('message', e.message_text,
    'draft', public.rica_validate_simulation_payload(r.character_id, proposal.id, 'REPLAY'),
    'reviewReason', approval.reason)
  FROM public.agent_runs r
  JOIN public.inbound_events e ON (e.character_id, e.identity_id, e.account_id, e.id)
    = (r.character_id, r.identity_id, r.account_id, r.inbound_event_id)
  JOIN public.conversations conversation ON (conversation.character_id, conversation.identity_id, conversation.account_id, conversation.id)
    = (e.character_id, e.identity_id, e.account_id, e.conversation_id)
  JOIN public.action_proposals proposal ON (proposal.character_id, proposal.run_id) = (r.character_id, r.id)
  JOIN public.action_approvals approval ON (approval.character_id, approval.action_id, approval.review_digest)
    = (proposal.character_id, proposal.id, proposal.review_digest)
  CROSS JOIN LATERAL public.rica_confirmed_commitment_scope(r.character_id, proposal.id) scope
  WHERE (r.character_id, r.id) = (target_character, target_run) AND r.mode = 'SIMULATION' AND r.state = 'SIMULATED'
    AND approval.decision = 'APPROVE' AND conversation.channel = 'PUBLIC'
    AND e.source_key = conversation.remote_key AND e.source_key = 'console:' || conversation.id
    AND e.message_text IS NOT NULL AND e.received_at > statement_timestamp() - interval '720 hours'
    AND proposal.target = public.rica_simulated_review_target(r.id)
$fn$;

REVOKE ALL ON FUNCTION public.rica_validate_simulation_payload(uuid, uuid, text),
  public.rica_console_simulation_transcript(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_console_simulation_transcript(uuid, uuid) TO rica_admin_api;

COMMIT;
