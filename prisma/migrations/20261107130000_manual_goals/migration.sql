BEGIN;
CREATE TABLE public.goal_versions (
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  version int NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','DONE','CANCELED','EXPIRED')),
  priority int NOT NULL CHECK (priority BETWEEN 0 AND 100),
  budget int NOT NULL CHECK (budget BETWEEN 1 AND 100),
  due_at timestamptz NOT NULL,
  next_step text,
  reason text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id,identity_id,goal_id,version),
  FOREIGN KEY (character_id,identity_id) REFERENCES public.identities(character_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
ALTER TABLE public.agent_runs ADD COLUMN goal_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE VIEW public.rica_current_goals AS
  SELECT DISTINCT ON (character_id,identity_id,goal_id) *
  FROM public.goal_versions ORDER BY character_id,identity_id,goal_id,version DESC;

CREATE FUNCTION public.rica_goal_json(g public.goal_versions)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',g.goal_id,'identityId',g.identity_id,'version',g.version,'origin','ADMIN',
    'title',g.title,'status',CASE WHEN g.due_at <= statement_timestamp() AND g.status IN ('DRAFT','ACTIVE','PAUSED')
      THEN 'EXPIRED' ELSE g.status END,
    'priority',g.priority,'budget',g.budget,'dueAt',g.due_at,'nextStep',g.next_step,'createdAt',g.created_at)
$fn$;

CREATE FUNCTION public.rica_read_manual_goals(target_character uuid,target_identity uuid,target_goal uuid,requested_version int)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN target_goal IS NULL THEN
    (SELECT COALESCE(jsonb_agg(public.rica_goal_json(v) ORDER BY g.goal_id), '[]'::jsonb)
      FROM public.rica_current_goals g JOIN public.goal_versions v USING (character_id,identity_id,goal_id,version)
      WHERE (g.character_id,g.identity_id) = (target_character,target_identity))
    ELSE
    (SELECT CASE WHEN requested_version IS NULL THEN public.rica_goal_json(g)
      ELSE jsonb_set(public.rica_goal_json(g),'{status}',to_jsonb(g.status)) END FROM public.goal_versions g
      WHERE (g.character_id,g.identity_id,g.goal_id) = (target_character,target_identity,target_goal)
        AND (requested_version IS NULL OR g.version = requested_version)
      ORDER BY g.version DESC LIMIT 1)
    END
  FROM public.identities i WHERE (i.character_id,i.id) = (target_character,target_identity)
$fn$;

CREATE FUNCTION public.rica_write_manual_goal(target_character uuid,target_identity uuid,target_goal uuid,expected int,
  configuration jsonb,operator text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  previous public.rica_current_goals%ROWTYPE;
  next_status text := configuration->>'status';
  deadline timestamptz := (configuration->>'dueAt')::timestamptz;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.identities WHERE (character_id,id) = (target_character,target_identity))
    THEN RETURN 'MISSING'; END IF;
  SELECT * INTO previous FROM public.rica_current_goals
  WHERE (character_id,identity_id,goal_id) = (target_character,target_identity,target_goal);
  IF expected > 0 AND NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF COALESCE(previous.version,0) <> expected THEN RETURN 'STALE'; END IF;
  IF previous.status IN ('DONE','CANCELED','EXPIRED')
    OR previous.due_at <= statement_timestamp()
    OR deadline <= statement_timestamp() THEN RETURN 'CLOSED'; END IF;

  IF next_status = 'ACTIVE' AND (SELECT count(*) FROM public.rica_current_goals g
    WHERE (g.character_id,g.identity_id) = (target_character,target_identity)
      AND g.goal_id <> target_goal AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()) >= 3
    THEN RETURN 'LIMIT'; END IF;

  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id)
  VALUES (target_character,target_identity,target_goal,expected+1,configuration->>'title',next_status,
    (configuration->>'priority')::int,(configuration->>'budget')::int,deadline,
    configuration->>'nextStep',configuration->>'reason',operator);
  UPDATE public.characters SET auth_epoch = auth_epoch+1 WHERE id = target_character;
  RETURN 'UPDATED';
