BEGIN;

CREATE FUNCTION public.rica_replay_simulation_run(target_character uuid, target_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET rica.memory_scope = '' AS $fn$
DECLARE
  bound record;
  snapshot record;
  evidence jsonb;
  snapshots jsonb := '[]'::jsonb;
  proposal jsonb;
  trigger_info jsonb;
BEGIN
  SELECT r.*, e.conversation_id, e.contact_id, e.occurred_at, t.channel,
    (c.status = 'ACTIVE' AND i.status = 'ACTIVE' AND a.status = 'ACTIVE'
      AND a.platform IN ('mock-a', 'mock-b') AND r.state <> 'CANCELED'
      AND (r.core_version, r.identity_version, r.binding_version, r.auth_epoch)
        = (c.active_core_version, i.active_version, a.binding_version, c.auth_epoch)
      AND (e.conversation_id IS NULL OR t.channel = 'PUBLIC' OR t.private_contact_id = e.contact_id)
    ) IS TRUE AS current_binding
  INTO bound
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
  JOIN public.inbound_events e ON e.id = r.inbound_event_id
  LEFT JOIN public.conversations t ON (t.character_id, t.identity_id, t.account_id, t.id)
    = (r.character_id, r.identity_id, r.account_id, e.conversation_id)
  WHERE (r.character_id, r.id) = (target_character, target_run) AND r.mode = 'SIMULATION';
  IF NOT FOUND THEN RETURN NULL; END IF;

  FOR snapshot IN
    SELECT s.id, s.purpose, s.audience_key, s.ranking_version, s.created_at
    FROM public.context_snapshots s
    WHERE (s.character_id, s.run_id) = (target_character, target_run)
    ORDER BY s.created_at, s.id
  LOOP
    PERFORM set_config('rica.memory_scope', jsonb_build_object(
      'character_id', bound.character_id, 'identity_id', bound.identity_id, 'account_id', bound.account_id,
      'conversation_id', bound.conversation_id, 'contact_id', bound.contact_id, 'channel', bound.channel,
      'purpose', snapshot.purpose, 'audience', NULLIF(snapshot.audience_key, '')
    )::text, true);
    SELECT COALESCE(jsonb_agg(
      CASE WHEN bound.current_binding AND m.revision = se.memory_revision AND public.rica_memory_allowed(m)
        THEN jsonb_build_object('rank', se.rank, 'available', true, 'memoryId', se.memory_id, 'revision', se.memory_revision)
        ELSE jsonb_build_object('rank', se.rank, 'available', false)
      END ORDER BY se.rank
    ), '[]'::jsonb)
    INTO evidence
    FROM public.context_snapshot_evidence se
    LEFT JOIN public.memories m ON (m.character_id, m.id) = (se.character_id, se.memory_id)
    WHERE (se.character_id, se.snapshot_id) = (target_character, snapshot.id);
    snapshots := snapshots || jsonb_build_array(jsonb_build_object(
      'id', snapshot.id, 'purpose', snapshot.purpose, 'rankingVersion', snapshot.ranking_version,
      'createdAt', snapshot.created_at, 'evidence', evidence
    ));
  END LOOP;

  SELECT jsonb_build_object('id', a.id, 'policyVersion', a.policy_version, 'adapterVersion', a.adapter_version,
    'modelId', d.model_id, 'modelVersion', d.model_version,
    'reviewDecision', approval.decision, 'attemptStatus', attempt.status, 'receiptAt', receipt.created_at)
  INTO proposal
  FROM public.action_proposals a
  JOIN public.simulated_drafts d ON (d.character_id, d.run_id) = (a.character_id, a.run_id)
  LEFT JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
  LEFT JOIN public.simulation_attempts attempt ON (attempt.character_id, attempt.action_id) = (a.character_id, a.id)
  LEFT JOIN public.simulation_receipts receipt ON (receipt.character_id, receipt.action_id) = (a.character_id, a.id)
  WHERE (a.character_id, a.run_id) = (target_character, target_run);

  SELECT jsonb_build_object('scheduleId', o.schedule_id, 'scheduleVersion', o.schedule_version,
    'scheduledAt', o.scheduled_at, 'commitmentId', c.id)
  INTO trigger_info
  FROM public.schedule_occurrences o
  LEFT JOIN public.simulation_commitments c ON (c.character_id, c.schedule_id) = (o.character_id, o.schedule_id)
  WHERE (o.character_id, o.run_id) = (target_character, target_run);

  RETURN jsonb_build_object(
    'id', bound.id, 'state', bound.state, 'stateVersion', bound.state_version, 'stateReason', bound.state_reason,
    'mode', bound.mode, 'identityId', bound.identity_id, 'accountId', bound.account_id,
    'coreVersion', bound.core_version, 'identityVersion', bound.identity_version, 'bindingVersion', bound.binding_version,
    'authEpoch', bound.auth_epoch, 'occurredAt', bound.occurred_at, 'createdAt', bound.created_at,
    'snapshots', snapshots, 'proposal', proposal, 'schedule', trigger_info
  );
END
$fn$;

CREATE FUNCTION public.rica_simulation_backlog(target_character uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'observedAt', statement_timestamp(),
    'outbox', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(o.created_at),
        'enqueued', count(*) FILTER (WHERE o.enqueued_at IS NOT NULL))
      FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
      WHERE r.character_id = target_character AND r.mode = 'SIMULATION' AND o.processed_at IS NULL
    ),
    'approvals', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(a.created_at))
      FROM public.action_proposals a JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
      WHERE a.character_id = target_character AND r.mode = 'SIMULATION' AND r.state = 'WAITING_APPROVAL'
        AND a.expires_at > statement_timestamp()
    ),
    'reconciliation', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(s.permit_until))
      FROM public.simulation_attempts s
      WHERE s.character_id = target_character AND s.status = 'UNKNOWN'
    ),
    'schedules', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(s.next_at))
      FROM public.simulation_schedules s
      WHERE s.character_id = target_character AND s.enabled AND s.next_at <= statement_timestamp()
    )
  )
$fn$;

REVOKE ALL ON FUNCTION public.rica_replay_simulation_run(uuid, uuid),
  public.rica_simulation_backlog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_replay_simulation_run(uuid, uuid),
  public.rica_simulation_backlog(uuid) TO rica_admin_api;

COMMIT;
