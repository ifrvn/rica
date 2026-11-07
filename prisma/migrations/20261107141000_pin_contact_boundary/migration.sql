BEGIN;

ALTER TABLE public.agent_runs ADD COLUMN contact_boundary_version int;

CREATE FUNCTION public.rica_pin_run_contact_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  SELECT p.boundary_version INTO NEW.contact_boundary_version
  FROM public.inbound_events e
  JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id,p.id)
    = (e.character_id,e.identity_id,e.account_id,e.contact_id)
  WHERE (e.character_id,e.identity_id,e.account_id,e.id)
    = (NEW.character_id,NEW.identity_id,NEW.account_id,NEW.inbound_event_id);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_pin_run_contact_boundary() FROM PUBLIC;
CREATE TRIGGER pin_run_contact_boundary BEFORE INSERT ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.rica_pin_run_contact_boundary();
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
    AND (p.id IS NULL OR r.contact_boundary_version = p.boundary_version
      OR (r.contact_boundary_version IS NULL AND (p.boundary_changed_at IS NULL OR p.boundary_changed_at <= r.created_at)))
$fn$;

CREATE OR REPLACE FUNCTION public.rica_run_continuity(target_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET rica.memory_scope = '' AS $fn$
DECLARE
  r record;
  facts jsonb;
  history jsonb;
  due_at timestamptz;
  next_at timestamptz;
BEGIN
  SELECT run.*, e.occurred_at, e.conversation_id, e.contact_id, c.timezone, core.hard_profile,
    a.platform, a.instance_key, p.no_contact_at, p.boundary_changed_at
  INTO r
  FROM public.agent_runs run
  JOIN public.inbound_events e ON e.id = run.inbound_event_id
  JOIN public.characters c ON c.id = run.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (run.character_id,run.identity_id)
  JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (run.character_id,run.identity_id,run.account_id)
  JOIN public.core_versions core ON (core.character_id,core.version) = (run.character_id,run.core_version)
  LEFT JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id,p.id) = (run.character_id,run.identity_id,run.account_id,e.contact_id)
  WHERE p.no_contact_at IS NULL AND (p.id IS NULL OR run.contact_boundary_version = p.boundary_version
    OR (run.contact_boundary_version IS NULL AND (p.boundary_changed_at IS NULL OR p.boundary_changed_at <= run.created_at)))
    AND run.id = target_run AND run.mode = 'SIMULATION' AND run.state = 'CONTEXT_READY'
    AND (run.core_version,run.identity_version,run.binding_version,run.auth_epoch)
      = (c.active_core_version,i.active_version,a.binding_version,c.auth_epoch)
    AND c.status = 'ACTIVE' AND i.status = 'ACTIVE' AND a.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM set_config('rica.memory_scope', jsonb_build_object(
    'character_id',r.character_id, 'identity_id',r.identity_id, 'account_id',r.account_id,
    'purpose','INTERNAL_CONTEXT'
  )::text, true);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'revision',m.revision,'content',m.content)
    ORDER BY m.importance DESC,m.created_at DESC,m.id), '[]'::jsonb) INTO facts
  FROM (SELECT id,revision,content,importance,created_at FROM public.memories m
    WHERE m.character_id = r.character_id AND m.scope = 'CORE' AND m.core_approved_at <= r.created_at
      AND m.created_at <= r.created_at AND octet_length(m.content) BETWEEN 1 AND 350
      AND public.rica_memory_allowed(m)
    ORDER BY m.importance DESC,m.created_at DESC,m.id LIMIT 4) m;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',e.kind,'occurredAt',e.occurred_at)
    ORDER BY e.occurred_at DESC,e.id), '[]'::jsonb) INTO history
  FROM (SELECT id,kind,occurred_at FROM public.inbound_events e
    WHERE (e.character_id,e.identity_id,e.account_id) = (r.character_id,r.identity_id,r.account_id)
      AND e.conversation_id IS NOT DISTINCT FROM r.conversation_id
      AND e.contact_id IS NOT DISTINCT FROM r.contact_id
      AND e.id <> r.inbound_event_id AND e.received_at <= r.created_at AND e.occurred_at <= r.occurred_at
    ORDER BY e.occurred_at DESC,e.id LIMIT 5) e;

  SELECT min(c.due_at), min(s.next_at) FILTER (WHERE s.enabled)
  INTO due_at,next_at
  FROM public.simulation_schedules s
  LEFT JOIN public.simulation_commitments c ON (c.character_id,c.schedule_id) = (s.character_id,s.id)
    AND c.state IN ('OPEN','DEFERRED')
  WHERE (s.character_id,s.identity_id,s.account_id,s.conversation_id)
    = (r.character_id,r.identity_id,r.account_id,r.conversation_id)
    AND s.contact_id IS NOT DISTINCT FROM r.contact_id;

  RETURN jsonb_build_object('runId',r.id,'characterId',r.character_id,'identityId',r.identity_id,
    'accountId',r.account_id,'triggerId',r.inbound_event_id,'bindingVersion',r.binding_version,
    'mode',r.mode,'platform',r.platform,'instanceKey',r.instance_key,
    'conversationId',r.conversation_id,'contactId',r.contact_id,'occurredAt',r.occurred_at,
    'now',r.created_at,'timezone',COALESCE(r.context_timezone,r.timezone),
    'recent',history,'nextCommitmentAt',due_at,'nextScheduleAt',next_at,
    'goals',public.rica_run_goals(r.id),
    'relationship', CASE WHEN r.contact_id IS NOT NULL THEN (
      SELECT jsonb_build_object('confirmedInteractions',count(*),'lastConfirmedAt',max(receipt.created_at))
      FROM public.simulation_attempts attempt
      JOIN public.simulation_receipts receipt ON (receipt.character_id,receipt.action_id) = (attempt.character_id,attempt.action_id)
      WHERE (attempt.character_id,attempt.account_id,attempt.contact_id) = (r.character_id,r.account_id,r.contact_id)
        AND attempt.status = 'CONFIRMED' AND receipt.created_at <= r.created_at
    ) END,
    'self',jsonb_build_object('coreVersion',r.core_version,'name',r.hard_profile->'name',
      'fictionalBackground',r.hard_profile->'fictionalBackground','facts',facts));
END
$fn$;

COMMIT;
