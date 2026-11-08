-- Rica development schema for a fresh PostgreSQL database.
BEGIN;
SET LOCAL check_function_bodies = false;

DO $roles$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'rica_runtime', 'rica_memory_reader', 'rica_memory_admin', 'rica_admin_api',
    'rica_simulation_executor', 'rica_newbi_executor', 'rica_newbi_poller'
  ]::name[] LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS', role_name);
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
        AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'Unexpected privileges on Rica group role %', role_name;
    END IF;
  END LOOP;
END
$roles$;

GRANT rica_memory_reader TO rica_runtime WITH INHERIT FALSE, SET TRUE;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: AccountStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AccountStatus" AS ENUM (
    'PENDING',
    'ACTIVE',
    'PAUSED',
    'REAUTH_REQUIRED',
    'REVOKED'
);


--
-- Name: CommitmentState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CommitmentState" AS ENUM (
    'OPEN',
    'DEFERRED',
    'FULFILLED',
    'CANCELED',
    'EXPIRED'
);


--
-- Name: ConversationChannel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ConversationChannel" AS ENUM (
    'PUBLIC',
    'PRIVATE'
);


--
-- Name: EntityStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."EntityStatus" AS ENUM (
    'ACTIVE',
    'PAUSED'
);


--
-- Name: InboundKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."InboundKind" AS ENUM (
    'POST',
    'REPLY',
    'MENTION'
);


--
-- Name: ManagementRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ManagementRole" AS ENUM (
    'ADMIN',
    'OPERATOR',
    'REVIEWER',
    'AUDITOR'
);


--
-- Name: MemoryPurpose; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MemoryPurpose" AS ENUM (
    'INTERNAL_CONTEXT',
    'DECISION_SUPPORT',
    'PUBLIC_REFERENCE',
    'PRIVATE_REPLY'
);


--
-- Name: MemoryScope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MemoryScope" AS ENUM (
    'CORE',
    'IDENTITY',
    'ACCOUNT',
    'CONVERSATION'
);


--
-- Name: MemoryStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MemoryStatus" AS ENUM (
    'ACTIVE',
    'REVOKED'
);


--
-- Name: MemoryVisibility; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MemoryVisibility" AS ENUM (
    'PUBLIC',
    'PERSONAL',
    'CONFIDENTIAL',
    'RESTRICTED'
);


--
-- Name: ReviewDecision; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReviewDecision" AS ENUM (
    'APPROVE',
    'REJECT'
);


--
-- Name: RunMode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RunMode" AS ENUM (
    'SIMULATION'
);


--
-- Name: RunState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RunState" AS ENUM (
    'QUEUED',
    'CONTEXT_READY',
    'DRAFTED',
    'CANCELED',
    'WAITING_APPROVAL',
    'READY',
    'REJECTED',
    'EXPIRED',
    'EXECUTING',
    'RECONCILING',
    'SIMULATED',
    'BLOCKED'
);


--
-- Name: RunStateReason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RunStateReason" AS ENUM (
    'ACCOUNT_UNAVAILABLE',
    'BINDING_CHANGED',
    'CONVERSATION_UNAVAILABLE',
    'DRAFT_UNAVAILABLE',
    'SCHEDULE_CHANGED'
);


--
-- Name: ScheduleKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ScheduleKind" AS ENUM (
    'DAILY',
    'REMINDER'
);


--
-- Name: SimulationAttemptStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SimulationAttemptStatus" AS ENUM (
    'PERMITTED',
    'UNKNOWN',
    'CONFIRMED',
    'NOT_SENT'
);


--
-- Name: keep_conversation_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.keep_conversation_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.character_id, NEW.identity_id, NEW.account_id, NEW.remote_key, NEW.channel, NEW.private_contact_id)
     IS DISTINCT FROM
     (OLD.character_id, OLD.identity_id, OLD.account_id, OLD.remote_key, OLD.channel, OLD.private_contact_id) THEN
    RAISE EXCEPTION 'Conversation binding cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: rica_approve_daily_energy(uuid, date, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_approve_daily_energy(target_character uuid, target_day date, target_energy text, operator text, rationale text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  projection_id uuid;
BEGIN
  IF target_day <= (statement_timestamp() AT TIME ZONE 'UTC')::date THEN RETURN 'DAY_NOT_FUTURE'; END IF;
  INSERT INTO public.daily_energy_projections (character_id,utc_day,energy,actor_id,reason)
  VALUES (target_character,target_day,target_energy,operator,rationale)
  ON CONFLICT (character_id,utc_day) DO NOTHING RETURNING id INTO projection_id;
  RETURN COALESCE(projection_id::text,'DAY_EXISTS');
END
$$;


--
-- Name: rica_audit_schedule_occurrence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_audit_schedule_occurrence() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  VALUES (NEW.character_id, 'simulation-scheduler', 'schedule.fire', NEW.run_id, gen_random_uuid(),
    encode(sha256(convert_to(NEW.schedule_id::text || ':' || NEW.schedule_version::text || ':'
      || extract(epoch FROM NEW.scheduled_at)::text, 'UTF8')), 'hex'));
  RETURN NULL;
END
$$;


--
-- Name: rica_begin_outbox_attempt(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_begin_outbox_attempt(target_event uuid, event_type text, expected_generation integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE ticket int;
BEGIN
  UPDATE public.outbox SET attempts = attempts+1,attempt_until = clock_timestamp()+interval '30 seconds'
  WHERE event_id = target_event AND type = event_type AND generation = expected_generation
    AND processed_at IS NULL AND quarantined_at IS NULL AND attempts < 4
    AND (attempt_until IS NULL OR attempt_until <= clock_timestamp())
  RETURNING attempts INTO ticket;
  IF FOUND THEN RETURN ticket; END IF;

  UPDATE public.outbox SET quarantined_at = clock_timestamp(),attempt_until = NULL
  WHERE event_id = target_event AND type = event_type AND generation = expected_generation
    AND processed_at IS NULL AND quarantined_at IS NULL AND attempts = 4
    AND (attempt_until IS NULL OR attempt_until <= clock_timestamp());
  RETURN NULL;
END
$$;


--
-- Name: belief_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.belief_versions (
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    belief_id uuid NOT NULL,
    version integer NOT NULL,
    kind text NOT NULL,
    statement text NOT NULL,
    status text NOT NULL,
    confidence double precision NOT NULL,
    reason text NOT NULL,
    actor_id text NOT NULL,
    restored_from integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT belief_versions_check CHECK (((restored_from > 0) AND (restored_from < version))),
    CONSTRAINT belief_versions_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT belief_versions_kind_check CHECK ((kind = ANY (ARRAY['OPINION'::text, 'PREFERENCE'::text]))),
    CONSTRAINT belief_versions_statement_check CHECK (((char_length(btrim(statement)) >= 1) AND (char_length(btrim(statement)) <= 1000))),
    CONSTRAINT belief_versions_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'ACTIVE'::text, 'DISPUTED'::text]))),
    CONSTRAINT belief_versions_version_check CHECK ((version > 0))
);


--
-- Name: rica_belief_evidence_valid(public.belief_versions); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_belief_evidence_valid(v public.belief_versions) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.belief_evidence e
    WHERE (e.character_id,e.identity_id,e.belief_id,e.version) = (v.character_id,v.identity_id,v.belief_id,v.version)
      AND e.source_id IS DISTINCT FROM public.rica_belief_source(e.character_id,e.identity_id,e.memory_id,e.memory_revision)
  )
$$;


--
-- Name: rica_belief_refs_valid(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_belief_refs_valid(target_character uuid, target_identity uuid, refs jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(refs) AS ref(id uuid,version int)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rica_formal_beliefs(target_character,target_identity) b
      WHERE (b.belief_id,b.version) = (ref.id,ref.version) AND public.rica_belief_evidence_valid(b)
    )
  )
$$;


--
-- Name: rica_belief_source(uuid, uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_belief_source(target_character uuid, target_identity uuid, target_memory uuid, expected integer) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_bound_simulation_payload(uuid, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "rica.memory_scope" TO ''
    AS $$
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
$$;


--
-- Name: rica_cancel_out_of_policy_goals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_cancel_out_of_policy_goals() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  policy jsonb;
BEGIN
  SELECT v.role_profile->'autonomousGoal' INTO policy FROM public.identity_versions v
    WHERE (v.character_id,v.identity_id,v.version) = (NEW.character_id,NEW.id,NEW.active_version);
  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id,origin,topic,reflection_day)
  SELECT g.character_id,g.identity_id,g.goal_id,g.version+1,g.title,'CANCELED',g.priority,g.budget,
    g.due_at,g.next_step,'身份许可已撤回或收紧。','system:identity-policy',g.origin,g.topic,g.reflection_day
  FROM public.rica_current_goals g
  WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.id)
    AND g.origin = 'SELF' AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()
    AND NOT COALESCE(g.topic = policy->>'topic' AND g.budget <= (policy->>'budget')::int
      AND g.due_at-g.created_at <= make_interval(hours => (policy->>'maxDays')::int * 24),false);
  RETURN NEW;
END
$$;


--
-- Name: rica_cancel_previous_schedule_runs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_cancel_previous_schedule_runs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  WITH canceled AS (
    UPDATE public.agent_runs r SET state = 'CANCELED', state_reason = 'SCHEDULE_CHANGED', state_version = r.state_version + 1
    FROM public.schedule_occurrences o
    WHERE o.schedule_id = NEW.id AND o.schedule_version <> NEW.version
      AND (r.character_id, r.id) = (o.character_id, o.run_id)
      AND r.state IN ('QUEUED', 'CONTEXT_READY', 'DRAFTED', 'WAITING_APPROVAL', 'READY')
    RETURNING r.id
  )
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  SELECT NEW.character_id, 'simulation-scheduler', 'schedule.invalidate', id, gen_random_uuid(),
    encode(sha256(convert_to(NEW.id::text || ':' || NEW.version::text, 'UTF8')), 'hex')
  FROM canceled;
  RETURN NULL;
END
$$;