END
$fn$;

CREATE OR REPLACE FUNCTION public.rica_pin_run_timezone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  SELECT COALESCE(NULLIF(v.role_profile->>'timezone',''),c.timezone) INTO NEW.context_timezone
  FROM public.characters c JOIN public.identity_versions v ON v.character_id = c.id
  WHERE (c.id,v.identity_id,v.version) = (NEW.character_id,NEW.identity_id,NEW.identity_version);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',g.goal_id,'version',g.version)
    ORDER BY g.priority DESC,g.goal_id),'[]'::jsonb) INTO NEW.goal_refs
  FROM public.rica_current_goals g
  WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.identity_id)
    AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp();
  RETURN NEW;
END
$fn$;

CREATE FUNCTION public.rica_run_goals(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE(jsonb_agg(public.rica_goal_json(v) ORDER BY refs.ordinality),'[]'::jsonb)
  FROM public.agent_runs r JOIN public.characters c ON c.id = r.character_id
  CROSS JOIN LATERAL jsonb_array_elements(r.goal_refs) WITH ORDINALITY refs(value,ordinality)
  JOIN public.rica_current_goals g ON (g.character_id,g.identity_id,g.goal_id,g.version)
    = (r.character_id,r.identity_id,(refs.value->>'id')::uuid,(refs.value->>'version')::int)
  JOIN public.goal_versions v ON (v.character_id,v.identity_id,v.goal_id,v.version)
    = (g.character_id,g.identity_id,g.goal_id,g.version)
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND r.auth_epoch = c.auth_epoch
    AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()
$fn$;

CREATE OR REPLACE FUNCTION public.rica_replay_run_with_time(target_character uuid,target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_replay_simulation_run(target_character,target_run)
    || jsonb_build_object('contextTimezone',r.context_timezone,'goalRefs',r.goal_refs)
  FROM public.agent_runs r WHERE (r.character_id,r.id) = (target_character,target_run)
$fn$;

REVOKE ALL ON FUNCTION public.rica_goal_json(public.goal_versions),
  public.rica_read_manual_goals(uuid,uuid,uuid,int),public.rica_write_manual_goal(uuid,uuid,uuid,int,jsonb,text),
  public.rica_run_goals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_read_manual_goals(uuid,uuid,uuid,int),
  public.rica_write_manual_goal(uuid,uuid,uuid,int,jsonb,text) TO rica_admin_api;
-- The only model-facing entry checks the full run binding in rica_run_continuity before loading goal references.
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
  WHERE p.no_contact_at IS NULL AND (p.boundary_changed_at IS NULL OR p.boundary_changed_at <= run.created_at)
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

ALTER TABLE public.context_snapshots DROP CONSTRAINT context_snapshots_audience_matches_purpose;
ALTER TABLE public.context_snapshots ADD CONSTRAINT context_snapshots_audience_matches_purpose CHECK (
  (purpose = 'PUBLIC_REFERENCE' AND btrim(audience_key) <> '')
  OR (purpose <> 'PUBLIC_REFERENCE' AND audience_key = '')
  OR (purpose = 'INTERNAL_CONTEXT' AND audience_key = 'self-model.v1')
);

CREATE OR REPLACE FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET rica.memory_scope = '' AS $fn$
DECLARE
  candidate record;
  evidence record;
BEGIN
  SELECT r.id AS run_id, r.character_id, r.identity_id, r.account_id, a.target, d.content,
    d.decision_evidence_ids, d.writing_evidence_ids
  INTO candidate
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.simulated_drafts d ON (d.character_id, d.run_id) = (a.character_id, a.run_id)
  WHERE (a.character_id, a.id) = (target_character, target_action)
    AND r.state::text IN ('WAITING_APPROVAL', 'READY')
    AND a.expires_at > statement_timestamp()
    AND a.target = public.rica_simulated_review_target(r.id)
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
          AND se.memory_id = used.memory_id AND public.rica_memory_allowed(m)
      )
    ) THEN RETURN NULL; END IF;
  END LOOP;
  RETURN candidate.content;
END
$fn$;

COMMIT;
