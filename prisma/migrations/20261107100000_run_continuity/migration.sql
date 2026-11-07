BEGIN;

ALTER TABLE public.agent_runs ADD COLUMN context_timezone text;
CREATE INDEX inbound_context_history_idx ON public.inbound_events
  (character_id, identity_id, account_id, conversation_id, contact_id, occurred_at, id);

CREATE FUNCTION public.rica_pin_run_timezone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  SELECT COALESCE(NULLIF(v.role_profile->>'timezone', ''), c.timezone)
  INTO NEW.context_timezone
  FROM public.characters c
  JOIN public.identity_versions v ON v.character_id = c.id
  WHERE (c.id, v.identity_id, v.version) = (NEW.character_id, NEW.identity_id, NEW.identity_version);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_pin_run_timezone() FROM PUBLIC;
CREATE TRIGGER pin_run_timezone BEFORE INSERT ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.rica_pin_run_timezone();

CREATE FUNCTION public.rica_run_continuity(target_run uuid)
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
    a.platform, a.instance_key
  INTO r
  FROM public.agent_runs run
  JOIN public.inbound_events e ON e.id = run.inbound_event_id
  JOIN public.characters c ON c.id = run.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (run.character_id,run.identity_id)
  JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (run.character_id,run.identity_id,run.account_id)
  JOIN public.core_versions core ON (core.character_id,core.version) = (run.character_id,run.core_version)
  WHERE run.id = target_run AND run.mode = 'SIMULATION' AND run.state = 'CONTEXT_READY'
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
      AND m.created_at <= r.created_at AND octet_length(m.content) BETWEEN 1 AND 1500
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
    'self',jsonb_build_object('coreVersion',r.core_version,'name',r.hard_profile->'name',
      'fictionalBackground',r.hard_profile->'fictionalBackground','facts',facts));
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_run_continuity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_run_continuity(uuid) TO rica_runtime;

CREATE FUNCTION public.rica_replay_run_with_time(target_character uuid,target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_replay_simulation_run(target_character,target_run)
    || jsonb_build_object('contextTimezone',r.context_timezone)
  FROM public.agent_runs r WHERE (r.character_id,r.id) = (target_character,target_run)
$fn$;
REVOKE ALL ON FUNCTION public.rica_replay_run_with_time(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_replay_run_with_time(uuid,uuid) TO rica_admin_api;
COMMIT;