--
-- Name: rica_capture_contact_opt_out(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_capture_contact_opt_out() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NEW.message_text IS NOT NULL
    AND lower(btrim(regexp_replace(btrim(NEW.message_text), '[.!。！]+$', ''))) IN
      ('stop','unsubscribe','do not contact me','不要联系我','请不要联系我','停止联系我','別再聯絡我','不要聯絡我') THEN
    UPDATE public.contacts p SET no_contact_at = clock_timestamp(), boundary_changed_at = clock_timestamp(),
      boundary_version = boundary_version+1, boundary_reason = 'INBOUND_OPT_OUT'
    WHERE (p.character_id,p.identity_id,p.account_id,p.id)
      = (NEW.character_id,NEW.identity_id,NEW.account_id,NEW.contact_id)
      AND p.no_contact_at IS NULL;
    IF FOUND THEN
      INSERT INTO public.audit_log (character_id,actor_id,operation,target_id,request_id,digest)
      VALUES (NEW.character_id,'platform-contact','contact.opt_out',NEW.contact_id,NEW.id,
        encode(sha256(convert_to(NEW.id::text || ':contact.opt_out','UTF8')),'hex'));
    END IF;
  END IF;
  RETURN NEW;
END
$_$;


--
-- Name: rica_change_contact_boundary(uuid, uuid, integer, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_change_contact_boundary(target_character uuid, target_contact uuid, expected integer, blocked boolean, rationale text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  current_version int;
  current_blocked boolean;
  changed_at timestamptz;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  SELECT p.boundary_version,p.no_contact_at IS NOT NULL INTO current_version,current_blocked
  FROM public.contacts p WHERE (p.character_id,p.id) = (target_character,target_contact) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF current_version <> expected THEN RETURN 'STALE'; END IF;
  IF current_blocked = blocked THEN RETURN 'UNCHANGED'; END IF;
  changed_at := clock_timestamp();
  UPDATE public.contacts SET no_contact_at = CASE WHEN blocked THEN changed_at END,
    boundary_changed_at = changed_at, boundary_version = boundary_version+1, boundary_reason = rationale
  WHERE (character_id,id) = (target_character,target_contact);
  RETURN 'UPDATED';
END
$$;


--
-- Name: rica_check_memory_derivation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_check_memory_derivation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  parent public.memories%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.character_id, NEW.identity_id, NEW.account_id, NEW.conversation_id, NEW.scope,
        NEW.visibility, NEW.expires_at, NEW.parent_memory_id)
      IS DISTINCT FROM
       (OLD.character_id, OLD.identity_id, OLD.account_id, OLD.conversation_id, OLD.scope,
        OLD.visibility, OLD.expires_at, OLD.parent_memory_id) THEN
      RAISE EXCEPTION 'Memory provenance and scope cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_memory_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM id FROM public.characters WHERE id = NEW.character_id FOR UPDATE;
  SELECT * INTO parent FROM public.memories
  WHERE character_id = NEW.character_id AND id = NEW.parent_memory_id AND status = 'ACTIVE'
    AND (expires_at IS NULL OR expires_at > statement_timestamp())
  FOR SHARE;

  IF NOT FOUND OR parent.id = NEW.id OR parent.scope = 'CORE'
    OR (NEW.identity_id, NEW.account_id, NEW.conversation_id, NEW.scope, NEW.visibility, NEW.expires_at)
      IS DISTINCT FROM
       (parent.identity_id, parent.account_id, parent.conversation_id, parent.scope, parent.visibility, parent.expires_at) THEN
    RAISE EXCEPTION 'Invalid memory derivation parent or scope' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.memory_sources ms
    WHERE (ms.character_id, ms.memory_id) = (parent.character_id, parent.id)
  ) OR EXISTS (
    SELECT 1 FROM public.memory_sources ms
    JOIN public.sources_registry src ON (src.character_id, src.id) = (ms.character_id, ms.source_id)
    WHERE (ms.character_id, ms.memory_id) = (parent.character_id, parent.id) AND src.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Memory derivation requires active sources' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: rica_claim_newbi_event_page(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_claim_newbi_event_page(account uuid, endpoint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  binding record;
  checkpoint public.newbi_event_checkpoints%ROWTYPE;
  stamp timestamptz;
BEGIN
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = account FOR UPDATE OF c;

  SELECT a.remote_account_id,a.binding_version,c.auth_epoch INTO binding
  FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (a.character_id,a.identity_id)
  WHERE a.id = account AND a.platform = 'newbi' AND a.instance_key = endpoint
    AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO public.newbi_event_checkpoints(account_id) VALUES (account) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT checkpoint FROM public.newbi_event_checkpoints WHERE account_id = account FOR UPDATE;
  stamp := clock_timestamp();
  IF greatest(checkpoint.next_poll_at,checkpoint.lease_until) > stamp THEN
    RETURN jsonb_build_object('nextAt',greatest(checkpoint.next_poll_at,checkpoint.lease_until));
  END IF;

  UPDATE public.newbi_event_checkpoints SET ticket = gen_random_uuid(),lease_until = stamp+interval '30 seconds'
  WHERE account_id = account RETURNING * INTO checkpoint;
  RETURN jsonb_build_object('ticket',checkpoint.ticket,'cursor',checkpoint.cursor,'agentId',binding.remote_account_id,
    'bindingVersion',binding.binding_version,'authEpoch',binding.auth_epoch);
END
$$;


--
-- Name: rica_claim_newbi_reply(uuid, boolean, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_claim_newbi_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE claimed public.newbi_replies%ROWTYPE;
BEGIN
  PERFORM c.id FROM public.characters c JOIN public.newbi_replies r ON r.character_id = c.id
    WHERE r.id = reply FOR UPDATE OF c;
  UPDATE public.newbi_replies r SET status = 'IN_FLIGHT',attempts = attempts+1,
    lease_until = least(r.expires_at,clock_timestamp()+interval '30 seconds')
  FROM public.platform_accounts a,public.identities i,public.characters c
  WHERE r.id = reply AND public.rica_newbi_reply_matches_executor(r,executor)
    AND a.id = r.account_id AND (i.character_id,i.id) = (r.character_id,r.identity_id)
    AND c.id = r.character_id AND a.platform = 'newbi' AND a.instance_key = endpoint
    AND a.remote_account_id = agent::text AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
    AND NOT EXISTS (
      SELECT 1 FROM public.newbi_replies other
      WHERE other.account_id = r.account_id AND other.id <> r.id AND other.status IN ('IN_FLIGHT','UNKNOWN')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.newbi_replies other
      WHERE other.account_id = r.account_id AND other.retry_not_before > clock_timestamp()
    )
    AND r.content IS NOT NULL AND r.attempts < 3 AND r.expires_at > clock_timestamp()+interval '10 seconds'
    AND (r.status = 'READY' OR (allow_retry AND (r.status = 'UNKNOWN'
      OR (r.status = 'IN_FLIGHT' AND r.lease_until <= clock_timestamp()))))
  RETURNING r.* INTO claimed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',claimed.id,'postId',claimed.post_id,'content',claimed.content,'attempt',claimed.attempts);
END
$$;


--
-- Name: rica_clear_stale_draft_content(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_clear_stale_draft_content() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.simulated_drafts SET content = NULL
  WHERE character_id = NEW.id AND content IS NOT NULL;
  RETURN NULL;
END;
$$;


--
-- Name: rica_close_newbi_reply(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_close_newbi_reply(reply uuid, owner_character uuid, reason text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.newbi_replies SET status = 'CLOSED',closure_reason = reason,lease_until = NULL
  WHERE id = reply AND character_id = owner_character AND (
    status = 'UNKNOWN' OR (status = 'IN_FLIGHT' AND lease_until <= clock_timestamp()
      AND (attempts >= 3 OR expires_at <= clock_timestamp()))
  );
  RETURN FOUND;
END
$$;


--
-- Name: rica_confirmed_commitment_scope(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_confirmed_commitment_scope(target_character uuid, target_action uuid) RETURNS TABLE("accountId" uuid, "identityId" uuid, "conversationId" uuid, "contactId" uuid, zone text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT r.account_id, r.identity_id, i.conversation_id, i.contact_id, c.timezone
  FROM public.simulation_receipts receipt
  JOIN public.simulation_attempts attempt
    ON (attempt.character_id, attempt.action_id) = (receipt.character_id, receipt.action_id)
  JOIN public.action_proposals a ON (a.character_id, a.id) = (receipt.character_id, receipt.action_id)
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.inbound_events i ON i.id = r.inbound_event_id
  JOIN public.characters c ON c.id = r.character_id
  WHERE (receipt.character_id, receipt.action_id) = (target_character, target_action)
    AND attempt.status = 'CONFIRMED' AND r.mode = 'SIMULATION' AND r.state = 'SIMULATED'
    AND i.conversation_id IS NOT NULL
$$;


--
-- Name: rica_copy_memory_sources(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_copy_memory_sources() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.memory_sources (character_id, memory_id, source_id)
  SELECT character_id, NEW.id, source_id FROM public.memory_sources
  WHERE (character_id, memory_id) = (NEW.character_id, NEW.parent_memory_id);
  RETURN NEW;
END
$$;


--
-- Name: rica_correct_memory(uuid, uuid, integer, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_correct_memory(target_character uuid, target_memory uuid, expected integer, replacement text, operator text, rationale text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  m public.memories%ROWTYPE;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  SELECT * INTO m FROM public.memories WHERE (character_id,id) = (target_character,target_memory) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF m.revision <> expected THEN RETURN 'STALE'; END IF;
  IF m.status <> 'ACTIVE' OR (m.expires_at IS NOT NULL AND m.expires_at <= statement_timestamp())
    OR NOT EXISTS (SELECT 1 FROM public.memory_sources l WHERE (l.character_id,l.memory_id) = (target_character,target_memory))
    OR EXISTS (
      SELECT 1 FROM public.memory_sources l JOIN public.sources_registry s ON (s.character_id,s.id) = (l.character_id,l.source_id)
      WHERE (l.character_id,l.memory_id) = (target_character,target_memory) AND s.revoked_at IS NOT NULL
    ) THEN RETURN 'UNAVAILABLE'; END IF;

  UPDATE public.memories SET content = replacement, revision = revision+1,
    core_approved_at = CASE WHEN scope = 'CORE' THEN statement_timestamp() ELSE core_approved_at END
  WHERE (character_id,id) = (target_character,target_memory);
  WITH RECURSIVE changed(id) AS (
    SELECT target_memory UNION ALL
    SELECT child.id FROM public.memories child JOIN changed p ON child.parent_memory_id = p.id
    WHERE child.character_id = target_character
  ), cleared AS (
    UPDATE public.memories d SET status = 'REVOKED', content = ''
    FROM changed WHERE (d.character_id,d.id) = (target_character,changed.id) AND d.id <> target_memory
  )
  UPDATE public.memory_grants g SET revoked_at = statement_timestamp()
  FROM changed WHERE (g.character_id,g.memory_id) = (target_character,changed.id) AND g.revoked_at IS NULL;
  INSERT INTO public.memory_corrections (character_id,memory_id,revision,actor_id,reason)
  VALUES (target_character,target_memory,expected+1,operator,rationale);
  UPDATE public.characters SET auth_epoch = auth_epoch+1 WHERE id = target_character;
  RETURN 'UPDATED';
END
$$;


--
-- Name: rica_cross_platform_duplicate(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_cross_platform_duplicate(target_run uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  WITH target AS MATERIALIZED (
    SELECT r.character_id,r.identity_id,e.id,e.adapter_id,e.received_at,
      public.rica_topic_grams(e.message_text) AS grams,
      (v.role_profile->'duplicateReview'->>'windowHours')::int AS hours,
      (v.role_profile->'duplicateReview'->>'similarityPercent')::int AS threshold
    FROM public.agent_runs r
    JOIN public.inbound_events e ON e.id = r.inbound_event_id
    JOIN public.identity_versions v ON (v.character_id,v.identity_id,v.version) = (r.character_id,r.identity_id,r.identity_version)
    WHERE r.id = target_run AND r.state = 'CONTEXT_READY'
      AND e.adapter_id IN ('mock-a','mock-b') AND e.message_text IS NOT NULL
      AND v.role_profile ? 'duplicateReview'
      AND public.rica_simulated_review_target(r.id)->>'audience' = 'PUBLIC'
  ), recent AS MATERIALIZED (
    SELECT public.rica_topic_grams(e.message_text) AS grams
    FROM target t JOIN public.inbound_events e ON (e.character_id,e.identity_id) = (t.character_id,t.identity_id)
    JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id)
      = (e.character_id,e.identity_id,e.account_id,e.conversation_id) AND c.channel = 'PUBLIC'
    JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (e.character_id,e.identity_id,e.account_id)
      AND a.status = 'ACTIVE' AND a.platform = e.adapter_id
    WHERE t.hours BETWEEN 1 AND 168 AND t.threshold BETWEEN 65 AND 100 AND cardinality(t.grams) > 0
      AND e.adapter_id IN ('mock-a','mock-b') AND e.adapter_id <> t.adapter_id AND e.id <> t.id
      AND e.received_at >= t.received_at - make_interval(hours => t.hours)
      AND e.received_at <= t.received_at + make_interval(hours => t.hours)
      AND e.message_text IS NOT NULL
    ORDER BY e.received_at DESC,e.id LIMIT 64
  )
  SELECT EXISTS (
    SELECT 1 FROM target t CROSS JOIN recent r
    CROSS JOIN LATERAL (
      SELECT count(*) AS shared FROM (SELECT unnest(t.grams) INTERSECT SELECT unnest(r.grams)) grams
    ) overlap
    WHERE cardinality(r.grams) > 0
      AND overlap.shared * 100 >= t.threshold * (cardinality(t.grams) + cardinality(r.grams) - overlap.shared)
  )
$$;


--
-- Name: rica_daily_schedule_slot(text, time without time zone, timestamp with time zone, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_daily_schedule_slot(zone_name text, wall_time time without time zone, reference_at timestamp with time zone, backwards boolean) RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  WITH days AS (
    SELECT (reference_at AT TIME ZONE zone_name)::date + n + wall_time AS nominal
    FROM generate_series(-3, 3) AS g(n)
  ), resolved AS (
    SELECT (
      SELECT min(candidate)
      FROM generate_series(-36, 36, 6) AS g(hours)
      CROSS JOIN LATERAL (SELECT (nominal AT TIME ZONE 'UTC') + make_interval(hours => g.hours) AS instant) p
      CROSS JOIN LATERAL (
        SELECT (nominal - ((p.instant AT TIME ZONE zone_name) - (p.instant AT TIME ZONE 'UTC')))
          AT TIME ZONE 'UTC' AS candidate
      ) matching
      WHERE candidate AT TIME ZONE zone_name = nominal
    ) AS slot
    FROM days
  )
  SELECT CASE WHEN backwards THEN max(slot) FILTER (WHERE slot <= reference_at)
    ELSE min(slot) FILTER (WHERE slot > reference_at) END
  FROM resolved
$$;


--
-- Name: rica_due_reflections(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_due_reflections(after_identity uuid) RETURNS TABLE(id uuid, "characterId" uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT i.id,i.character_id
  FROM public.identities i JOIN public.characters c ON c.id = i.character_id
  WHERE (after_identity IS NULL OR i.id > after_identity)
    AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM public.identity_reflections r
      WHERE (r.character_id,r.identity_id,r.utc_day) = (i.character_id,i.id,(statement_timestamp() AT TIME ZONE 'UTC')::date - 1)
    )
  ORDER BY i.id LIMIT 16
$$;


--
-- Name: rica_fail_outbox_attempt(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_fail_outbox_attempt(target_event uuid, expected_generation integer, ticket integer) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  UPDATE public.outbox SET attempt_until = NULL,
    quarantined_at = CASE WHEN attempts = 4 THEN clock_timestamp() END
  WHERE event_id = target_event AND generation = expected_generation AND attempts = ticket
    AND processed_at IS NULL AND quarantined_at IS NULL
$$;


--
-- Name: rica_finish_action_review(uuid, uuid, integer, public."RunState"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_finish_action_review(target_character uuid, target_run uuid, expected_version integer, next_state public."RunState") RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  UPDATE public.agent_runs r SET state = next_state, state_version = r.state_version + 1
  WHERE (r.character_id, r.id, r.state_version) = (target_character, target_run, expected_version)
    AND r.state::text = 'WAITING_APPROVAL' AND next_state::text IN ('READY', 'REJECTED', 'CANCELED', 'EXPIRED')
    AND EXISTS (
      SELECT 1 FROM public.action_proposals a WHERE (a.character_id, a.run_id) = (r.character_id, r.id)
        AND (next_state::text IN ('CANCELED', 'EXPIRED')
          OR public.rica_review_payload(a.character_id, a.id) IS NOT NULL)
    )
  RETURNING r.state_version
$$;


--
-- Name: rica_finish_newbi_event_page(uuid, uuid, integer, integer, jsonb, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_finish_newbi_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  saved int := 0;
  lost boolean := coalesce((page->>'historyLost')::boolean,false);
  stamp timestamptz;
  due timestamptz;
BEGIN
  -- Management takes the same character lock before changing authorization or binding.
  PERFORM c.id FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  WHERE a.id = account FOR UPDATE OF c;
  PERFORM 1 FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (a.character_id,a.identity_id)
  WHERE a.id = account AND a.platform = 'newbi' AND a.binding_version = version AND c.auth_epoch = epoch
    AND a.status = 'ACTIVE' AND c.status = 'ACTIVE' AND i.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;

  stamp := clock_timestamp();
  UPDATE public.newbi_event_checkpoints SET
    cursor = coalesce(page->>'nextCursor',cursor),
    history_lost_count = history_lost_count+lost::int,
    last_history_lost_at = CASE WHEN lost THEN stamp ELSE last_history_lost_at END,
    next_poll_at = stamp+make_interval(secs => greatest(delay_seconds,0)),
    ticket = NULL,lease_until = NULL
  WHERE account_id = account AND ticket = claim_ticket AND lease_until > stamp
  RETURNING next_poll_at INTO due;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO public.newbi_events(account_id,seq,type,post_id,comment_id,occurred_at)
  SELECT account,item.seq,item.type,item."postId",item."commentId",item."createdAt"
  FROM jsonb_to_recordset(page->'items') AS item(
    seq text,type text,"postId" uuid,"commentId" uuid,"createdAt" timestamptz)
  ON CONFLICT (account_id,seq) DO NOTHING;
  GET DIAGNOSTICS saved = ROW_COUNT;
  RETURN jsonb_build_object('nextAt',due,'saved',saved,'historyLost',lost);
END
$$;


--
-- Name: rica_finish_newbi_reply(uuid, integer, uuid, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_finish_newbi_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ticket IS NULL THEN RETURN false; END IF;
  UPDATE public.newbi_replies SET status = CASE
      WHEN remote_comment IS NOT NULL THEN 'SENT'
      WHEN post_locked AND ticket = 1 THEN 'CLOSED'
      ELSE 'UNKNOWN' END,
    remote_comment_id = remote_comment,lease_until = NULL,
    retry_not_before = CASE WHEN retry_seconds > 0 THEN greatest(retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds)) ELSE retry_not_before END
  WHERE id = reply AND attempts = ticket AND status = 'IN_FLIGHT';
  RETURN FOUND;
END
$$;


--
-- Name: rica_fold_identity_state(double precision[], double precision, public."InboundKind", jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_fold_identity_state(previous double precision[], seconds double precision, kind public."InboundKind", configuration jsonb) RETURNS double precision[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT CASE WHEN configuration IS NULL THEN public.rica_identity_state_v1(previous,seconds,kind)
  ELSE (
    SELECT array_agg(greatest(CASE WHEN n = 5 THEN -1 ELSE 0 END,
      least(1, base[n] + (previous[n] - base[n])
        * power(0.5::double precision, least(64, greatest(seconds,0) / (3600 * half_life)))
        + delta)) ORDER BY n)
    FROM generate_series(1,7) AS pos(n)
    CROSS JOIN (SELECT ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[] AS base) b
    CROSS JOIN LATERAL (SELECT configuration->(CASE WHEN n <= 4 THEN 'motivationHalfLifeHours'
      ELSE 'affectHalfLifeHours' END) AS hours,
      configuration->'deltas'->kind::text->(n-1) AS step) entry
    CROSS JOIN LATERAL (
      SELECT CASE WHEN jsonb_typeof(hours) = 'number'
        THEN greatest(1,least(168,(hours #>> '{}')::numeric))::double precision
        ELSE CASE WHEN n <= 4 THEN 24 ELSE 8 END END AS half_life,
        CASE WHEN jsonb_typeof(step) = 'number'
          THEN greatest(-0.15,least(0.15,(step #>> '{}')::numeric))::double precision ELSE 0 END AS delta
    ) config
  ) END
$$;


--
-- Name: rica_formal_beliefs(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_formal_beliefs(target_character uuid, target_identity uuid) RETURNS SETOF public.belief_versions
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT DISTINCT ON (v.belief_id) v.*
  FROM public.belief_versions v
  WHERE (v.character_id,v.identity_id) = (target_character,target_identity) AND v.status = 'ACTIVE'
  ORDER BY v.belief_id,v.version DESC
$$;


--
-- Name: rica_freeze_memory_sources(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_freeze_memory_sources() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  PERFORM id FROM public.characters WHERE id = NEW.character_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.memories WHERE (character_id, parent_memory_id) = (NEW.character_id, NEW.memory_id)
  ) THEN
    RAISE EXCEPTION 'Memory source links are frozen after derivation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: goal_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goal_versions (
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    goal_id uuid NOT NULL,
    version integer NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    priority integer NOT NULL,
    budget integer NOT NULL,
    due_at timestamp with time zone NOT NULL,
    next_step text,
    reason text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'ADMIN'::text NOT NULL,
    topic text,
    reflection_day date,
    CONSTRAINT goal_origin_scope CHECK ((((origin = 'ADMIN'::text) AND (topic IS NULL) AND (reflection_day IS NULL)) OR ((origin = 'SELF'::text) AND (NOT (topic IS DISTINCT FROM 'REVIEW_INTERACTIONS'::text)) AND (reflection_day IS NOT NULL)))),
    CONSTRAINT goal_versions_budget_check CHECK (((budget >= 1) AND (budget <= 100))),
    CONSTRAINT goal_versions_priority_check CHECK (((priority >= 0) AND (priority <= 100))),
    CONSTRAINT goal_versions_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'PAUSED'::text, 'DONE'::text, 'CANCELED'::text, 'EXPIRED'::text]))),
    CONSTRAINT goal_versions_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 240))),
    CONSTRAINT goal_versions_version_check CHECK ((version > 0))
);


--
-- Name: rica_goal_json(public.goal_versions); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_goal_json(g public.goal_versions) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('id',g.goal_id,'identityId',g.identity_id,'version',g.version,'origin',g.origin,
    'topic',g.topic,'reflectionDay',g.reflection_day,
    'title',g.title,'status',CASE WHEN g.due_at <= statement_timestamp() AND g.status IN ('DRAFT','ACTIVE','PAUSED')
      THEN 'EXPIRED' ELSE g.status END,
    'priority',g.priority,'budget',g.budget,'dueAt',g.due_at,'nextStep',g.next_step,'createdAt',g.created_at)
$$;


--
-- Name: rica_guard_newbi_reply_executor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_guard_newbi_reply_executor() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'WAITING' OR NEW.approved_executor_key IS NOT NULL THEN
      RAISE EXCEPTION 'A current executor binding is required for new replies' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.executor_key IS DISTINCT FROM OLD.executor_key THEN
      RAISE EXCEPTION 'The reply executor binding is immutable' USING ERRCODE = '23514';
    END IF;
    IF (NEW.status = 'READY' OR NEW.approved_executor_key IS DISTINCT FROM OLD.approved_executor_key)
      AND NOT (OLD.status = 'WAITING' AND NEW.status = 'READY' AND NEW.approved_executor_key IS NOT NULL) THEN
      RAISE EXCEPTION 'Approval must bind the reply executor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: rica_guard_simulation_permit_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_guard_simulation_permit_binding() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF NEW.status <> 'PERMITTED' OR NOT EXISTS (
    SELECT 1 FROM public.action_proposals a
    JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    WHERE (a.character_id, a.id) = (NEW.character_id, NEW.action_id)
      AND a.review_digest = NEW.review_digest
      AND approval.decision = 'APPROVE' AND approval.review_digest = a.review_digest
      AND r.mode = 'SIMULATION' AND r.state = 'READY' AND r.account_id = NEW.account_id
      AND NEW.permit_until <= least(a.expires_at, approval.expires_at)
      AND NEW.permit_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Simulation permit requires a current adapter-bound approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: rica_identity_state_v1(double precision[], double precision, public."InboundKind"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_identity_state_v1(previous double precision[], seconds double precision, kind public."InboundKind") RETURNS double precision[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT array_agg(greatest(CASE WHEN n = 5 THEN -1 ELSE 0 END,
    least(1, baseline[n] + (previous[n] - baseline[n])
      * power(0.5::double precision, least(64, greatest(seconds, 0) / CASE WHEN n <= 4 THEN 86400 ELSE 28800 END))
      + delta[n])) ORDER BY n)
  FROM generate_series(1, 7) AS position(n)
  CROSS JOIN (SELECT ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[] AS baseline,
    CASE kind
      WHEN 'POST' THEN ARRAY[0.08,0.03,0,0,0.01,0.03,-0.01]
      WHEN 'MENTION' THEN ARRAY[0.03,0.04,0.06,0.02,0.02,0.07,-0.02]
      WHEN 'REPLY' THEN ARRAY[0.01,-0.03,-0.07,0.03,0.04,0.04,-0.03]
      ELSE ARRAY[0,0,0,0,0,0,0]
    END::double precision[] AS delta) AS rule
$$;


--
-- Name: rica_invalidate_action_reviews(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_invalidate_action_reviews() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  WITH invalidated AS (
    UPDATE public.agent_runs r SET state = 'CANCELED', state_version = r.state_version + 1
    FROM public.action_proposals a
    WHERE (r.character_id, r.id) = (a.character_id, a.run_id)
      AND r.character_id = NEW.id AND r.state::text IN ('WAITING_APPROVAL', 'READY')
    RETURNING a.id, a.review_digest
  )
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  SELECT NEW.id, 'system', 'action.invalidate', id, gen_random_uuid(), review_digest FROM invalidated;
  RETURN NULL;
END
$$;


--
-- Name: rica_lock_conversation(uuid, uuid, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_lock_conversation(target_character uuid, target_identity uuid, target_account uuid, target_conversation uuid, target_contact uuid) RETURNS TABLE(channel public."ConversationChannel")
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT c.channel FROM public.conversations c
  WHERE (c.character_id, c.identity_id, c.account_id, c.id)
    = (target_character, target_identity, target_account, target_conversation)
    AND (c.channel = 'PUBLIC' OR c.private_contact_id = target_contact)
  FOR SHARE
$$;


--
-- Name: rica_lock_simulated_binding(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_lock_simulated_binding(target_account uuid) RETURNS TABLE("characterId" uuid, "identityId" uuid, "accountId" uuid, "coreVersion" integer, "identityVersion" integer, "bindingVersion" integer, "authEpoch" integer)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT c.id, i.id, a.id, c.active_core_version, i.active_version, a.binding_version, c.auth_epoch
  FROM public.platform_accounts a
  JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
  JOIN public.characters c ON c.id = i.character_id
  WHERE a.id = target_account AND a.platform IN ('mock-a', 'mock-b')
    AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
  FOR SHARE OF c, i, a
$$;


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid,
    account_id uuid,
    scope public."MemoryScope" NOT NULL,
    visibility public."MemoryVisibility" NOT NULL,
    status public."MemoryStatus" DEFAULT 'ACTIVE'::public."MemoryStatus" NOT NULL,
    content text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    importance double precision DEFAULT 0.5 NOT NULL,
    confidence double precision DEFAULT 0.5 NOT NULL,
    expires_at timestamp with time zone,
    core_approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    conversation_id uuid,
    parent_memory_id uuid,
    CONSTRAINT memories_revision_positive CHECK ((revision > 0)),
    CONSTRAINT memories_scope_requires_owner CHECK ((((scope = 'CORE'::public."MemoryScope") AND (identity_id IS NULL) AND (account_id IS NULL) AND (conversation_id IS NULL) AND (visibility = 'PUBLIC'::public."MemoryVisibility") AND (core_approved_at IS NOT NULL)) OR ((scope = 'IDENTITY'::public."MemoryScope") AND (identity_id IS NOT NULL) AND (account_id IS NULL) AND (conversation_id IS NULL) AND (core_approved_at IS NULL)) OR ((scope = 'ACCOUNT'::public."MemoryScope") AND (identity_id IS NOT NULL) AND (account_id IS NOT NULL) AND (conversation_id IS NULL) AND (core_approved_at IS NULL)) OR (((scope)::text = 'CONVERSATION'::text) AND (identity_id IS NOT NULL) AND (account_id IS NOT NULL) AND (conversation_id IS NOT NULL) AND (core_approved_at IS NULL)))),
    CONSTRAINT memories_scores_in_range CHECK ((((importance >= (0)::double precision) AND (importance <= (1)::double precision)) AND ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))))
);

ALTER TABLE ONLY public.memories FORCE ROW LEVEL SECURITY;


--
-- Name: rica_memory_allowed_at(public.memories, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_memory_allowed_at(m public.memories, checked_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_memory_allowed(public.memories); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_memory_allowed(m public.memories) RETURNS boolean
    LANGUAGE sql STABLE
    RETURN public.rica_memory_allowed_at(m, statement_timestamp());


--
-- Name: rica_memory_provenance(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_memory_provenance(target_character uuid, target_memory uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('id',m.id,'revision',m.revision,'status',m.status,'parentMemoryId',m.parent_memory_id,
    'sources',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'classification',s.classification,'revokedAt',s.revoked_at)
        ORDER BY s.id)
      FROM public.memory_sources l JOIN public.sources_registry s ON (s.character_id,s.id) = (l.character_id,l.source_id)
      WHERE (l.character_id,l.memory_id) = (m.character_id,m.id)
    ),'[]'::jsonb),
    'corrections',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('revision',v.revision,'actorId',v.actor_id,'reason',v.reason,'createdAt',v.created_at)
        ORDER BY v.revision)
      FROM public.memory_corrections v WHERE (v.character_id,v.memory_id) = (m.character_id,m.id)
    ),'[]'::jsonb))
  FROM public.memories m WHERE (m.character_id,m.id) = (target_character,target_memory)
$$;


--
-- Name: rica_memory_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_memory_scope() RETURNS TABLE(character_id uuid, identity_id uuid, account_id uuid, conversation_id uuid, contact_id uuid, channel text, purpose text, audience text)
    LANGUAGE sql STABLE ROWS 1
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT * FROM jsonb_to_record(NULLIF(current_setting('rica.memory_scope', true), '')::jsonb)
    AS scope(character_id uuid, identity_id uuid, account_id uuid,
             conversation_id uuid, contact_id uuid, channel text, purpose text, audience text)
$$;


--
-- Name: rica_newbi_execution_target(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_newbi_execution_target(reply uuid, executor text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until,'retryNotBefore',(
      SELECT max(other.retry_not_before) FROM public.newbi_replies other WHERE other.account_id = r.account_id
    ))
  FROM public.newbi_replies r JOIN public.platform_accounts a ON a.id = r.account_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.characters c ON c.id = r.character_id
  WHERE r.id = reply AND public.rica_newbi_reply_matches_executor(r,executor)
    AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND a.platform = 'newbi' AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.auth_epoch,r.binding_version) = (c.auth_epoch,a.binding_version)
$$;


--
-- Name: newbi_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.newbi_replies (
    id uuid NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    account_id uuid NOT NULL,
    auth_epoch integer NOT NULL,
    binding_version integer NOT NULL,
    post_id uuid NOT NULL,
    content text,
    review_digest character varying(64) NOT NULL,
    proposer_id text NOT NULL,
    reviewer_id text,
    status text DEFAULT 'WAITING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    remote_comment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    retry_not_before timestamp with time zone,
    closure_reason character varying(240),
    executor_key text NOT NULL,
    approved_executor_key text,
    CONSTRAINT newbi_replies_attempts_check CHECK (((attempts >= 0) AND (attempts <= 3))),
    CONSTRAINT newbi_replies_check CHECK (((status = 'SENT'::text) = (remote_comment_id IS NOT NULL))),
    CONSTRAINT newbi_replies_check1 CHECK (((status = 'IN_FLIGHT'::text) = (lease_until IS NOT NULL))),
    CONSTRAINT newbi_replies_check2 CHECK (((status = 'WAITING'::text) = (reviewer_id IS NULL))),
    CONSTRAINT newbi_replies_check3 CHECK (((reviewer_id IS NULL) OR (reviewer_id <> proposer_id))),
    CONSTRAINT newbi_replies_closure_reason_check CHECK (((closure_reason IS NULL) OR ((status = 'CLOSED'::text) AND (length(btrim((closure_reason)::text)) > 0)))),
    CONSTRAINT newbi_replies_content_check CHECK (((content IS NULL) OR ((char_length(btrim(content)) >= 1) AND (char_length(btrim(content)) <= 4000)))),
    CONSTRAINT newbi_replies_executor_approval_check CHECK (((approved_executor_key IS NULL) OR (executor_key = approved_executor_key))),
    CONSTRAINT newbi_replies_review_digest_check CHECK (((review_digest)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT newbi_replies_status_check CHECK ((status = ANY (ARRAY['WAITING'::text, 'READY'::text, 'REJECTED'::text, 'IN_FLIGHT'::text, 'UNKNOWN'::text, 'SENT'::text, 'CLOSED'::text])))
);


--
-- Name: rica_newbi_reply_matches_executor(public.newbi_replies, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_newbi_reply_matches_executor(r public.newbi_replies, executor text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT r.approved_executor_key = executor
$$;


--
-- Name: rica_newbi_reply_preflight(uuid, text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_newbi_reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF post_locked THEN
    UPDATE public.newbi_replies r SET status = 'CLOSED'
    WHERE r.id = reply AND r.status = 'READY' AND r.attempts = 0
      AND public.rica_newbi_reply_matches_executor(r,executor);
  ELSE
    PERFORM c.id FROM public.characters c JOIN public.newbi_replies r ON r.character_id = c.id
      WHERE r.id = reply FOR UPDATE OF c;
    UPDATE public.newbi_replies r SET retry_not_before = greatest(r.retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds))
    WHERE r.id = reply AND retry_seconds > 0 AND r.status IN ('READY','IN_FLIGHT','UNKNOWN')
      AND public.rica_newbi_reply_matches_executor(r,executor);
  END IF;
  RETURN FOUND;
END
$$;


--
-- Name: rica_pin_run_contact_boundary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_pin_run_contact_boundary() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  SELECT p.boundary_version INTO NEW.contact_boundary_version
  FROM public.inbound_events e
  JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id,p.id)
    = (e.character_id,e.identity_id,e.account_id,e.contact_id)
  WHERE (e.character_id,e.identity_id,e.account_id,e.id)
    = (NEW.character_id,NEW.identity_id,NEW.account_id,NEW.inbound_event_id);
  RETURN NEW;
END
$$;


--
-- Name: rica_pin_run_timezone(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_pin_run_timezone() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_plan_reflection_goal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_plan_reflection_goal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  policy jsonb;
  days int;
  budget_limit int;
BEGIN
  IF NEW.observed_receipts = 0 THEN RETURN NEW; END IF;
  SELECT v.role_profile->'autonomousGoal' INTO policy FROM public.identity_versions v
    WHERE (v.character_id,v.identity_id,v.version) = (NEW.character_id,NEW.identity_id,NEW.identity_version);
  IF policy->>'topic' IS DISTINCT FROM 'REVIEW_INTERACTIONS' THEN RETURN NEW; END IF;
  days := (policy->>'maxDays')::int;
  budget_limit := (policy->>'budget')::int;
  IF NOT COALESCE(days BETWEEN 1 AND 7 AND budget_limit BETWEEN 1 AND 100,false) THEN RETURN NEW; END IF;

  -- Reflection and manual goal updates hold the same character lock.
  IF (SELECT count(*) FROM public.rica_current_goals g
    WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.identity_id)
      AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()) >= 3
    OR EXISTS (SELECT 1 FROM public.rica_current_goals g
      WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.identity_id)
        AND g.origin = 'SELF' AND g.topic = 'REVIEW_INTERACTIONS'
        AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp())
    THEN RETURN NEW; END IF;

  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id,created_at,origin,topic,reflection_day)
  VALUES (NEW.character_id,NEW.identity_id,gen_random_uuid(),1,'复盘近期互动','ACTIVE',30,budget_limit,
    statement_timestamp() + make_interval(hours => days * 24),'整理上一日已确认互动中的一个改进点。',
    '每日反思记录了已确认的模拟互动。','system:reflection',statement_timestamp(),'SELF','REVIEW_INTERACTIONS',NEW.utc_day);
  RETURN NEW;
END
$$;


--
-- Name: rica_quarantined_outbox(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_quarantined_outbox(target_character uuid, after_event uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',o.event_id,'runId',o.run_id,'type',o.type,'generation',o.generation,'attempts',o.attempts,'quarantinedAt',o.quarantined_at
  ) ORDER BY o.event_id),'[]'::jsonb)
  FROM (
    SELECT o.* FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
    WHERE r.character_id = target_character AND r.mode = 'SIMULATION' AND o.type IN ('RunQueued.v1','SimulatedDraftQueued.v1')
      AND o.quarantined_at IS NOT NULL AND (after_event IS NULL OR o.event_id > after_event)
    ORDER BY o.event_id LIMIT 26
  ) o
$$;


--
-- Name: rica_read_belief(uuid, uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_read_belief(target_character uuid, target_identity uuid, target_belief uuid, requested_version integer) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_read_contact_boundary(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_read_contact_boundary(target_character uuid, target_contact uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('id',p.id,'accountId',p.account_id,'version',p.boundary_version,
    'blocked',p.no_contact_at IS NOT NULL,'changedAt',p.boundary_changed_at,'reason',p.boundary_reason)
  FROM public.contacts p WHERE (p.character_id,p.id) = (target_character,target_contact)
$$;


--
-- Name: rica_read_daily_energy(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_read_daily_energy(target_character uuid, target_day date) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('id',id,'utcDay',utc_day,'energy',energy,'approvedAt',approved_at)
  FROM public.daily_energy_projections WHERE (character_id,utc_day) = (target_character,target_day)
$$;


--
-- Name: rica_read_identity_reflection(uuid, uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_read_identity_reflection(target_character uuid, target_identity uuid, day date) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('identityId',r.identity_id,'utcDay',r.utc_day,'coreVersion',r.core_version,
    'identityVersion',r.identity_version,'createdAt',r.created_at,'candidateBeliefId',r.candidate_belief_id,
    'fictionalProfile',jsonb_build_object('kind','FICTIONAL_PROFILE','present',r.fictional_profile),
    'observedActivity',jsonb_build_object('kind','OBSERVED_ACTIVITY','simulatedReceipts',r.observed_receipts),
    'unverifiedExternal',jsonb_build_object('kind','UNVERIFIED_EXTERNAL','inboundMessages',r.unverified_events))
  FROM public.identity_reflections r
  WHERE (r.character_id,r.identity_id,r.utc_day) = (target_character,target_identity,day)
$$;


--
-- Name: rica_read_manual_goals(uuid, uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_read_manual_goals(target_character uuid, target_identity uuid, target_goal uuid, requested_version integer) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_record_identity_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_record_identity_state() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  event public.inbound_events%ROWTYPE;
  latest public.identity_state_revisions%ROWTYPE;
  checkpoint public.identity_state_revisions%ROWTYPE;
  item record;
  effective timestamptz;
  through_time timestamptz;
  through_id uuid;
  state double precision[];
  next_revision int;
  configuration jsonb;
BEGIN
  IF NEW.mode <> 'SIMULATION' THEN RETURN NEW; END IF;
  SELECT e.* INTO event FROM public.inbound_events e WHERE e.id = NEW.inbound_event_id
    AND e.adapter_id IS NOT NULL AND e.source_key NOT LIKE 'schedule:%';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rica_lock_simulated_binding(NEW.account_id) b
    WHERE (b."characterId",b."identityId",b."accountId",b."coreVersion",b."identityVersion",b."bindingVersion",b."authEpoch")
      = (NEW.character_id,NEW.identity_id,NEW.account_id,NEW.core_version,NEW.identity_version,NEW.binding_version,NEW.auth_epoch)
  ) THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rica.identity-state:' || NEW.identity_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.identity_state_revisions WHERE event_id = event.id) THEN RETURN NEW; END IF;
  SELECT * INTO latest FROM public.identity_state_revisions
  WHERE (character_id,identity_id) = (NEW.character_id,NEW.identity_id)
  ORDER BY revision DESC LIMIT 1;
  SELECT v.role_profile->'stateRule' INTO configuration
  FROM public.identity_versions v
  WHERE (v.character_id,v.identity_id,v.version) = (NEW.character_id,NEW.identity_id,NEW.identity_version);
  IF jsonb_typeof(configuration) IS DISTINCT FROM 'object' THEN configuration := NULL; END IF;
  next_revision := COALESCE(latest.revision,0) + 1;
  effective := least(event.occurred_at,event.received_at);
  state := ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[];

  IF latest.revision IS NULL OR (effective,event.id) > (latest.through_at,latest.through_event_id) THEN
    state := public.rica_fold_identity_state(COALESCE(latest.state_vector,state),
      extract(epoch FROM effective - COALESCE(latest.through_at,effective))::double precision, event.kind, configuration);
    through_time := effective;
    through_id := event.id;
  ELSE
    -- A checkpoint predating the late event is valid only if it includes every earlier input.
    SELECT cp.* INTO checkpoint FROM public.identity_state_revisions cp
    WHERE (cp.character_id,cp.identity_id) = (NEW.character_id,NEW.identity_id)
      AND (cp.through_at,cp.through_event_id) < (effective,event.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.identity_state_revisions added
        WHERE (added.character_id,added.identity_id) = (cp.character_id,cp.identity_id)
          AND added.revision > cp.revision
          AND (added.effective_at,added.event_id) <= (cp.through_at,cp.through_event_id)
      )
    ORDER BY cp.revision DESC LIMIT 1;
    IF FOUND THEN
      state := checkpoint.state_vector;
      through_time := checkpoint.through_at;
      through_id := checkpoint.through_event_id;
    END IF;
    FOR item IN
      SELECT effective_at,event_id,event_kind,rule_configuration FROM public.identity_state_revisions
      WHERE (character_id,identity_id) = (NEW.character_id,NEW.identity_id)
        AND (checkpoint.revision IS NULL OR (effective_at,event_id) > (checkpoint.through_at,checkpoint.through_event_id))
      UNION ALL SELECT effective,event.id,event.kind,configuration
      ORDER BY effective_at,event_id
    LOOP
      state := public.rica_fold_identity_state(state,
        extract(epoch FROM item.effective_at - COALESCE(through_time,item.effective_at))::double precision,
        item.event_kind,item.rule_configuration);
      through_time := item.effective_at;
      through_id := item.event_id;
    END LOOP;
  END IF;

  INSERT INTO public.identity_state_revisions (character_id,identity_id,revision,run_id,event_id,event_kind,
    effective_at,through_at,through_event_id,state_vector,rule_version,actor_id,rule_configuration)
  VALUES (NEW.character_id,NEW.identity_id,next_revision,NEW.id,event.id,event.kind,
    effective,through_time,through_id,state,1,'simulation-worker',configuration);
  RETURN NEW;
END
$$;


--
-- Name: rica_record_simulation_receipt(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_record_simulation_receipt(target_action uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_reflect_identity(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_reflect_identity(target_character uuid, target_identity uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  day date := (statement_timestamp() AT TIME ZONE 'UTC')::date - 1;
  start_at timestamptz := day::timestamp AT TIME ZONE 'UTC';
  end_at timestamptz := (day+1)::timestamp AT TIME ZONE 'UTC';
  profile record;
  observed int;
  unverified int;
  candidate uuid;
  citation record;
BEGIN
  -- Keep scope, evidence and any resulting versions consistent with management commands and revocation.
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  SELECT c.active_core_version,i.active_version,COALESCE(core.hard_profile ? 'fictionalBackground',false) AS fictional
  INTO profile
  FROM public.identities i JOIN public.characters c ON c.id = i.character_id
  JOIN public.core_versions core ON (core.character_id,core.version) = (c.id,c.active_core_version)
  WHERE (i.character_id,i.id) = (target_character,target_identity) AND i.status = 'ACTIVE' AND c.status = 'ACTIVE';
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.identity_reflections r WHERE (r.character_id,r.identity_id,r.utc_day) = (target_character,target_identity,day)
  ) THEN RETURN false; END IF;

  SELECT count(*) INTO observed
  FROM public.agent_runs r
  JOIN public.action_proposals a ON (a.character_id,a.run_id) = (r.character_id,r.id)
  JOIN public.simulation_attempts s ON (s.character_id,s.action_id) = (a.character_id,a.id) AND s.status = 'CONFIRMED'
  JOIN public.simulation_receipts receipt ON (receipt.character_id,receipt.action_id) = (s.character_id,s.action_id)
  WHERE (r.character_id,r.identity_id) = (target_character,target_identity) AND r.mode = 'SIMULATION'
    AND receipt.created_at >= start_at AND receipt.created_at < end_at;
  SELECT count(*) INTO unverified FROM public.inbound_events e
  WHERE (e.character_id,e.identity_id) = (target_character,target_identity) AND e.message_text IS NOT NULL
    AND e.received_at >= start_at AND e.received_at < end_at;

  SELECT m.id,m.revision,source.id AS source_id INTO citation
  FROM public.memories m
  CROSS JOIN LATERAL (SELECT public.rica_belief_source(m.character_id,m.identity_id,m.id,m.revision) AS id) source
  WHERE (m.character_id,m.identity_id) = (target_character,target_identity)
    AND m.scope = 'IDENTITY' AND m.status = 'ACTIVE' AND m.created_at >= start_at AND m.created_at < end_at
    AND source.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.belief_evidence e JOIN public.belief_versions v USING (character_id,identity_id,belief_id,version)
      WHERE (e.character_id,e.identity_id,e.source_id) = (target_character,target_identity,source.id)
        AND v.actor_id = 'system:reflection'
    )
  ORDER BY m.created_at DESC,m.id LIMIT 1;
  IF FOUND THEN
    candidate := gen_random_uuid();
    INSERT INTO public.belief_versions (character_id,identity_id,belief_id,version,kind,statement,status,confidence,reason,actor_id)
    VALUES (target_character,target_identity,candidate,1,'PREFERENCE','我可能愿意进一步了解这段经历。','PENDING',0.55,
      '每日反思选出一条身份内有效经历，待复核。','system:reflection');
    INSERT INTO public.belief_evidence (character_id,identity_id,belief_id,version,source_id,memory_id,memory_revision,direction,weight)
    VALUES (target_character,target_identity,candidate,1,citation.source_id,citation.id,citation.revision,'SUPPORT',0.5);
  END IF;

  INSERT INTO public.identity_reflections (character_id,identity_id,utc_day,core_version,identity_version,fictional_profile,
    observed_receipts,unverified_events,candidate_belief_id)
  VALUES (target_character,target_identity,day,profile.active_core_version,profile.active_version,profile.fictional,
    observed,unverified,candidate);
  RETURN true;
END
$$;


--
-- Name: rica_remaining_belief_evidence(public.belief_versions); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_remaining_belief_evidence(v public.belief_versions) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'supportingSources',count(*) FILTER (WHERE e.direction = 'SUPPORT' AND e.weight > 0),
    'opposingSources',count(*) FILTER (WHERE e.direction = 'OPPOSE' AND e.weight > 0),
    'confidence',0.5 + greatest(-0.2,least(0.2,0.1 * COALESCE(
      sum(CASE WHEN e.direction = 'SUPPORT' THEN e.weight ELSE -e.weight END),0))))
  FROM public.belief_evidence e
  WHERE (e.character_id,e.identity_id,e.belief_id,e.version) = (v.character_id,v.identity_id,v.belief_id,v.version)
    AND e.source_id = public.rica_belief_source(e.character_id,e.identity_id,e.memory_id,e.memory_revision)
$$;


--
-- Name: rica_replay_run_with_time(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_replay_run_with_time(target_character uuid, target_run uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  WITH replay AS MATERIALIZED (
    SELECT public.rica_replay_simulation_run(target_character,target_run) AS view,
      r.context_timezone,r.goal_refs,r.references_expired_at,d.belief_refs,a.adapter_id,a.adapter_contract_version
    FROM public.agent_runs r
    LEFT JOIN public.simulated_drafts d ON (d.character_id,d.run_id) = (r.character_id,r.id)
    LEFT JOIN public.action_proposals a ON (a.character_id,a.run_id) = (r.character_id,r.id)
    WHERE (r.character_id,r.id) = (target_character,target_run)
  )
  SELECT view
    || jsonb_build_object('contextTimezone',context_timezone,'goalRefs',goal_refs,
      'referencesExpiredAt',references_expired_at,'beliefRefs',COALESCE(belief_refs,'[]'::jsonb))
    || CASE WHEN references_expired_at IS NOT NULL THEN jsonb_build_object('schedule',NULL) ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(view->'proposal') = 'object' THEN jsonb_build_object('proposal',view->'proposal'
      || jsonb_build_object('adapterId',adapter_id,'adapterContractVersion',adapter_contract_version)) ELSE '{}'::jsonb END
  FROM replay
$$;


--
-- Name: rica_replay_simulation_run(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_replay_simulation_run(target_character uuid, target_run uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "rica.memory_scope" TO ''
    AS $$
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
$$;


--
-- Name: rica_reserve_model_budget(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_reserve_model_budget(target_run uuid, units integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  target_character uuid;
  ceiling int;
  today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF units IS NULL OR units NOT BETWEEN 1 AND 1000000 THEN RETURN false; END IF;
  SELECT r.character_id,COALESCE((c.hard_profile->>'dailyModelBudget')::int,10000000)
  INTO target_character,ceiling
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id,c.version) = (r.character_id,r.core_version)
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND public.rica_run_identity_state(r.id) IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Only the per-character daily counter is write-locked. The caller already holds the run binding locks.
  INSERT INTO public.model_daily_usage (character_id,utc_day) VALUES (target_character,today) ON CONFLICT DO NOTHING;
  UPDATE public.model_daily_usage SET reserved_units = reserved_units+units,calls = calls+1
    WHERE (character_id,utc_day) = (target_character,today) AND reserved_units <= ceiling-units;
  IF FOUND THEN RETURN true; END IF;
  UPDATE public.model_daily_usage SET denied = denied+1 WHERE (character_id,utc_day) = (target_character,today);
  RETURN false;
END
$$;


--
-- Name: rica_resolve_simulated_event_scope(uuid, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_resolve_simulated_event_scope(target_account uuid, target_platform text, target_instance text, target_remote_account text, target_thread text, target_contact text) RETURNS TABLE("conversationId" uuid, "contactId" uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT
    (SELECT t.id FROM public.conversations t
     WHERE (t.character_id, t.identity_id, t.account_id, t.remote_key)
       = (a.character_id, a.identity_id, a.id, target_thread)
     FOR SHARE),
    (SELECT p.id FROM public.contacts p
     WHERE (p.character_id, p.identity_id, p.account_id, p.remote_key)
       = (a.character_id, a.identity_id, a.id, target_contact)
     FOR SHARE)
  FROM public.platform_accounts a
  WHERE (a.id, a.platform, a.instance_key, a.remote_account_id)
    = (target_account, target_platform, target_instance, target_remote_account)
    AND a.platform IN ('mock-a', 'mock-b') AND a.status = 'ACTIVE'
  FOR SHARE OF a
$$;


--
-- Name: rica_resolve_simulation(uuid, uuid, integer, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_resolve_simulation(target_character uuid, target_action uuid, expected_version integer, expected_outcome text, evidence_ref text, actor text, rationale text) RETURNS TABLE(version integer, state text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  facts record;
  final_state public."RunState";
BEGIN
  PERFORM 1 FROM public.characters c WHERE c.id = target_character FOR UPDATE;
  SELECT * INTO facts FROM public.rica_simulation_reconciliation(target_character, target_action);
  IF NOT FOUND OR facts.version <> expected_version OR facts.outcome IS NULL
    OR facts.outcome IS DISTINCT FROM expected_outcome OR facts."evidenceRef" IS DISTINCT FROM evidence_ref THEN
    RETURN;
  END IF;

  final_state := (CASE WHEN facts.outcome = 'CONFIRMED' THEN 'SIMULATED' ELSE 'BLOCKED' END)::public."RunState";
  UPDATE public.simulation_attempts s SET
    status = CASE WHEN facts.outcome = 'CONFIRMED' THEN 'CONFIRMED' ELSE 'NOT_SENT' END::public."SimulationAttemptStatus",
    resolved_by = actor, resolution_reason = rationale, resolution_evidence = evidence_ref
  WHERE (s.character_id, s.action_id) = (target_character, target_action) AND s.status = 'UNKNOWN';
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY UPDATE public.agent_runs r
    SET state = final_state, state_version = r.state_version + 1
    FROM public.action_proposals a
    WHERE (a.character_id, a.id) = (target_character, target_action)
      AND (r.character_id, r.id, r.state_version) = (a.character_id, a.run_id, expected_version)
      AND r.state = 'RECONCILING'
    RETURNING r.state_version, r.state::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Simulation changed while resolving'; END IF;
END
$$;


--
-- Name: rica_retry_outbox(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_retry_outbox(target_character uuid, target_event uuid, expected_generation integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE current_generation int;
BEGIN
  UPDATE public.outbox o SET generation = generation+1,attempts = 0,
    enqueued_at = NULL,attempt_until = NULL,quarantined_at = NULL
  FROM public.agent_runs r WHERE r.id = o.run_id AND r.character_id = target_character AND r.mode = 'SIMULATION' AND o.type IN ('RunQueued.v1','SimulatedDraftQueued.v1')
    AND o.event_id = target_event AND o.generation = expected_generation AND o.quarantined_at IS NOT NULL;
  IF FOUND THEN RETURN 'UPDATED'; END IF;
  SELECT o.generation INTO current_generation FROM public.outbox o JOIN public.agent_runs r ON r.id = o.run_id
    WHERE o.event_id = target_event AND r.character_id = target_character AND r.mode = 'SIMULATION';
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF current_generation <> expected_generation THEN RETURN 'STALE'; END IF;
  RETURN 'NOT_QUARANTINED';
END
$$;


--
-- Name: rica_review_payload(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT public.rica_bound_simulation_payload(a.character_id, a.id, false)
  FROM public.action_proposals a
  WHERE (a.character_id, a.id) = (target_character, target_action)
$$;


--
-- Name: rica_run_beliefs(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_run_beliefs(target_run uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_run_continuity(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_run_continuity(target_run uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "rica.memory_scope" TO ''
    AS $$
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
$$;


--
-- Name: rica_run_goals(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_run_goals(target_run uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT COALESCE(jsonb_agg(public.rica_goal_json(v) ORDER BY refs.ordinality),'[]'::jsonb)
  FROM public.agent_runs r JOIN public.characters c ON c.id = r.character_id
  CROSS JOIN LATERAL jsonb_array_elements(r.goal_refs) WITH ORDINALITY refs(value,ordinality)
  JOIN public.rica_current_goals g ON (g.character_id,g.identity_id,g.goal_id,g.version)
    = (r.character_id,r.identity_id,(refs.value->>'id')::uuid,(refs.value->>'version')::int)
  JOIN public.goal_versions v ON (v.character_id,v.identity_id,v.goal_id,v.version)
    = (g.character_id,g.identity_id,g.goal_id,g.version)
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND r.auth_epoch = c.auth_epoch
    AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()
$$;


--
-- Name: rica_run_identity_state(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_run_identity_state(target_run uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('revision',s.revision,'ruleVersion',COALESCE(s.rule_version,1),
    'configurationVersion',CASE WHEN s.rule_configuration IS NOT NULL THEN r.identity_version END,
    'sharedEnergy',COALESCE(d.energy,'NORMAL'),
    'motivation',jsonb_build_object('exploration',v.x[1],'expression',v.x[2],'social',v.x[3],'rest',v.x[4]),
    'affect',jsonb_build_object('pleasure',v.x[5],'arousal',v.x[6],'energy',v.x[7]))
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (r.character_id,r.identity_id,r.account_id)
  LEFT JOIN public.identity_state_revisions s ON s.run_id = r.id
  LEFT JOIN public.identity_state_revisions through_event ON through_event.event_id = s.through_event_id
  LEFT JOIN public.daily_energy_projections d ON (d.character_id,d.utc_day)
    = (r.character_id,(r.created_at AT TIME ZONE 'UTC')::date)
  CROSS JOIN LATERAL (
    SELECT public.rica_fold_identity_state(COALESCE(s.state_vector, ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[]),
      extract(epoch FROM r.created_at - COALESCE(s.through_at,r.created_at))::double precision, NULL, through_event.rule_configuration) AS x
  ) v
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND c.status = 'ACTIVE' AND i.status = 'ACTIVE' AND a.status = 'ACTIVE'
    AND (r.core_version,r.identity_version,r.binding_version,r.auth_epoch)
      = (c.active_core_version,i.active_version,a.binding_version,c.auth_epoch)
$$;


--
-- Name: rica_simulated_review_target(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulated_review_target(target_run uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_simulated_writing_style(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulated_writing_style(target_run uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT CASE v.role_profile ->> 'writingStyle'
    WHEN 'formal' THEN 'formal'
    WHEN 'casual' THEN 'casual'
    WHEN 'concise' THEN 'concise'
    ELSE 'neutral'
  END
  FROM public.agent_runs r
  JOIN public.identities i ON (i.character_id, i.id, i.active_version)
    = (r.character_id, r.identity_id, r.identity_version)
  JOIN public.identity_versions v ON (v.character_id, v.identity_id, v.version)
    = (r.character_id, r.identity_id, r.identity_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND i.status = 'ACTIVE'
$$;


--
-- Name: rica_simulation_backlog(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulation_backlog(target_character uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'observedAt', statement_timestamp(),
    'outbox', (
      SELECT jsonb_build_object('count', count(*), 'oldestAt', min(o.created_at),
        'enqueued', count(*) FILTER (WHERE o.enqueued_at IS NOT NULL AND o.quarantined_at IS NULL),
        'quarantined', count(*) FILTER (WHERE o.quarantined_at IS NOT NULL))
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
$$;


--
-- Name: rica_simulation_budget_clock(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulation_budget_clock(target_character uuid) RETURNS TABLE("windowStart" timestamp with time zone, "localHour" integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  zone text;
  checked_at timestamptz;
BEGIN
  SELECT c.timezone INTO zone FROM public.characters c WHERE c.id = target_character FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  checked_at := clock_timestamp();
  RETURN QUERY SELECT date_trunc('day', checked_at, zone),
    extract(hour FROM checked_at AT TIME ZONE zone)::int;
END
$$;


--
-- Name: rica_simulation_daily_metrics(uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulation_daily_metrics(target_character uuid, first_day date, last_day date) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  WITH bounds AS (
    SELECT first_day::timestamp AT TIME ZONE 'UTC' AS starts,(last_day+1)::timestamp AT TIME ZONE 'UTC' AS ends
    WHERE last_day-first_day BETWEEN 0 AND 30
  ), proposals AS (
    SELECT (p.created_at AT TIME ZONE 'UTC')::date AS day,count(*) AS proposed,
      count(*) FILTER (WHERE a.decision = 'APPROVE') AS approved,
      count(*) FILTER (WHERE a.decision = 'REJECT') AS rejected,
      count(*) FILTER (WHERE p.cross_platform_duplicate) AS flagged,
      round(avg(greatest(0,extract(epoch FROM p.created_at-r.created_at)*1000))) AS draft_latency
    FROM bounds b JOIN public.action_proposals p ON p.created_at >= b.starts AND p.created_at < b.ends
    JOIN public.agent_runs r ON (r.character_id,r.id) = (p.character_id,p.run_id) AND r.mode = 'SIMULATION'
    LEFT JOIN public.action_approvals a ON (a.character_id,a.action_id) = (p.character_id,p.id)
    WHERE p.character_id = target_character
    GROUP BY 1
  ), account_receipts AS (
    SELECT (rc.created_at AT TIME ZONE 'UTC')::date AS day,s.account_id,count(*) AS receipts,
      count(*) FILTER (WHERE p.cross_platform_duplicate) AS flagged,
      count(*) FILTER (WHERE a.decision IS DISTINCT FROM 'APPROVE') AS without_approval
    FROM bounds b JOIN public.simulation_receipts rc ON rc.created_at >= b.starts AND rc.created_at < b.ends
    JOIN public.simulation_attempts s ON (s.character_id,s.action_id) = (rc.character_id,rc.action_id)
    JOIN public.action_proposals p ON (p.character_id,p.id) = (s.character_id,s.action_id)
    LEFT JOIN public.action_approvals a ON (a.character_id,a.action_id) = (p.character_id,p.id)
    WHERE rc.character_id = target_character
    GROUP BY 1,2
  ), receipts AS (
    SELECT day,sum(receipts) AS receipts,max(receipts) AS peak_account_receipts,sum(flagged) AS flagged,
      sum(without_approval) AS without_approval FROM account_receipts GROUP BY day
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('utcDay',d.day,
    'proposals',COALESCE(p.proposed,0),'approvals',COALESCE(p.approved,0),'rejections',COALESCE(p.rejected,0),
    'duplicateFlags',COALESCE(p.flagged,0),'draftLatencyMs',p.draft_latency,
    'receipts',COALESCE(r.receipts,0),'peakAccountReceipts',COALESCE(r.peak_account_receipts,0),
    'flaggedReceipts',COALESCE(r.flagged,0),'receiptsWithoutApproval',COALESCE(r.without_approval,0),
    'reservedUnits',COALESCE(u.reserved_units,0),'modelCalls',COALESCE(u.calls,0),'budgetDenials',COALESCE(u.denied,0)
  ) ORDER BY d.day),'[]'::jsonb)
  FROM bounds CROSS JOIN LATERAL generate_series(0,last_day-first_day) AS n
  CROSS JOIN LATERAL (SELECT first_day+n AS day) d
  LEFT JOIN proposals p ON p.day = d.day LEFT JOIN receipts r ON r.day = d.day
  LEFT JOIN public.model_daily_usage u ON (u.character_id,u.utc_day) = (target_character,d.day)
$$;


--
-- Name: rica_simulation_disclosure(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulation_disclosure(target_run uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT btrim(c.hard_profile->>'aiDisclosure')
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id, c.version) = (r.character_id, r.core_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION'
    AND jsonb_typeof(c.hard_profile->'aiDisclosure') = 'string'
    AND char_length(btrim(c.hard_profile->>'aiDisclosure')) BETWEEN 1 AND 240
    AND c.hard_profile->>'aiDisclosure' !~ '[[:cntrl:]]'
$$;


--
-- Name: rica_simulation_payload_allowed(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulation_payload_allowed(target_character uuid, target_action uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT COALESCE(right(payload.content, char_length(disclosure.line)) = disclosure.line, false)
  FROM public.action_proposals a
  CROSS JOIN LATERAL (SELECT public.rica_review_payload(target_character, target_action) AS content) payload
  CROSS JOIN LATERAL (SELECT E'\n\nAI 披露：' || public.rica_simulation_disclosure(a.run_id) AS line) disclosure
  WHERE (a.character_id, a.id) = (target_character, target_action)
$$;


--
-- Name: rica_simulation_reconciliation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_simulation_reconciliation(target_character uuid, target_action uuid) RETURNS TABLE(version integer, state text, outcome text, "evidenceRef" text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT r.state_version, r.state::text, proof.outcome,
    CASE WHEN proof.outcome IS NOT NULL THEN
      encode(sha256(convert_to(a.id::text || ':local-ledger:' || proof.outcome, 'UTF8')), 'hex')
    END
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.simulation_attempts s ON (s.character_id, s.action_id) = (a.character_id, a.id)
  LEFT JOIN public.simulation_receipts receipt ON (receipt.character_id, receipt.action_id) = (s.character_id, s.action_id)
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r.state = 'RECONCILING' AND s.status = 'UNKNOWN'
      AND s.permit_until + interval '15 minutes' <= statement_timestamp()
      THEN CASE WHEN receipt.action_id IS NULL THEN 'DEFINITELY_NOT_SENT' ELSE 'CONFIRMED' END
    END AS outcome
  ) proof
  WHERE (a.character_id, a.id) = (target_character, target_action) AND r.mode = 'SIMULATION'
$$;


--
-- Name: rica_sweep_newbi_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_sweep_newbi_events() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE changed int;
BEGIN
  DELETE FROM public.newbi_events WHERE (account_id,seq) IN (
    SELECT account_id,seq FROM public.newbi_events WHERE occurred_at <= statement_timestamp()-interval '720 hours'
    ORDER BY occurred_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;


--
-- Name: rica_sweep_newbi_retention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_sweep_newbi_retention() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE changed int;
BEGIN
  UPDATE public.newbi_replies SET content = NULL WHERE id IN (
    SELECT id FROM public.newbi_replies
    WHERE content IS NOT NULL AND created_at <= statement_timestamp()-interval '720 hours'
      AND expires_at <= statement_timestamp()
    ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;


--
-- Name: rica_sweep_simulation_retention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_sweep_simulation_retention() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_topic_grams(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_topic_grams(message text) RETURNS text[]
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT ARRAY(SELECT DISTINCT substr(text,n,3)
    FROM generate_series(1,char_length(text)-2) n WHERE char_length(text) >= 12)
  FROM (SELECT left(btrim(regexp_replace(lower(normalize(message,NFKC)),'[[:space:][:punct:]]+',' ','g')),480) AS text) s
$$;


--
-- Name: rica_write_belief(uuid, uuid, uuid, integer, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_write_belief(target_character uuid, target_identity uuid, target_belief uuid, expected integer, configuration jsonb, operator text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
$$;


--
-- Name: rica_write_manual_goal(uuid, uuid, uuid, integer, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rica_write_manual_goal(target_character uuid, target_identity uuid, target_goal uuid, expected integer, configuration jsonb, operator text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
  IF previous.origin = 'SELF' THEN
    IF next_status <> 'CANCELED' THEN RETURN 'SELF_MANAGED'; END IF;
    configuration := configuration || jsonb_build_object('title',previous.title,'priority',previous.priority,
      'budget',previous.budget,'nextStep',previous.next_step);
    deadline := previous.due_at;
  END IF;
  IF previous.status IN ('DONE','CANCELED','EXPIRED')
    OR previous.due_at <= statement_timestamp()
    OR deadline <= statement_timestamp() THEN RETURN 'CLOSED'; END IF;

  IF next_status = 'ACTIVE' AND (SELECT count(*) FROM public.rica_current_goals g
    WHERE (g.character_id,g.identity_id) = (target_character,target_identity)
      AND g.goal_id <> target_goal AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()) >= 3
    THEN RETURN 'LIMIT'; END IF;

  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id,origin,topic,reflection_day)
  VALUES (target_character,target_identity,target_goal,expected+1,configuration->>'title',next_status,
    (configuration->>'priority')::int,(configuration->>'budget')::int,deadline,
    configuration->>'nextStep',configuration->>'reason',operator,COALESCE(previous.origin,'ADMIN'),previous.topic,previous.reflection_day);
  UPDATE public.characters SET auth_epoch = auth_epoch+1 WHERE id = target_character;
  RETURN 'UPDATED';
END
$$;


--
-- Name: action_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_approvals (
    action_id uuid NOT NULL,
    character_id uuid NOT NULL,
    review_digest character varying(64) NOT NULL,
    reviewer_id text NOT NULL,
    decision public."ReviewDecision" NOT NULL,
    reason text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT action_approvals_digest CHECK (((review_digest)::text ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: action_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    run_id uuid NOT NULL,
    target jsonb NOT NULL,
    payload_hash character varying(64) NOT NULL,
    review_digest character varying(64) NOT NULL,
    policy_version integer NOT NULL,
    adapter_version text NOT NULL,
    proposer_id text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    cross_platform_duplicate boolean DEFAULT false NOT NULL,
    adapter_id text NOT NULL,
    adapter_contract_version integer NOT NULL,
    CONSTRAINT action_proposals_adapter_binding_check CHECK (adapter_id <> '' AND adapter_version <> '' AND adapter_contract_version > 0),
    CONSTRAINT action_proposals_digests CHECK ((((payload_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((review_digest)::text ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT action_proposals_expiry CHECK (((expires_at > created_at) AND (policy_version > 0)))
);


--
-- Name: admin_passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_passkeys (
    id character varying(1024) NOT NULL,
    user_id uuid NOT NULL,
    public_key bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    CONSTRAINT admin_passkeys_counter_check CHECK (((counter >= 0) AND (counter <= '4294967295'::bigint)))
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(64) NOT NULL,
    password_hash character varying(128) NOT NULL,
    actor_id character varying(64) NOT NULL,
    can_create boolean DEFAULT false NOT NULL,
    auth_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT admin_users_actor_id_check CHECK (((actor_id)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT admin_users_auth_version_check CHECK ((auth_version > 0)),
    CONSTRAINT admin_users_username_check CHECK (((username)::text ~ '^[a-z0-9][a-z0-9._-]{2,63}$'::text))
);


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    account_id uuid NOT NULL,
    inbound_event_id uuid NOT NULL,
    core_version integer NOT NULL,
    identity_version integer NOT NULL,
    binding_version integer NOT NULL,
    auth_epoch integer NOT NULL,
    mode public."RunMode" DEFAULT 'SIMULATION'::public."RunMode" NOT NULL,
    state public."RunState" DEFAULT 'QUEUED'::public."RunState" NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    state_reason public."RunStateReason",
    state_version integer DEFAULT 1 NOT NULL,
    context_timezone text,
    goal_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    contact_boundary_version integer,
    references_expired_at timestamp with time zone,
    CONSTRAINT agent_runs_auth_epoch_nonnegative CHECK ((auth_epoch >= 0)),
    CONSTRAINT agent_runs_binding_version_positive CHECK ((binding_version > 0)),
    CONSTRAINT agent_runs_state_version_positive CHECK ((state_version > 0))
);


--
-- Name: api_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_idempotency (
    principal_id text NOT NULL,
    route_scope text NOT NULL,
    key text NOT NULL,
    request_hash character varying(64) NOT NULL,
    response jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    actor_id text NOT NULL,
    operation text NOT NULL,
    target_id uuid NOT NULL,
    request_id uuid NOT NULL,
    digest character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: belief_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.belief_evidence (
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    belief_id uuid NOT NULL,
    version integer NOT NULL,
    source_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    memory_revision integer NOT NULL,
    direction text NOT NULL,
    weight double precision NOT NULL,
    CONSTRAINT belief_evidence_direction_check CHECK ((direction = ANY (ARRAY['SUPPORT'::text, 'OPPOSE'::text]))),
    CONSTRAINT belief_evidence_memory_revision_check CHECK ((memory_revision > 0)),
    CONSTRAINT belief_evidence_weight_check CHECK (((weight >= (0)::double precision) AND (weight <= (1)::double precision)))
);


--
-- Name: characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.characters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    status public."EntityStatus" DEFAULT 'PAUSED'::public."EntityStatus" NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    active_core_version integer,
    auth_epoch integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT characters_active_core_required CHECK (((status <> 'ACTIVE'::public."EntityStatus") OR (active_core_version IS NOT NULL))),
    CONSTRAINT characters_auth_epoch_nonnegative CHECK ((auth_epoch >= 0))
);


--
-- Name: commitment_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commitment_revisions (
    commitment_id uuid NOT NULL,
    character_id uuid NOT NULL,
    version integer NOT NULL,
    state public."CommitmentState" NOT NULL,
    due_at timestamp with time zone NOT NULL,
    reason text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT commitment_revisions_valid CHECK (((version > 0) AND ((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 240))))
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    account_id uuid NOT NULL,
    remote_key text NOT NULL,
    display_label text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    no_contact_at timestamp with time zone,
    boundary_changed_at timestamp with time zone,
    boundary_version integer DEFAULT 0 NOT NULL,
    boundary_reason text
);


--
-- Name: context_snapshot_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_snapshot_evidence (
    character_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    memory_revision integer NOT NULL,
    rank integer NOT NULL,
    score double precision NOT NULL,
    estimated_tokens integer NOT NULL,
    CONSTRAINT context_snapshot_evidence_values_in_range CHECK ((((rank >= 1) AND (rank <= 8)) AND ((score >= (0)::double precision) AND (score <= (1)::double precision)) AND ((estimated_tokens >= 1) AND (estimated_tokens <= 1500)) AND (memory_revision > 0)))
);

ALTER TABLE ONLY public.context_snapshot_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: context_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    run_id uuid NOT NULL,
    purpose public."MemoryPurpose" NOT NULL,
    audience_key text NOT NULL,
    query_digest character varying(64) NOT NULL,
    ranking_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT context_snapshots_audience_matches_purpose CHECK ((((purpose = 'PUBLIC_REFERENCE'::public."MemoryPurpose") AND (btrim(audience_key) <> ''::text)) OR ((purpose <> 'PUBLIC_REFERENCE'::public."MemoryPurpose") AND (audience_key = ''::text)) OR ((purpose = 'INTERNAL_CONTEXT'::public."MemoryPurpose") AND (audience_key = 'self-model.v1'::text)))),
    CONSTRAINT context_snapshots_digest_format CHECK (((query_digest)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT context_snapshots_ranker_positive CHECK ((ranking_version > 0))
);

ALTER TABLE ONLY public.context_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    account_id uuid NOT NULL,
    remote_key text NOT NULL,
    channel public."ConversationChannel" NOT NULL,
    private_contact_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT conversations_channel_matches_recipient CHECK ((((channel = 'PRIVATE'::public."ConversationChannel") AND (private_contact_id IS NOT NULL)) OR ((channel = 'PUBLIC'::public."ConversationChannel") AND (private_contact_id IS NULL))))
);


--
-- Name: core_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.core_versions (
    character_id uuid NOT NULL,
    version integer NOT NULL,
    hard_profile jsonb NOT NULL,
    actor_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT core_versions_version_positive CHECK ((version > 0))
);


--
-- Name: daily_energy_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_energy_projections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    utc_day date NOT NULL,
    energy text NOT NULL,
    actor_id text NOT NULL,
    reason text NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_energy_projections_energy_check CHECK ((energy = ANY (ARRAY['LOW'::text, 'NORMAL'::text, 'HIGH'::text])))
);

ALTER TABLE ONLY public.daily_energy_projections FORCE ROW LEVEL SECURITY;


--
-- Name: identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    slug text NOT NULL,
    status public."EntityStatus" DEFAULT 'PAUSED'::public."EntityStatus" NOT NULL,
    active_version integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT identities_active_version_required CHECK (((status <> 'ACTIVE'::public."EntityStatus") OR (active_version IS NOT NULL)))
);


--
-- Name: identity_reflections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_reflections (
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    utc_day date NOT NULL,
    core_version integer NOT NULL,
    identity_version integer NOT NULL,
    fictional_profile boolean NOT NULL,
    observed_receipts integer NOT NULL,
    unverified_events integer NOT NULL,
    candidate_belief_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_reflections_observed_receipts_check CHECK ((observed_receipts >= 0)),
    CONSTRAINT identity_reflections_unverified_events_check CHECK ((unverified_events >= 0))
);


--
-- Name: identity_state_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_state_revisions (
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    revision integer NOT NULL,
    run_id uuid NOT NULL,
    event_id uuid NOT NULL,
    event_kind public."InboundKind" NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    through_at timestamp with time zone NOT NULL,
    through_event_id uuid NOT NULL,
    state_vector double precision[] NOT NULL,
    rule_version integer NOT NULL,
    actor_id text NOT NULL,
    applied_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    rule_configuration jsonb,
    CONSTRAINT identity_state_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT identity_state_revisions_rule_version_check CHECK ((rule_version = 1)),
    CONSTRAINT identity_state_revisions_state_vector_check CHECK ((cardinality(state_vector) = 7))
);

ALTER TABLE ONLY public.identity_state_revisions FORCE ROW LEVEL SECURITY;


--
-- Name: identity_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_versions (
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    version integer NOT NULL,
    role_profile jsonb NOT NULL,
    actor_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT identity_versions_version_positive CHECK ((version > 0))
);


--
-- Name: inbound_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbound_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    account_id uuid NOT NULL,
    source_key character varying(256) NOT NULL,
    kind public."InboundKind" NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    contact_id uuid,
    conversation_id uuid,
    message_text text,
    adapter_id text,
    adapter_version text,
    body_expired_at timestamp with time zone,
    CONSTRAINT inbound_events_adapter_pair CHECK ((((adapter_id IS NULL) AND (adapter_version IS NULL)) OR ((adapter_id = ANY (ARRAY['mock-a'::text, 'mock-b'::text])) AND (adapter_id IS NOT NULL) AND (adapter_version IS NOT NULL) AND (adapter_version <> ''::text) AND ((message_text IS NOT NULL) OR (body_expired_at IS NOT NULL))))),
    CONSTRAINT inbound_events_expired_body_absent CHECK (((body_expired_at IS NULL) OR (message_text IS NULL))),
    CONSTRAINT inbound_events_message_has_conversation CHECK (((message_text IS NULL) OR ((conversation_id IS NOT NULL) AND ((char_length(message_text) >= 1) AND (char_length(message_text) <= 4000)) AND (btrim(message_text) <> ''::text))))
);


--
-- Name: management_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.management_memberships (
    character_id uuid NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    role public."ManagementRole" NOT NULL
);


--
-- Name: memory_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_corrections (
    character_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    revision integer NOT NULL,
    actor_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_corrections_revision_check CHECK ((revision > 1))
);


--
-- Name: memory_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    recipient_identity_id uuid NOT NULL,
    recipient_account_id uuid,
    purpose public."MemoryPurpose" NOT NULL,
    audience text,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    approved_by text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    recipient_contact_id uuid,
    recipient_conversation_id uuid,
    CONSTRAINT memory_grants_audience_matches_purpose CHECK ((((purpose = 'PUBLIC_REFERENCE'::public."MemoryPurpose") AND (audience IS NOT NULL) AND (btrim(audience) <> ''::text)) OR ((purpose <> 'PUBLIC_REFERENCE'::public."MemoryPurpose") AND (audience IS NULL)))),
    CONSTRAINT memory_grants_private_recipient_required CHECK (((((purpose)::text = 'PRIVATE_REPLY'::text) AND (recipient_account_id IS NOT NULL) AND (recipient_conversation_id IS NOT NULL) AND (recipient_contact_id IS NOT NULL)) OR (((purpose)::text <> 'PRIVATE_REPLY'::text) AND (recipient_conversation_id IS NULL) AND (recipient_contact_id IS NULL)))),
    CONSTRAINT memory_grants_valid_window CHECK ((valid_until > valid_from))
);

ALTER TABLE ONLY public.memory_grants FORCE ROW LEVEL SECURITY;


--
-- Name: memory_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_sources (
    character_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    source_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.memory_sources FORCE ROW LEVEL SECURITY;


--
-- Name: model_daily_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_daily_usage (
    character_id uuid NOT NULL,
    utc_day date NOT NULL,
    reserved_units integer DEFAULT 0 NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    denied integer DEFAULT 0 NOT NULL,
    CONSTRAINT model_daily_usage_calls_check CHECK ((calls >= 0)),
    CONSTRAINT model_daily_usage_denied_check CHECK ((denied >= 0)),
    CONSTRAINT model_daily_usage_reserved_units_check CHECK ((reserved_units >= 0))
);


--
-- Name: newbi_event_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.newbi_event_checkpoints (
    account_id uuid NOT NULL,
    cursor character varying(2048),
    next_poll_at timestamp with time zone DEFAULT now() NOT NULL,
    ticket uuid,
    lease_until timestamp with time zone,
    history_lost_count integer DEFAULT 0 NOT NULL,
    last_history_lost_at timestamp with time zone,
    CONSTRAINT newbi_event_checkpoints_check CHECK (((ticket IS NULL) = (lease_until IS NULL))),
    CONSTRAINT newbi_event_checkpoints_check1 CHECK (((history_lost_count = 0) = (last_history_lost_at IS NULL))),
    CONSTRAINT newbi_event_checkpoints_history_lost_count_check CHECK ((history_lost_count >= 0))
);


--
-- Name: newbi_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.newbi_events (
    account_id uuid NOT NULL,
    seq character varying(40) NOT NULL,
    type text NOT NULL,
    post_id uuid NOT NULL,
    comment_id uuid,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT newbi_events_seq_check CHECK (((seq)::text ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT newbi_events_type_check CHECK ((type = ANY (ARRAY['POST_REPLIED'::text, 'COMMENT_REPLIED'::text, 'AGENT_MENTIONED'::text])))
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    event_id uuid NOT NULL,
    type text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    enqueued_at timestamp with time zone,
    processed_at timestamp with time zone,
    run_id uuid,
    generation integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    attempt_until timestamp with time zone,
    quarantined_at timestamp with time zone,
    CONSTRAINT outbox_attempts_check CHECK (((attempts >= 0) AND (attempts <= 4))),
    CONSTRAINT outbox_draft_queued_requires_run CHECK (((type <> 'SimulatedDraftQueued.v1'::text) OR (run_id IS NOT NULL))),
    CONSTRAINT outbox_generation_check CHECK ((generation >= 0)),
    CONSTRAINT outbox_quarantine_valid CHECK (((quarantined_at IS NULL) OR ((attempts = 4) AND (attempt_until IS NULL) AND (processed_at IS NULL)))),
    CONSTRAINT outbox_run_queued_requires_run CHECK (((type <> 'RunQueued.v1'::text) OR (run_id IS NOT NULL)))
);


--
-- Name: platform_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    platform text NOT NULL,
    instance_key text NOT NULL,
    remote_account_id text NOT NULL,
    status public."AccountStatus" DEFAULT 'PENDING'::public."AccountStatus" NOT NULL,
    binding_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT platform_accounts_binding_version_positive CHECK ((binding_version > 0))
);


--
-- Name: rica_current_goals; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.rica_current_goals AS
 SELECT DISTINCT ON (character_id, identity_id, goal_id) character_id,
    identity_id,
    goal_id,
    version,
    title,
    status,
    priority,
    budget,
    due_at,
    next_step,
    reason,
    actor_id,
    created_at,
    origin,
    topic,
    reflection_day
   FROM public.goal_versions
  ORDER BY character_id, identity_id, goal_id, version DESC;


--
-- Name: schedule_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_occurrences (
    schedule_id uuid NOT NULL,
    character_id uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    schedule_version integer NOT NULL,
    run_id uuid NOT NULL
);


--
-- Name: simulated_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulated_drafts (
    character_id uuid NOT NULL,
    run_id uuid NOT NULL,
    content text,
    decision_evidence_ids uuid[] NOT NULL,
    writing_evidence_ids uuid[] NOT NULL,
    citation_ids uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    model_id text,
    model_version text,
    belief_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT simulated_drafts_belief_refs_check CHECK (((jsonb_typeof(belief_refs) = 'array'::text) AND (jsonb_array_length(belief_refs) <= 8))),
    CONSTRAINT simulated_drafts_content_length CHECK (((content IS NULL) OR (((char_length(content) >= 1) AND (char_length(content) <= 4000)) AND (btrim(content) <> ''::text)))),
    CONSTRAINT simulated_drafts_evidence_bounds CHECK (((cardinality(decision_evidence_ids) <= 8) AND (cardinality(writing_evidence_ids) <= 8) AND (cardinality(citation_ids) <= 8) AND (citation_ids <@ writing_evidence_ids))),
    CONSTRAINT simulated_drafts_model_pair CHECK ((((model_id IS NULL) AND (model_version IS NULL)) OR ((model_id IS NOT NULL) AND (model_version IS NOT NULL) AND (model_id <> ''::text) AND (model_version <> ''::text))))
);

ALTER TABLE ONLY public.simulated_drafts FORCE ROW LEVEL SECURITY;


--
-- Name: simulation_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_attempts (
    action_id uuid NOT NULL,
    character_id uuid NOT NULL,
    account_id uuid NOT NULL,
    status public."SimulationAttemptStatus" DEFAULT 'PERMITTED'::public."SimulationAttemptStatus" NOT NULL,
    window_start timestamp with time zone NOT NULL,
    permit_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    contact_id uuid,
    resolution_evidence text,
    resolution_reason text,
    resolved_by text,
    review_digest character varying(64) NOT NULL,
    CONSTRAINT simulation_attempts_review_digest_check CHECK (((review_digest)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT simulation_resolution_complete CHECK ((((resolved_by IS NULL) AND (resolution_reason IS NULL) AND (resolution_evidence IS NULL)) OR ((resolved_by IS NOT NULL) AND (resolution_reason IS NOT NULL) AND (resolution_evidence IS NOT NULL) AND (status = ANY (ARRAY['CONFIRMED'::public."SimulationAttemptStatus", 'NOT_SENT'::public."SimulationAttemptStatus"])))))
);


--
-- Name: simulation_commitments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_commitments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    action_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    title text NOT NULL,
    state public."CommitmentState" DEFAULT 'OPEN'::public."CommitmentState" NOT NULL,
    due_at timestamp with time zone NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT simulation_commitments_valid CHECK (((version > 0) AND ((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 120))))
);


--
-- Name: simulation_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_receipts (
    action_id uuid NOT NULL,
    character_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: simulation_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    account_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    contact_id uuid,
    schedule_key text NOT NULL,
    zone text NOT NULL,
    kind public."ScheduleKind" NOT NULL,
    local_time text,
    due_at timestamp with time zone,
    next_at timestamp with time zone,
    enabled boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT simulation_schedule_shape CHECK (((version > 0) AND (((kind = 'DAILY'::public."ScheduleKind") AND (local_time IS NOT NULL) AND (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text) AND (due_at IS NULL)) OR ((kind = 'REMINDER'::public."ScheduleKind") AND (due_at IS NOT NULL) AND (local_time IS NULL))) AND (enabled OR (next_at IS NULL))))
);


--
-- Name: sources_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sources_registry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    character_id uuid NOT NULL,
    identity_id uuid,
    account_id uuid,
    kind text NOT NULL,
    source_key text NOT NULL,
    classification public."MemoryVisibility" NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    conversation_id uuid,
    CONSTRAINT sources_registry_conversation_requires_account CHECK (((conversation_id IS NULL) OR (account_id IS NOT NULL))),
    CONSTRAINT sources_registry_scope_requires_owner CHECK ((((account_id IS NULL) OR (identity_id IS NOT NULL)) AND ((classification = 'PUBLIC'::public."MemoryVisibility") OR (identity_id IS NOT NULL))))
);

ALTER TABLE ONLY public.sources_registry FORCE ROW LEVEL SECURITY;


--
-- Name: action_approvals action_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_approvals
    ADD CONSTRAINT action_approvals_pkey PRIMARY KEY (action_id);


--
-- Name: action_proposals action_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_proposals
    ADD CONSTRAINT action_proposals_pkey PRIMARY KEY (id);


--
-- Name: admin_passkeys admin_passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_passkeys
    ADD CONSTRAINT admin_passkeys_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_actor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_actor_id_key UNIQUE (actor_id);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_username_key UNIQUE (username);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: api_idempotency api_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_idempotency
    ADD CONSTRAINT api_idempotency_pkey PRIMARY KEY (principal_id, route_scope, key);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: belief_evidence belief_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_evidence
    ADD CONSTRAINT belief_evidence_pkey PRIMARY KEY (character_id, identity_id, belief_id, version, source_id);


--
-- Name: belief_versions belief_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_versions
    ADD CONSTRAINT belief_versions_pkey PRIMARY KEY (character_id, identity_id, belief_id, version);


--
-- Name: characters characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_pkey PRIMARY KEY (id);


--
-- Name: commitment_revisions commitment_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commitment_revisions
    ADD CONSTRAINT commitment_revisions_pkey PRIMARY KEY (commitment_id, version);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: context_snapshot_evidence context_snapshot_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_snapshot_evidence
    ADD CONSTRAINT context_snapshot_evidence_pkey PRIMARY KEY (character_id, snapshot_id, rank);


--
-- Name: context_snapshots context_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_snapshots
    ADD CONSTRAINT context_snapshots_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: core_versions core_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_versions
    ADD CONSTRAINT core_versions_pkey PRIMARY KEY (character_id, version);


--
-- Name: daily_energy_projections daily_energy_projections_character_id_utc_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_energy_projections
    ADD CONSTRAINT daily_energy_projections_character_id_utc_day_key UNIQUE (character_id, utc_day);


--
-- Name: daily_energy_projections daily_energy_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_energy_projections
    ADD CONSTRAINT daily_energy_projections_pkey PRIMARY KEY (id);


--
-- Name: goal_versions goal_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_versions
    ADD CONSTRAINT goal_versions_pkey PRIMARY KEY (character_id, identity_id, goal_id, version);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identity_reflections identity_reflections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_reflections
    ADD CONSTRAINT identity_reflections_pkey PRIMARY KEY (character_id, identity_id, utc_day);


--
-- Name: identity_state_revisions identity_state_revisions_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_state_revisions
    ADD CONSTRAINT identity_state_revisions_event_id_key UNIQUE (event_id);


--
-- Name: identity_state_revisions identity_state_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_state_revisions
    ADD CONSTRAINT identity_state_revisions_pkey PRIMARY KEY (character_id, identity_id, revision);


--
-- Name: identity_state_revisions identity_state_revisions_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_state_revisions
    ADD CONSTRAINT identity_state_revisions_run_id_key UNIQUE (run_id);


--
-- Name: identity_versions identity_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_versions
    ADD CONSTRAINT identity_versions_pkey PRIMARY KEY (character_id, identity_id, version);


--
-- Name: inbound_events inbound_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_pkey PRIMARY KEY (id);


--
-- Name: management_memberships management_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_memberships
    ADD CONSTRAINT management_memberships_pkey PRIMARY KEY (character_id, issuer, subject, role);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_corrections memory_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_corrections
    ADD CONSTRAINT memory_corrections_pkey PRIMARY KEY (character_id, memory_id, revision);


--
-- Name: memory_grants memory_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_grants
    ADD CONSTRAINT memory_grants_pkey PRIMARY KEY (id);


--
-- Name: memory_sources memory_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_pkey PRIMARY KEY (character_id, memory_id, source_id);


--
-- Name: model_daily_usage model_daily_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_daily_usage
    ADD CONSTRAINT model_daily_usage_pkey PRIMARY KEY (character_id, utc_day);


--
-- Name: newbi_event_checkpoints newbi_event_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_event_checkpoints
    ADD CONSTRAINT newbi_event_checkpoints_pkey PRIMARY KEY (account_id);


--
-- Name: newbi_events newbi_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_events
    ADD CONSTRAINT newbi_events_pkey PRIMARY KEY (account_id, seq);


--
-- Name: newbi_replies newbi_replies_account_id_remote_comment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_replies
    ADD CONSTRAINT newbi_replies_account_id_remote_comment_id_key UNIQUE (account_id, remote_comment_id);


--
-- Name: newbi_replies newbi_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_replies
    ADD CONSTRAINT newbi_replies_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (event_id);


--
-- Name: platform_accounts platform_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_accounts
    ADD CONSTRAINT platform_accounts_pkey PRIMARY KEY (id);


--
-- Name: schedule_occurrences schedule_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_pkey PRIMARY KEY (schedule_id, scheduled_at);


--
-- Name: simulated_drafts simulated_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulated_drafts
    ADD CONSTRAINT simulated_drafts_pkey PRIMARY KEY (character_id, run_id);


--
-- Name: simulation_attempts simulation_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_attempts
    ADD CONSTRAINT simulation_attempts_pkey PRIMARY KEY (action_id);


--
-- Name: simulation_commitments simulation_commitments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_commitments
    ADD CONSTRAINT simulation_commitments_pkey PRIMARY KEY (id);


--
-- Name: simulation_receipts simulation_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_receipts
    ADD CONSTRAINT simulation_receipts_pkey PRIMARY KEY (action_id);


--
-- Name: simulation_schedules simulation_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_schedules
    ADD CONSTRAINT simulation_schedules_pkey PRIMARY KEY (id);


--
-- Name: sources_registry sources_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources_registry
    ADD CONSTRAINT sources_registry_pkey PRIMARY KEY (id);


--
-- Name: action_approvals_character_id_action_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_approvals_character_id_action_id_key ON public.action_approvals USING btree (character_id, action_id);


--
-- Name: action_proposals_character_id_created_at_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_proposals_character_id_created_at_id_idx ON public.action_proposals USING btree (character_id, created_at, id);


--
-- Name: action_proposals_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_proposals_character_id_id_key ON public.action_proposals USING btree (character_id, id);


--
-- Name: action_proposals_character_id_run_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_proposals_character_id_run_id_key ON public.action_proposals USING btree (character_id, run_id);


--
-- Name: action_proposals_run_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_proposals_run_id_key ON public.action_proposals USING btree (run_id);


--
-- Name: admin_passkeys_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_passkeys_user_id_idx ON public.admin_passkeys USING btree (user_id);


--
-- Name: agent_runs_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_runs_character_id_id_key ON public.agent_runs USING btree (character_id, id);


--
-- Name: agent_runs_inbound_event_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_runs_inbound_event_id_key ON public.agent_runs USING btree (inbound_event_id);


--
-- Name: api_idempotency_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_idempotency_expires_at_idx ON public.api_idempotency USING btree (expires_at);


--
-- Name: audit_log_character_id_created_at_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_character_id_created_at_id_idx ON public.audit_log USING btree (character_id, created_at, id);


--
-- Name: belief_evidence_character_id_memory_id_source_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX belief_evidence_character_id_memory_id_source_id_idx ON public.belief_evidence USING btree (character_id, memory_id, source_id);


--
-- Name: characters_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX characters_slug_key ON public.characters USING btree (slug);


--
-- Name: contacts_account_id_remote_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_account_id_remote_key_key ON public.contacts USING btree (account_id, remote_key);


--
-- Name: contacts_character_id_identity_id_account_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_character_id_identity_id_account_id_id_key ON public.contacts USING btree (character_id, identity_id, account_id, id);


--
-- Name: context_snapshot_evidence_character_id_snapshot_id_memory_i_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX context_snapshot_evidence_character_id_snapshot_id_memory_i_key ON public.context_snapshot_evidence USING btree (character_id, snapshot_id, memory_id);


--
-- Name: context_snapshots_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX context_snapshots_character_id_id_key ON public.context_snapshots USING btree (character_id, id);


--
-- Name: context_snapshots_run_id_purpose_audience_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX context_snapshots_run_id_purpose_audience_key_key ON public.context_snapshots USING btree (run_id, purpose, audience_key);


--
-- Name: conversations_account_id_remote_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversations_account_id_remote_key_key ON public.conversations USING btree (account_id, remote_key);


--
-- Name: conversations_character_id_identity_id_account_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversations_character_id_identity_id_account_id_id_key ON public.conversations USING btree (character_id, identity_id, account_id, id);


--
-- Name: conversations_private_recipient_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversations_private_recipient_key ON public.conversations USING btree (character_id, identity_id, account_id, id, private_contact_id);


--
-- Name: goal_versions_character_id_identity_id_reflection_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_versions_character_id_identity_id_reflection_day_idx ON public.goal_versions USING btree (character_id, identity_id, reflection_day);


--
-- Name: identities_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX identities_character_id_id_key ON public.identities USING btree (character_id, id);


--
-- Name: identities_character_id_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX identities_character_id_slug_key ON public.identities USING btree (character_id, slug);


--
-- Name: identity_state_event_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_state_event_order_idx ON public.identity_state_revisions USING btree (character_id, identity_id, effective_at, event_id);


--
-- Name: inbound_context_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_context_history_idx ON public.inbound_events USING btree (character_id, identity_id, account_id, conversation_id, contact_id, occurred_at, id);


--
-- Name: inbound_duplicate_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_duplicate_window_idx ON public.inbound_events USING btree (character_id, identity_id, received_at, id);


--
-- Name: inbound_events_account_id_source_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inbound_events_account_id_source_key_key ON public.inbound_events USING btree (account_id, source_key);


--
-- Name: inbound_events_character_id_identity_id_account_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inbound_events_character_id_identity_id_account_id_id_key ON public.inbound_events USING btree (character_id, identity_id, account_id, id);


--
-- Name: management_memberships_issuer_subject_character_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX management_memberships_issuer_subject_character_id_idx ON public.management_memberships USING btree (issuer, subject, character_id);


--
-- Name: memories_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memories_character_id_id_key ON public.memories USING btree (character_id, id);


--
-- Name: memories_character_id_parent_memory_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_character_id_parent_memory_id_idx ON public.memories USING btree (character_id, parent_memory_id);


--
-- Name: memories_character_id_status_scope_identity_id_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_character_id_status_scope_identity_id_account_id_idx ON public.memories USING btree (character_id, status, scope, identity_id, account_id);


--
-- Name: memory_grants_character_id_recipient_identity_id_purpose_me_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_grants_character_id_recipient_identity_id_purpose_me_idx ON public.memory_grants USING btree (character_id, recipient_identity_id, purpose, memory_id);


--
-- Name: memory_sources_character_id_source_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_sources_character_id_source_id_idx ON public.memory_sources USING btree (character_id, source_id);


--
-- Name: newbi_events_account_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX newbi_events_account_id_occurred_at_idx ON public.newbi_events USING btree (account_id, occurred_at);


--
-- Name: newbi_events_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX newbi_events_occurred_at_idx ON public.newbi_events USING btree (occurred_at);


--
-- Name: outbox_processed_at_enqueued_at_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_processed_at_enqueued_at_created_at_idx ON public.outbox USING btree (processed_at, enqueued_at, created_at);


--
-- Name: outbox_type_run_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outbox_type_run_id_key ON public.outbox USING btree (type, run_id);


--
-- Name: platform_accounts_character_id_identity_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platform_accounts_character_id_identity_id_id_key ON public.platform_accounts USING btree (character_id, identity_id, id);


--
-- Name: platform_accounts_platform_instance_key_remote_account_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platform_accounts_platform_instance_key_remote_account_id_key ON public.platform_accounts USING btree (platform, instance_key, remote_account_id);


--
-- Name: schedule_occurrences_character_id_run_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schedule_occurrences_character_id_run_id_key ON public.schedule_occurrences USING btree (character_id, run_id);


--
-- Name: simulation_attempts_account_id_contact_id_permit_until_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_attempts_account_id_contact_id_permit_until_idx ON public.simulation_attempts USING btree (account_id, contact_id, permit_until);


--
-- Name: simulation_attempts_account_id_window_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_attempts_account_id_window_start_idx ON public.simulation_attempts USING btree (account_id, window_start);


--
-- Name: simulation_attempts_character_id_action_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_attempts_character_id_action_id_key ON public.simulation_attempts USING btree (character_id, action_id);


--
-- Name: simulation_attempts_status_permit_until_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_attempts_status_permit_until_idx ON public.simulation_attempts USING btree (status, permit_until);


--
-- Name: simulation_commitments_character_id_action_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_commitments_character_id_action_id_key ON public.simulation_commitments USING btree (character_id, action_id);


--
-- Name: simulation_commitments_character_id_created_at_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_commitments_character_id_created_at_id_idx ON public.simulation_commitments USING btree (character_id, created_at, id);


--
-- Name: simulation_commitments_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_commitments_character_id_id_key ON public.simulation_commitments USING btree (character_id, id);


--
-- Name: simulation_commitments_character_id_schedule_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_commitments_character_id_schedule_id_key ON public.simulation_commitments USING btree (character_id, schedule_id);


--
-- Name: simulation_one_active_attempt_per_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_one_active_attempt_per_account ON public.simulation_attempts USING btree (account_id) WHERE (status = ANY (ARRAY['PERMITTED'::public."SimulationAttemptStatus", 'UNKNOWN'::public."SimulationAttemptStatus"]));


--
-- Name: simulation_receipts_character_id_action_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_receipts_character_id_action_id_key ON public.simulation_receipts USING btree (character_id, action_id);


--
-- Name: simulation_receipts_character_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_receipts_character_id_created_at_idx ON public.simulation_receipts USING btree (character_id, created_at);


--
-- Name: simulation_schedules_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_schedules_character_id_id_key ON public.simulation_schedules USING btree (character_id, id);


--
-- Name: simulation_schedules_character_id_schedule_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX simulation_schedules_character_id_schedule_key_key ON public.simulation_schedules USING btree (character_id, schedule_key);


--
-- Name: simulation_schedules_enabled_next_at_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX simulation_schedules_enabled_next_at_id_idx ON public.simulation_schedules USING btree (enabled, next_at, id);


--
-- Name: sources_registry_character_id_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sources_registry_character_id_id_key ON public.sources_registry USING btree (character_id, id);


--
-- Name: sources_registry_character_id_kind_source_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sources_registry_character_id_kind_source_key_key ON public.sources_registry USING btree (character_id, kind, source_key);


--
-- Name: identities cancel_out_of_policy_goals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cancel_out_of_policy_goals AFTER UPDATE OF active_version ON public.identities FOR EACH ROW WHEN ((old.active_version IS DISTINCT FROM new.active_version)) EXECUTE FUNCTION public.rica_cancel_out_of_policy_goals();


--
-- Name: inbound_events capture_contact_opt_out; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capture_contact_opt_out AFTER INSERT ON public.inbound_events FOR EACH ROW EXECUTE FUNCTION public.rica_capture_contact_opt_out();


--
-- Name: characters characters_clear_stale_draft_content; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER characters_clear_stale_draft_content AFTER UPDATE OF auth_epoch ON public.characters FOR EACH ROW WHEN ((old.auth_epoch IS DISTINCT FROM new.auth_epoch)) EXECUTE FUNCTION public.rica_clear_stale_draft_content();


--
-- Name: characters characters_invalidate_action_reviews; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER characters_invalidate_action_reviews AFTER UPDATE OF auth_epoch ON public.characters FOR EACH ROW WHEN ((old.auth_epoch IS DISTINCT FROM new.auth_epoch)) EXECUTE FUNCTION public.rica_invalidate_action_reviews();


--
-- Name: conversations conversations_keep_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER conversations_keep_binding BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.keep_conversation_binding();


--
-- Name: memories memories_check_derivation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memories_check_derivation BEFORE INSERT OR UPDATE OF character_id, identity_id, account_id, conversation_id, scope, visibility, expires_at, parent_memory_id ON public.memories FOR EACH ROW EXECUTE FUNCTION public.rica_check_memory_derivation();


--
-- Name: memories memories_copy_sources; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memories_copy_sources AFTER INSERT ON public.memories FOR EACH ROW WHEN ((new.parent_memory_id IS NOT NULL)) EXECUTE FUNCTION public.rica_copy_memory_sources();


--
-- Name: memory_sources memory_sources_freeze_after_derivation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memory_sources_freeze_after_derivation BEFORE INSERT ON public.memory_sources FOR EACH ROW EXECUTE FUNCTION public.rica_freeze_memory_sources();


--
-- Name: newbi_replies newbi_replies_guard_executor; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER newbi_replies_guard_executor BEFORE INSERT OR UPDATE OF executor_key, approved_executor_key, status ON public.newbi_replies FOR EACH ROW EXECUTE FUNCTION public.rica_guard_newbi_reply_executor();


--
-- Name: agent_runs pin_run_contact_boundary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pin_run_contact_boundary BEFORE INSERT ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION public.rica_pin_run_contact_boundary();


--
-- Name: agent_runs pin_run_timezone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pin_run_timezone BEFORE INSERT ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION public.rica_pin_run_timezone();


--
-- Name: identity_reflections plan_reflection_goal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER plan_reflection_goal AFTER INSERT ON public.identity_reflections FOR EACH ROW EXECUTE FUNCTION public.rica_plan_reflection_goal();


--
-- Name: agent_runs record_identity_state; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER record_identity_state AFTER UPDATE OF state ON public.agent_runs FOR EACH ROW WHEN (((old.state = 'QUEUED'::public."RunState") AND (new.state = 'CONTEXT_READY'::public."RunState"))) EXECUTE FUNCTION public.rica_record_identity_state();


--
-- Name: schedule_occurrences schedule_occurrences_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedule_occurrences_audit AFTER INSERT ON public.schedule_occurrences FOR EACH ROW EXECUTE FUNCTION public.rica_audit_schedule_occurrence();


--
-- Name: simulation_schedules schedules_cancel_previous_runs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedules_cancel_previous_runs AFTER UPDATE OF version ON public.simulation_schedules FOR EACH ROW WHEN ((old.version IS DISTINCT FROM new.version)) EXECUTE FUNCTION public.rica_cancel_previous_schedule_runs();


--
-- Name: simulation_attempts simulation_permit_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER simulation_permit_binding BEFORE INSERT ON public.simulation_attempts FOR EACH ROW EXECUTE FUNCTION public.rica_guard_simulation_permit_binding();


--
-- Name: action_approvals action_approvals_character_id_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_approvals
    ADD CONSTRAINT action_approvals_character_id_action_id_fkey FOREIGN KEY (character_id, action_id) REFERENCES public.action_proposals(character_id, id) ON DELETE RESTRICT;


--
-- Name: action_proposals action_proposals_character_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_proposals
    ADD CONSTRAINT action_proposals_character_id_run_id_fkey FOREIGN KEY (character_id, run_id) REFERENCES public.simulated_drafts(character_id, run_id) ON DELETE RESTRICT;


--
-- Name: admin_passkeys admin_passkeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_passkeys
    ADD CONSTRAINT admin_passkeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_character_id_core_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_character_id_core_version_fkey FOREIGN KEY (character_id, core_version) REFERENCES public.core_versions(character_id, version) ON DELETE RESTRICT;


--
-- Name: agent_runs agent_runs_character_id_identity_id_account_id_inbound_eve_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_character_id_identity_id_account_id_inbound_eve_fkey FOREIGN KEY (character_id, identity_id, account_id, inbound_event_id) REFERENCES public.inbound_events(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: agent_runs agent_runs_character_id_identity_id_identity_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_character_id_identity_id_identity_version_fkey FOREIGN KEY (character_id, identity_id, identity_version) REFERENCES public.identity_versions(character_id, identity_id, version) ON DELETE RESTRICT;


--
-- Name: audit_log audit_log_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: belief_evidence belief_evidence_character_id_identity_id_belief_id_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_evidence
    ADD CONSTRAINT belief_evidence_character_id_identity_id_belief_id_version_fkey FOREIGN KEY (character_id, identity_id, belief_id, version) REFERENCES public.belief_versions(character_id, identity_id, belief_id, version) ON DELETE RESTRICT;


--
-- Name: belief_evidence belief_evidence_character_id_memory_id_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_evidence
    ADD CONSTRAINT belief_evidence_character_id_memory_id_source_id_fkey FOREIGN KEY (character_id, memory_id, source_id) REFERENCES public.memory_sources(character_id, memory_id, source_id) ON DELETE RESTRICT;


--
-- Name: belief_versions belief_versions_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_versions
    ADD CONSTRAINT belief_versions_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: characters characters_id_active_core_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_id_active_core_version_fkey FOREIGN KEY (id, active_core_version) REFERENCES public.core_versions(character_id, version);


--
-- Name: commitment_revisions commitment_revisions_character_id_commitment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commitment_revisions
    ADD CONSTRAINT commitment_revisions_character_id_commitment_id_fkey FOREIGN KEY (character_id, commitment_id) REFERENCES public.simulation_commitments(character_id, id) ON DELETE RESTRICT;


--
-- Name: contacts contacts_character_id_identity_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: context_snapshot_evidence context_snapshot_evidence_character_id_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_snapshot_evidence
    ADD CONSTRAINT context_snapshot_evidence_character_id_memory_id_fkey FOREIGN KEY (character_id, memory_id) REFERENCES public.memories(character_id, id) ON DELETE RESTRICT;


--
-- Name: context_snapshot_evidence context_snapshot_evidence_character_id_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_snapshot_evidence
    ADD CONSTRAINT context_snapshot_evidence_character_id_snapshot_id_fkey FOREIGN KEY (character_id, snapshot_id) REFERENCES public.context_snapshots(character_id, id) ON DELETE RESTRICT;


--
-- Name: context_snapshots context_snapshots_character_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_snapshots
    ADD CONSTRAINT context_snapshots_character_id_run_id_fkey FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs(character_id, id) ON DELETE RESTRICT;


--
-- Name: conversations conversations_character_id_identity_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: conversations conversations_character_id_identity_id_account_id_private__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_character_id_identity_id_account_id_private__fkey FOREIGN KEY (character_id, identity_id, account_id, private_contact_id) REFERENCES public.contacts(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: core_versions core_versions_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_versions
    ADD CONSTRAINT core_versions_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: daily_energy_projections daily_energy_projections_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_energy_projections
    ADD CONSTRAINT daily_energy_projections_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: goal_versions goal_versions_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_versions
    ADD CONSTRAINT goal_versions_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: goal_versions goal_versions_character_id_identity_id_reflection_day_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goal_versions
    ADD CONSTRAINT goal_versions_character_id_identity_id_reflection_day_fkey FOREIGN KEY (character_id, identity_id, reflection_day) REFERENCES public.identity_reflections(character_id, identity_id, utc_day) ON DELETE RESTRICT;


--
-- Name: identities identities_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: identities identities_character_id_id_active_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_character_id_id_active_version_fkey FOREIGN KEY (character_id, id, active_version) REFERENCES public.identity_versions(character_id, identity_id, version);


--
-- Name: identity_reflections identity_reflections_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_reflections
    ADD CONSTRAINT identity_reflections_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: identity_state_revisions identity_state_revisions_character_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_state_revisions
    ADD CONSTRAINT identity_state_revisions_character_id_run_id_fkey FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs(character_id, id) ON DELETE RESTRICT;


--
-- Name: identity_versions identity_versions_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_versions
    ADD CONSTRAINT identity_versions_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: inbound_events inbound_events_character_id_identity_id_account_id_contact_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_character_id_identity_id_account_id_contact_fkey FOREIGN KEY (character_id, identity_id, account_id, contact_id) REFERENCES public.contacts(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: inbound_events inbound_events_character_id_identity_id_account_id_convers_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_character_id_identity_id_account_id_convers_fkey FOREIGN KEY (character_id, identity_id, account_id, conversation_id) REFERENCES public.conversations(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: inbound_events inbound_events_character_id_identity_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_events
    ADD CONSTRAINT inbound_events_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: management_memberships management_memberships_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.management_memberships
    ADD CONSTRAINT management_memberships_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: memories memories_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: memories memories_character_id_identity_id_account_id_conversation__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_character_id_identity_id_account_id_conversation__fkey FOREIGN KEY (character_id, identity_id, account_id, conversation_id) REFERENCES public.conversations(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: memories memories_character_id_identity_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: memories memories_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: memories memories_character_id_parent_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_character_id_parent_memory_id_fkey FOREIGN KEY (character_id, parent_memory_id) REFERENCES public.memories(character_id, id);


--
-- Name: memory_corrections memory_corrections_character_id_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_corrections
    ADD CONSTRAINT memory_corrections_character_id_memory_id_fkey FOREIGN KEY (character_id, memory_id) REFERENCES public.memories(character_id, id) ON DELETE RESTRICT;


--
-- Name: memory_grants memory_grants_character_id_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_grants
    ADD CONSTRAINT memory_grants_character_id_memory_id_fkey FOREIGN KEY (character_id, memory_id) REFERENCES public.memories(character_id, id) ON DELETE RESTRICT;


--
-- Name: memory_grants memory_grants_character_id_recipient_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_grants
    ADD CONSTRAINT memory_grants_character_id_recipient_identity_id_fkey FOREIGN KEY (character_id, recipient_identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: memory_grants memory_grants_character_id_recipient_identity_id_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_grants
    ADD CONSTRAINT memory_grants_character_id_recipient_identity_id_recipient_fkey FOREIGN KEY (character_id, recipient_identity_id, recipient_account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: memory_grants memory_grants_private_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_grants
    ADD CONSTRAINT memory_grants_private_recipient_fkey FOREIGN KEY (character_id, recipient_identity_id, recipient_account_id, recipient_conversation_id, recipient_contact_id) REFERENCES public.conversations(character_id, identity_id, account_id, id, private_contact_id) ON DELETE RESTRICT;


--
-- Name: memory_sources memory_sources_character_id_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_character_id_memory_id_fkey FOREIGN KEY (character_id, memory_id) REFERENCES public.memories(character_id, id) ON DELETE RESTRICT;


--
-- Name: memory_sources memory_sources_character_id_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_sources
    ADD CONSTRAINT memory_sources_character_id_source_id_fkey FOREIGN KEY (character_id, source_id) REFERENCES public.sources_registry(character_id, id) ON DELETE RESTRICT;


--
-- Name: model_daily_usage model_daily_usage_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_daily_usage
    ADD CONSTRAINT model_daily_usage_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: newbi_event_checkpoints newbi_event_checkpoints_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_event_checkpoints
    ADD CONSTRAINT newbi_event_checkpoints_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.platform_accounts(id) ON DELETE CASCADE;


--
-- Name: newbi_events newbi_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_events
    ADD CONSTRAINT newbi_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.platform_accounts(id) ON DELETE CASCADE;


--
-- Name: newbi_replies newbi_replies_character_id_identity_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newbi_replies
    ADD CONSTRAINT newbi_replies_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: outbox outbox_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE RESTRICT;


--
-- Name: platform_accounts platform_accounts_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_accounts
    ADD CONSTRAINT platform_accounts_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: schedule_occurrences schedule_occurrences_character_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_character_id_run_id_fkey FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs(character_id, id) ON DELETE RESTRICT;


--
-- Name: schedule_occurrences schedule_occurrences_character_id_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_character_id_schedule_id_fkey FOREIGN KEY (character_id, schedule_id) REFERENCES public.simulation_schedules(character_id, id) ON DELETE RESTRICT;


--
-- Name: simulated_drafts simulated_drafts_character_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulated_drafts
    ADD CONSTRAINT simulated_drafts_character_id_run_id_fkey FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs(character_id, id) ON DELETE RESTRICT;


--
-- Name: simulation_attempts simulation_attempts_character_id_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_attempts
    ADD CONSTRAINT simulation_attempts_character_id_action_id_fkey FOREIGN KEY (character_id, action_id) REFERENCES public.action_proposals(character_id, id) ON DELETE RESTRICT;


--
-- Name: simulation_commitments simulation_commitments_character_id_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_commitments
    ADD CONSTRAINT simulation_commitments_character_id_action_id_fkey FOREIGN KEY (character_id, action_id) REFERENCES public.simulation_receipts(character_id, action_id) ON DELETE RESTRICT;


--
-- Name: simulation_commitments simulation_commitments_character_id_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_commitments
    ADD CONSTRAINT simulation_commitments_character_id_schedule_id_fkey FOREIGN KEY (character_id, schedule_id) REFERENCES public.simulation_schedules(character_id, id) ON DELETE RESTRICT;


--
-- Name: simulation_receipts simulation_receipts_character_id_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_receipts
    ADD CONSTRAINT simulation_receipts_character_id_action_id_fkey FOREIGN KEY (character_id, action_id) REFERENCES public.simulation_attempts(character_id, action_id) ON DELETE RESTRICT;


--
-- Name: simulation_schedules simulation_schedules_contact_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_schedules
    ADD CONSTRAINT simulation_schedules_contact_fkey FOREIGN KEY (character_id, identity_id, account_id, contact_id) REFERENCES public.contacts(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: simulation_schedules simulation_schedules_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_schedules
    ADD CONSTRAINT simulation_schedules_conversation_fkey FOREIGN KEY (character_id, identity_id, account_id, conversation_id) REFERENCES public.conversations(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: sources_registry sources_registry_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources_registry
    ADD CONSTRAINT sources_registry_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE RESTRICT;


--
-- Name: sources_registry sources_registry_character_id_identity_id_account_id_conve_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources_registry
    ADD CONSTRAINT sources_registry_character_id_identity_id_account_id_conve_fkey FOREIGN KEY (character_id, identity_id, account_id, conversation_id) REFERENCES public.conversations(character_id, identity_id, account_id, id) ON DELETE RESTRICT;


--
-- Name: sources_registry sources_registry_character_id_identity_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources_registry
    ADD CONSTRAINT sources_registry_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;


--
-- Name: sources_registry sources_registry_character_id_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources_registry
    ADD CONSTRAINT sources_registry_character_id_identity_id_fkey FOREIGN KEY (character_id, identity_id) REFERENCES public.identities(character_id, id) ON DELETE RESTRICT;


--
-- Name: context_snapshot_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.context_snapshot_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: context_snapshot_evidence context_snapshot_evidence_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY context_snapshot_evidence_owner ON public.context_snapshot_evidence TO postgres USING (true) WITH CHECK (true);


--
-- Name: context_snapshot_evidence context_snapshot_evidence_runtime; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY context_snapshot_evidence_runtime ON public.context_snapshot_evidence TO rica_runtime USING ((EXISTS ( SELECT 1
   FROM public.context_snapshots s
  WHERE ((s.character_id = context_snapshot_evidence.character_id) AND (s.id = context_snapshot_evidence.snapshot_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.context_snapshots s
  WHERE ((s.character_id = context_snapshot_evidence.character_id) AND (s.id = context_snapshot_evidence.snapshot_id)))));


--
-- Name: context_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.context_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: context_snapshots context_snapshots_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY context_snapshots_owner ON public.context_snapshots TO postgres USING (true) WITH CHECK (true);


--
-- Name: context_snapshots context_snapshots_runtime; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY context_snapshots_runtime ON public.context_snapshots TO rica_runtime USING ((run_id = ( SELECT (NULLIF(current_setting('rica.snapshot_run'::text, true), ''::text))::uuid AS "nullif"))) WITH CHECK ((run_id = ( SELECT (NULLIF(current_setting('rica.snapshot_run'::text, true), ''::text))::uuid AS "nullif")));


--
-- Name: daily_energy_projections daily_energy_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY daily_energy_owner ON public.daily_energy_projections TO postgres USING (true) WITH CHECK (true);


--
-- Name: daily_energy_projections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_energy_projections ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_state_revisions identity_state_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY identity_state_owner ON public.identity_state_revisions TO postgres USING (true) WITH CHECK (true);


--
-- Name: identity_state_revisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.identity_state_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

--
-- Name: memories memories_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memories_admin ON public.memories TO postgres, rica_memory_admin USING (true) WITH CHECK (true);


--
-- Name: memories memories_management_metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memories_management_metadata ON public.memories FOR SELECT TO rica_admin_api USING (true);


--
-- Name: memories memories_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memories_reader ON public.memories FOR SELECT TO rica_memory_reader USING (((character_id = ( SELECT rica_memory_scope.character_id
   FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))) AND ((scope = 'CORE'::public."MemoryScope") OR (identity_id = ( SELECT rica_memory_scope.identity_id
   FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))) OR (id IN ( SELECT g.memory_id
   FROM public.memory_grants g
  WHERE (g.character_id = ( SELECT rica_memory_scope.character_id
           FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience)))))) AND
CASE
    WHEN ((( SELECT ((NULLIF(current_setting('rica.memory_scope'::text, true), ''::text))::jsonb -> 'keyword_patterns'::text)) IS NULL) OR ( SELECT (getdatabaseencoding() <> 'UTF8'::name)) OR (octet_length(content) <> length(content)) OR (lower((content COLLATE "C")) ~~ ANY (ARRAY( SELECT jsonb_array_elements_text(((NULLIF(current_setting('rica.memory_scope'::text, true), ''::text))::jsonb -> 'keyword_patterns'::text)) AS jsonb_array_elements_text))) OR (conversation_id = ( SELECT rica_memory_scope.conversation_id
       FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))) OR (id IN ( SELECT ms.memory_id
       FROM (public.memory_sources ms
         JOIN public.sources_registry source ON (((source.character_id = ms.character_id) AND (source.id = ms.source_id))))
      WHERE ((source.character_id = ( SELECT rica_memory_scope.character_id
               FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))) AND (source.conversation_id = ( SELECT rica_memory_scope.conversation_id
               FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))))))) THEN public.rica_memory_allowed(memories.*)
    ELSE false
END));


--
-- Name: memory_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_grants memory_grants_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memory_grants_admin ON public.memory_grants TO postgres, rica_memory_admin USING (true) WITH CHECK (true);


--
-- Name: memory_grants memory_grants_management; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memory_grants_management ON public.memory_grants TO rica_admin_api USING (true) WITH CHECK (true);


--
-- Name: memory_grants memory_grants_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memory_grants_reader ON public.memory_grants FOR SELECT TO rica_memory_reader USING ((EXISTS ( SELECT 1
   FROM public.rica_memory_scope() s(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience)
  WHERE ((memory_grants.character_id = s.character_id) AND (memory_grants.recipient_identity_id = s.identity_id) AND ((memory_grants.recipient_account_id IS NULL) OR (memory_grants.recipient_account_id = s.account_id))))));


--
-- Name: memory_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_sources memory_sources_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memory_sources_admin ON public.memory_sources TO postgres, rica_memory_admin USING (true) WITH CHECK (true);


--
-- Name: memory_sources memory_sources_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memory_sources_reader ON public.memory_sources FOR SELECT TO rica_memory_reader USING ((character_id = ( SELECT rica_memory_scope.character_id
   FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))));


--
-- Name: simulated_drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.simulated_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: simulated_drafts simulated_drafts_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY simulated_drafts_owner ON public.simulated_drafts TO postgres USING (true) WITH CHECK (true);


--
-- Name: simulated_drafts simulated_drafts_runtime; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY simulated_drafts_runtime ON public.simulated_drafts FOR INSERT TO rica_runtime WITH CHECK (((content IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.agent_runs r
     JOIN public.characters c ON (((c.id = r.character_id) AND (c.auth_epoch = r.auth_epoch))))
  WHERE (((r.character_id = simulated_drafts.character_id) AND (r.id = simulated_drafts.run_id)) AND (r.state = 'CONTEXT_READY'::public."RunState") AND (r.mode = 'SIMULATION'::public."RunMode"))))));


--
-- Name: sources_registry; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sources_registry ENABLE ROW LEVEL SECURITY;

--
-- Name: sources_registry sources_registry_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sources_registry_admin ON public.sources_registry TO postgres, rica_memory_admin USING (true) WITH CHECK (true);


--
-- Name: sources_registry sources_registry_reader; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sources_registry_reader ON public.sources_registry FOR SELECT TO rica_memory_reader USING ((character_id = ( SELECT rica_memory_scope.character_id
   FROM public.rica_memory_scope() rica_memory_scope(character_id, identity_id, account_id, conversation_id, contact_id, channel, purpose, audience))));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO rica_runtime;
GRANT USAGE ON SCHEMA public TO rica_memory_reader;
GRANT USAGE ON SCHEMA public TO rica_memory_admin;
GRANT USAGE ON SCHEMA public TO rica_admin_api;
GRANT USAGE ON SCHEMA public TO rica_simulation_executor;
GRANT USAGE ON SCHEMA public TO rica_newbi_executor;
GRANT USAGE ON SCHEMA public TO rica_newbi_poller;


--
-- Name: FUNCTION rica_approve_daily_energy(target_character uuid, target_day date, target_energy text, operator text, rationale text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_approve_daily_energy(target_character uuid, target_day date, target_energy text, operator text, rationale text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_approve_daily_energy(target_character uuid, target_day date, target_energy text, operator text, rationale text) TO rica_admin_api;


--
-- Name: FUNCTION rica_audit_schedule_occurrence(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_audit_schedule_occurrence() FROM PUBLIC;


--
-- Name: FUNCTION rica_begin_outbox_attempt(target_event uuid, event_type text, expected_generation integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_begin_outbox_attempt(target_event uuid, event_type text, expected_generation integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_begin_outbox_attempt(target_event uuid, event_type text, expected_generation integer) TO rica_runtime;


--
-- Name: FUNCTION rica_belief_evidence_valid(v public.belief_versions); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_belief_evidence_valid(v public.belief_versions) FROM PUBLIC;


--
-- Name: FUNCTION rica_belief_refs_valid(target_character uuid, target_identity uuid, refs jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_belief_refs_valid(target_character uuid, target_identity uuid, refs jsonb) FROM PUBLIC;


--
-- Name: FUNCTION rica_belief_source(target_character uuid, target_identity uuid, target_memory uuid, expected integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_belief_source(target_character uuid, target_identity uuid, target_memory uuid, expected integer) FROM PUBLIC;


--
-- Name: FUNCTION rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean) FROM PUBLIC;


--
-- Name: FUNCTION rica_cancel_out_of_policy_goals(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_cancel_out_of_policy_goals() FROM PUBLIC;


--
-- Name: FUNCTION rica_cancel_previous_schedule_runs(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_cancel_previous_schedule_runs() FROM PUBLIC;


--
-- Name: FUNCTION rica_capture_contact_opt_out(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_capture_contact_opt_out() FROM PUBLIC;


--
-- Name: FUNCTION rica_change_contact_boundary(target_character uuid, target_contact uuid, expected integer, blocked boolean, rationale text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_change_contact_boundary(target_character uuid, target_contact uuid, expected integer, blocked boolean, rationale text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_change_contact_boundary(target_character uuid, target_contact uuid, expected integer, blocked boolean, rationale text) TO rica_admin_api;


--
-- Name: FUNCTION rica_claim_newbi_event_page(account uuid, endpoint text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_claim_newbi_event_page(account uuid, endpoint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_claim_newbi_event_page(account uuid, endpoint text) TO rica_newbi_poller;


--
-- Name: FUNCTION rica_claim_newbi_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_claim_newbi_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_claim_newbi_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text) TO rica_newbi_executor;


--
-- Name: FUNCTION rica_clear_stale_draft_content(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_clear_stale_draft_content() FROM PUBLIC;


--
-- Name: FUNCTION rica_close_newbi_reply(reply uuid, owner_character uuid, reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_close_newbi_reply(reply uuid, owner_character uuid, reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_close_newbi_reply(reply uuid, owner_character uuid, reason text) TO rica_admin_api;


--
-- Name: FUNCTION rica_confirmed_commitment_scope(target_character uuid, target_action uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_confirmed_commitment_scope(target_character uuid, target_action uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_confirmed_commitment_scope(target_character uuid, target_action uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_correct_memory(target_character uuid, target_memory uuid, expected integer, replacement text, operator text, rationale text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_correct_memory(target_character uuid, target_memory uuid, expected integer, replacement text, operator text, rationale text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_correct_memory(target_character uuid, target_memory uuid, expected integer, replacement text, operator text, rationale text) TO rica_admin_api;


--
-- Name: FUNCTION rica_cross_platform_duplicate(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_cross_platform_duplicate(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_cross_platform_duplicate(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_daily_schedule_slot(zone_name text, wall_time time without time zone, reference_at timestamp with time zone, backwards boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_daily_schedule_slot(zone_name text, wall_time time without time zone, reference_at timestamp with time zone, backwards boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_daily_schedule_slot(zone_name text, wall_time time without time zone, reference_at timestamp with time zone, backwards boolean) TO rica_runtime;
GRANT ALL ON FUNCTION public.rica_daily_schedule_slot(zone_name text, wall_time time without time zone, reference_at timestamp with time zone, backwards boolean) TO rica_admin_api;


--
-- Name: FUNCTION rica_due_reflections(after_identity uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_due_reflections(after_identity uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_due_reflections(after_identity uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_fail_outbox_attempt(target_event uuid, expected_generation integer, ticket integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_fail_outbox_attempt(target_event uuid, expected_generation integer, ticket integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_fail_outbox_attempt(target_event uuid, expected_generation integer, ticket integer) TO rica_runtime;


--
-- Name: FUNCTION rica_finish_action_review(target_character uuid, target_run uuid, expected_version integer, next_state public."RunState"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_finish_action_review(target_character uuid, target_run uuid, expected_version integer, next_state public."RunState") FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_finish_action_review(target_character uuid, target_run uuid, expected_version integer, next_state public."RunState") TO rica_admin_api;


--
-- Name: FUNCTION rica_finish_newbi_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_finish_newbi_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_finish_newbi_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer) TO rica_newbi_poller;


--
-- Name: FUNCTION rica_finish_newbi_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_finish_newbi_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_finish_newbi_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean) TO rica_newbi_executor;


--
-- Name: FUNCTION rica_fold_identity_state(previous double precision[], seconds double precision, kind public."InboundKind", configuration jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_fold_identity_state(previous double precision[], seconds double precision, kind public."InboundKind", configuration jsonb) FROM PUBLIC;


--
-- Name: FUNCTION rica_formal_beliefs(target_character uuid, target_identity uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_formal_beliefs(target_character uuid, target_identity uuid) FROM PUBLIC;


--
-- Name: FUNCTION rica_goal_json(g public.goal_versions); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_goal_json(g public.goal_versions) FROM PUBLIC;


--
-- Name: FUNCTION rica_guard_newbi_reply_executor(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_guard_newbi_reply_executor() FROM PUBLIC;


--
-- Name: FUNCTION rica_guard_simulation_permit_binding(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_guard_simulation_permit_binding() FROM PUBLIC;


--
-- Name: FUNCTION rica_identity_state_v1(previous double precision[], seconds double precision, kind public."InboundKind"); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_identity_state_v1(previous double precision[], seconds double precision, kind public."InboundKind") FROM PUBLIC;


--
-- Name: FUNCTION rica_invalidate_action_reviews(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_invalidate_action_reviews() FROM PUBLIC;


--
-- Name: FUNCTION rica_lock_conversation(target_character uuid, target_identity uuid, target_account uuid, target_conversation uuid, target_contact uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_lock_conversation(target_character uuid, target_identity uuid, target_account uuid, target_conversation uuid, target_contact uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_lock_conversation(target_character uuid, target_identity uuid, target_account uuid, target_conversation uuid, target_contact uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_lock_simulated_binding(target_account uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_lock_simulated_binding(target_account uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_lock_simulated_binding(target_account uuid) TO rica_runtime;


--
-- Name: TABLE memories; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.memories TO rica_memory_admin;
GRANT SELECT ON TABLE public.memories TO rica_memory_reader;


--
-- Name: COLUMN memories.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.identity_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(identity_id) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_id) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.scope; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(scope) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.visibility; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(visibility) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.expires_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(expires_at) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.memories TO rica_admin_api;


--
-- Name: COLUMN memories.conversation_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(conversation_id) ON TABLE public.memories TO rica_admin_api;


--
-- Name: FUNCTION rica_memory_allowed_at(m public.memories, checked_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_memory_allowed_at(m public.memories, checked_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_memory_allowed_at(m public.memories, checked_at timestamp with time zone) TO rica_memory_reader;


--
-- Name: FUNCTION rica_memory_allowed(m public.memories); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_memory_allowed(m public.memories) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_memory_allowed(m public.memories) TO rica_memory_reader;


--
-- Name: FUNCTION rica_memory_provenance(target_character uuid, target_memory uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_memory_provenance(target_character uuid, target_memory uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_memory_provenance(target_character uuid, target_memory uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_memory_scope(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_memory_scope() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_memory_scope() TO rica_memory_reader;


--
-- Name: FUNCTION rica_newbi_execution_target(reply uuid, executor text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_newbi_execution_target(reply uuid, executor text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_newbi_execution_target(reply uuid, executor text) TO rica_newbi_executor;


--
-- Name: TABLE newbi_replies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.newbi_replies TO rica_admin_api;


--
-- Name: COLUMN newbi_replies.reviewer_id; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(reviewer_id) ON TABLE public.newbi_replies TO rica_admin_api;


--
-- Name: COLUMN newbi_replies.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.newbi_replies TO rica_admin_api;


--
-- Name: COLUMN newbi_replies.approved_executor_key; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(approved_executor_key) ON TABLE public.newbi_replies TO rica_admin_api;


--
-- Name: FUNCTION rica_newbi_reply_matches_executor(r public.newbi_replies, executor text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_newbi_reply_matches_executor(r public.newbi_replies, executor text) FROM PUBLIC;


--
-- Name: FUNCTION rica_newbi_reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_newbi_reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_newbi_reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean) TO rica_newbi_executor;


--
-- Name: FUNCTION rica_pin_run_contact_boundary(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_pin_run_contact_boundary() FROM PUBLIC;


--
-- Name: FUNCTION rica_pin_run_timezone(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_pin_run_timezone() FROM PUBLIC;


--
-- Name: FUNCTION rica_plan_reflection_goal(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_plan_reflection_goal() FROM PUBLIC;


--
-- Name: FUNCTION rica_quarantined_outbox(target_character uuid, after_event uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_quarantined_outbox(target_character uuid, after_event uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_quarantined_outbox(target_character uuid, after_event uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_read_belief(target_character uuid, target_identity uuid, target_belief uuid, requested_version integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_read_belief(target_character uuid, target_identity uuid, target_belief uuid, requested_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_read_belief(target_character uuid, target_identity uuid, target_belief uuid, requested_version integer) TO rica_admin_api;


--
-- Name: FUNCTION rica_read_contact_boundary(target_character uuid, target_contact uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_read_contact_boundary(target_character uuid, target_contact uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_read_contact_boundary(target_character uuid, target_contact uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_read_daily_energy(target_character uuid, target_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_read_daily_energy(target_character uuid, target_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_read_daily_energy(target_character uuid, target_day date) TO rica_admin_api;


--
-- Name: FUNCTION rica_read_identity_reflection(target_character uuid, target_identity uuid, day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_read_identity_reflection(target_character uuid, target_identity uuid, day date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_read_identity_reflection(target_character uuid, target_identity uuid, day date) TO rica_admin_api;


--
-- Name: FUNCTION rica_read_manual_goals(target_character uuid, target_identity uuid, target_goal uuid, requested_version integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_read_manual_goals(target_character uuid, target_identity uuid, target_goal uuid, requested_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_read_manual_goals(target_character uuid, target_identity uuid, target_goal uuid, requested_version integer) TO rica_admin_api;


--
-- Name: FUNCTION rica_record_identity_state(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_record_identity_state() FROM PUBLIC;


--
-- Name: FUNCTION rica_record_simulation_receipt(target_action uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_record_simulation_receipt(target_action uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_record_simulation_receipt(target_action uuid) TO rica_simulation_executor;


--
-- Name: FUNCTION rica_reflect_identity(target_character uuid, target_identity uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_reflect_identity(target_character uuid, target_identity uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_reflect_identity(target_character uuid, target_identity uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_remaining_belief_evidence(v public.belief_versions); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_remaining_belief_evidence(v public.belief_versions) FROM PUBLIC;


--
-- Name: FUNCTION rica_replay_run_with_time(target_character uuid, target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_replay_run_with_time(target_character uuid, target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_replay_run_with_time(target_character uuid, target_run uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_replay_simulation_run(target_character uuid, target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_replay_simulation_run(target_character uuid, target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_replay_simulation_run(target_character uuid, target_run uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_reserve_model_budget(target_run uuid, units integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_reserve_model_budget(target_run uuid, units integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_reserve_model_budget(target_run uuid, units integer) TO rica_runtime;


--
-- Name: FUNCTION rica_resolve_simulated_event_scope(target_account uuid, target_platform text, target_instance text, target_remote_account text, target_thread text, target_contact text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_resolve_simulated_event_scope(target_account uuid, target_platform text, target_instance text, target_remote_account text, target_thread text, target_contact text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_resolve_simulated_event_scope(target_account uuid, target_platform text, target_instance text, target_remote_account text, target_thread text, target_contact text) TO rica_runtime;


--
-- Name: FUNCTION rica_resolve_simulation(target_character uuid, target_action uuid, expected_version integer, expected_outcome text, evidence_ref text, actor text, rationale text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_resolve_simulation(target_character uuid, target_action uuid, expected_version integer, expected_outcome text, evidence_ref text, actor text, rationale text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_resolve_simulation(target_character uuid, target_action uuid, expected_version integer, expected_outcome text, evidence_ref text, actor text, rationale text) TO rica_admin_api;


--
-- Name: FUNCTION rica_retry_outbox(target_character uuid, target_event uuid, expected_generation integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_retry_outbox(target_character uuid, target_event uuid, expected_generation integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_retry_outbox(target_character uuid, target_event uuid, expected_generation integer) TO rica_admin_api;


--
-- Name: FUNCTION rica_review_payload(target_character uuid, target_action uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_run_beliefs(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_run_beliefs(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_run_beliefs(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_run_continuity(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_run_continuity(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_run_continuity(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_run_goals(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_run_goals(target_run uuid) FROM PUBLIC;


--
-- Name: FUNCTION rica_run_identity_state(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_run_identity_state(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_run_identity_state(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_simulated_review_target(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulated_review_target(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulated_review_target(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_simulated_writing_style(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulated_writing_style(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulated_writing_style(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_simulation_backlog(target_character uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulation_backlog(target_character uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulation_backlog(target_character uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_simulation_budget_clock(target_character uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulation_budget_clock(target_character uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulation_budget_clock(target_character uuid) TO rica_simulation_executor;


--
-- Name: FUNCTION rica_simulation_daily_metrics(target_character uuid, first_day date, last_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulation_daily_metrics(target_character uuid, first_day date, last_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulation_daily_metrics(target_character uuid, first_day date, last_day date) TO rica_admin_api;


--
-- Name: FUNCTION rica_simulation_disclosure(target_run uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulation_disclosure(target_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulation_disclosure(target_run uuid) TO rica_runtime;


--
-- Name: FUNCTION rica_simulation_payload_allowed(target_character uuid, target_action uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulation_payload_allowed(target_character uuid, target_action uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulation_payload_allowed(target_character uuid, target_action uuid) TO rica_simulation_executor;


--
-- Name: FUNCTION rica_simulation_reconciliation(target_character uuid, target_action uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_simulation_reconciliation(target_character uuid, target_action uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_simulation_reconciliation(target_character uuid, target_action uuid) TO rica_admin_api;


--
-- Name: FUNCTION rica_sweep_newbi_events(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_sweep_newbi_events() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_sweep_newbi_events() TO rica_runtime;


--
-- Name: FUNCTION rica_sweep_newbi_retention(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_sweep_newbi_retention() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_sweep_newbi_retention() TO rica_runtime;


--
-- Name: FUNCTION rica_sweep_simulation_retention(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_sweep_simulation_retention() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_sweep_simulation_retention() TO rica_runtime;


--
-- Name: FUNCTION rica_topic_grams(message text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_topic_grams(message text) FROM PUBLIC;


--
-- Name: FUNCTION rica_write_belief(target_character uuid, target_identity uuid, target_belief uuid, expected integer, configuration jsonb, operator text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_write_belief(target_character uuid, target_identity uuid, target_belief uuid, expected integer, configuration jsonb, operator text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_write_belief(target_character uuid, target_identity uuid, target_belief uuid, expected integer, configuration jsonb, operator text) TO rica_admin_api;


--
-- Name: FUNCTION rica_write_manual_goal(target_character uuid, target_identity uuid, target_goal uuid, expected integer, configuration jsonb, operator text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rica_write_manual_goal(target_character uuid, target_identity uuid, target_goal uuid, expected integer, configuration jsonb, operator text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rica_write_manual_goal(target_character uuid, target_identity uuid, target_goal uuid, expected integer, configuration jsonb, operator text) TO rica_admin_api;


--
-- Name: TABLE action_approvals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.action_approvals TO rica_admin_api;
GRANT SELECT ON TABLE public.action_approvals TO rica_simulation_executor;


--
-- Name: TABLE action_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.action_proposals TO rica_runtime;
GRANT SELECT ON TABLE public.action_proposals TO rica_admin_api;
GRANT SELECT ON TABLE public.action_proposals TO rica_simulation_executor;


--
-- Name: TABLE admin_passkeys; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.admin_passkeys TO rica_admin_api;


--
-- Name: COLUMN admin_passkeys.counter; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(counter) ON TABLE public.admin_passkeys TO rica_admin_api;


--
-- Name: TABLE admin_users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.admin_users TO rica_admin_api;


--
-- Name: TABLE agent_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.agent_runs TO rica_runtime;


--
-- Name: COLUMN agent_runs.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.agent_runs TO rica_admin_api;
GRANT SELECT(id) ON TABLE public.agent_runs TO rica_simulation_executor;


--
-- Name: COLUMN agent_runs.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.agent_runs TO rica_admin_api;
GRANT SELECT(character_id) ON TABLE public.agent_runs TO rica_simulation_executor;


--
-- Name: COLUMN agent_runs.account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_id) ON TABLE public.agent_runs TO rica_simulation_executor;


--
-- Name: COLUMN agent_runs.mode; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(mode) ON TABLE public.agent_runs TO rica_simulation_executor;


--
-- Name: COLUMN agent_runs.state; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(state) ON TABLE public.agent_runs TO rica_runtime;
GRANT SELECT(state) ON TABLE public.agent_runs TO rica_admin_api;
GRANT SELECT(state),UPDATE(state) ON TABLE public.agent_runs TO rica_simulation_executor;


--
-- Name: COLUMN agent_runs.state_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(state_reason) ON TABLE public.agent_runs TO rica_runtime;


--
-- Name: COLUMN agent_runs.state_version; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(state_version) ON TABLE public.agent_runs TO rica_runtime;
GRANT SELECT(state_version) ON TABLE public.agent_runs TO rica_admin_api;
GRANT SELECT(state_version),UPDATE(state_version) ON TABLE public.agent_runs TO rica_simulation_executor;


--
-- Name: TABLE api_idempotency; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.api_idempotency TO rica_admin_api;


--
-- Name: TABLE audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_log TO rica_admin_api;
GRANT INSERT ON TABLE public.audit_log TO rica_simulation_executor;


--
-- Name: COLUMN audit_log.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.audit_log TO rica_simulation_executor;


--
-- Name: TABLE characters; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.characters TO rica_runtime;
GRANT SELECT ON TABLE public.characters TO rica_memory_admin;
GRANT SELECT,INSERT ON TABLE public.characters TO rica_admin_api;


--
-- Name: COLUMN characters.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.characters TO rica_admin_api;


--
-- Name: COLUMN characters.active_core_version; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(active_core_version) ON TABLE public.characters TO rica_admin_api;


--
-- Name: COLUMN characters.auth_epoch; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(auth_epoch) ON TABLE public.characters TO rica_memory_admin;
GRANT UPDATE(auth_epoch) ON TABLE public.characters TO rica_admin_api;


--
-- Name: TABLE commitment_revisions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.commitment_revisions TO rica_admin_api;


--
-- Name: TABLE contacts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.contacts TO rica_runtime;


--
-- Name: TABLE context_snapshot_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.context_snapshot_evidence TO rica_runtime;


--
-- Name: TABLE context_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.context_snapshots TO rica_runtime;


--
-- Name: COLUMN conversations.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.conversations TO rica_admin_api;


--
-- Name: COLUMN conversations.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.conversations TO rica_admin_api;


--
-- Name: COLUMN conversations.identity_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(identity_id) ON TABLE public.conversations TO rica_admin_api;


--
-- Name: COLUMN conversations.account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_id) ON TABLE public.conversations TO rica_admin_api;


--
-- Name: COLUMN conversations.channel; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(channel) ON TABLE public.conversations TO rica_admin_api;


--
-- Name: COLUMN conversations.private_contact_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(private_contact_id) ON TABLE public.conversations TO rica_admin_api;


--
-- Name: TABLE core_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.core_versions TO rica_admin_api;


--
-- Name: TABLE identities; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.identities TO rica_admin_api;


--
-- Name: COLUMN identities.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.identities TO rica_admin_api;


--
-- Name: COLUMN identities.active_version; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(active_version) ON TABLE public.identities TO rica_admin_api;


--
-- Name: TABLE identity_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.identity_versions TO rica_admin_api;


--
-- Name: TABLE inbound_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.inbound_events TO rica_runtime;


--
-- Name: TABLE management_memberships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.management_memberships TO rica_admin_api;


--
-- Name: TABLE memory_grants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.memory_grants TO rica_memory_admin;
GRANT SELECT,INSERT ON TABLE public.memory_grants TO rica_admin_api;


--
-- Name: COLUMN memory_grants.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.memory_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(memory_id) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.recipient_identity_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(recipient_identity_id) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.recipient_account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(recipient_account_id) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.purpose; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(purpose) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.audience; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(audience) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.valid_from; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(valid_from) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.valid_until; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(valid_until) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.revoked_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(revoked_at) ON TABLE public.memory_grants TO rica_memory_reader;
GRANT UPDATE(revoked_at) ON TABLE public.memory_grants TO rica_admin_api;


--
-- Name: COLUMN memory_grants.recipient_contact_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(recipient_contact_id) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: COLUMN memory_grants.recipient_conversation_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(recipient_conversation_id) ON TABLE public.memory_grants TO rica_memory_reader;


--
-- Name: TABLE memory_sources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.memory_sources TO rica_memory_admin;


--
-- Name: COLUMN memory_sources.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.memory_sources TO rica_memory_reader;


--
-- Name: COLUMN memory_sources.memory_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(memory_id) ON TABLE public.memory_sources TO rica_memory_reader;


--
-- Name: COLUMN memory_sources.source_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(source_id) ON TABLE public.memory_sources TO rica_memory_reader;


--
-- Name: COLUMN newbi_event_checkpoints.account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_id) ON TABLE public.newbi_event_checkpoints TO rica_admin_api;


--
-- Name: COLUMN newbi_event_checkpoints.next_poll_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(next_poll_at) ON TABLE public.newbi_event_checkpoints TO rica_admin_api;


--
-- Name: COLUMN newbi_event_checkpoints.history_lost_count; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(history_lost_count) ON TABLE public.newbi_event_checkpoints TO rica_admin_api;


--
-- Name: COLUMN newbi_event_checkpoints.last_history_lost_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_history_lost_at) ON TABLE public.newbi_event_checkpoints TO rica_admin_api;


--
-- Name: TABLE newbi_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.newbi_events TO rica_admin_api;


--
-- Name: TABLE outbox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.outbox TO rica_runtime;


--
-- Name: COLUMN outbox.enqueued_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(enqueued_at) ON TABLE public.outbox TO rica_runtime;


--
-- Name: COLUMN outbox.processed_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(processed_at) ON TABLE public.outbox TO rica_runtime;


--
-- Name: TABLE platform_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.platform_accounts TO rica_admin_api;


--
-- Name: COLUMN platform_accounts.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.platform_accounts TO rica_admin_api;


--
-- Name: COLUMN platform_accounts.binding_version; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(binding_version) ON TABLE public.platform_accounts TO rica_admin_api;


--
-- Name: TABLE schedule_occurrences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.schedule_occurrences TO rica_runtime;


--
-- Name: TABLE simulated_drafts; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT ON TABLE public.simulated_drafts TO rica_runtime;


--
-- Name: TABLE simulation_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.action_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(action_id) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_id) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status),UPDATE(status) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.window_start; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(window_start) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.permit_until; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(permit_until) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: COLUMN simulation_attempts.contact_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(contact_id) ON TABLE public.simulation_attempts TO rica_simulation_executor;


--
-- Name: TABLE simulation_commitments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.simulation_commitments TO rica_admin_api;


--
-- Name: COLUMN simulation_commitments.state; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(state) ON TABLE public.simulation_commitments TO rica_admin_api;


--
-- Name: COLUMN simulation_commitments.due_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(due_at) ON TABLE public.simulation_commitments TO rica_admin_api;


--
-- Name: COLUMN simulation_commitments.version; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(version) ON TABLE public.simulation_commitments TO rica_admin_api;


--
-- Name: TABLE simulation_receipts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.simulation_receipts TO rica_simulation_executor;


--
-- Name: TABLE simulation_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.simulation_schedules TO rica_runtime;
GRANT SELECT,INSERT ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.zone; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(zone) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.kind; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(kind) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.local_time; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(local_time) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.due_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(due_at) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.next_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(next_at) ON TABLE public.simulation_schedules TO rica_runtime;
GRANT UPDATE(next_at) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.enabled; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(enabled) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: COLUMN simulation_schedules.version; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(version) ON TABLE public.simulation_schedules TO rica_admin_api;


--
-- Name: TABLE sources_registry; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.sources_registry TO rica_memory_admin;


--
-- Name: COLUMN sources_registry.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.sources_registry TO rica_memory_reader;


--
-- Name: COLUMN sources_registry.character_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(character_id) ON TABLE public.sources_registry TO rica_memory_reader;


--
-- Name: COLUMN sources_registry.identity_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(identity_id) ON TABLE public.sources_registry TO rica_memory_reader;


--
-- Name: COLUMN sources_registry.account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_id) ON TABLE public.sources_registry TO rica_memory_reader;


--
-- Name: COLUMN sources_registry.classification; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(classification) ON TABLE public.sources_registry TO rica_memory_reader;


--
-- Name: COLUMN sources_registry.revoked_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(revoked_at) ON TABLE public.sources_registry TO rica_memory_reader;


--
-- Name: COLUMN sources_registry.conversation_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(conversation_id) ON TABLE public.sources_registry TO rica_memory_reader;

COMMIT;
