BEGIN;
SET LOCAL check_function_bodies = false;

DO $bootstrap$
DECLARE
  owner_role name;
  relation_name name;
  signature text;
BEGIN
  -- An already initialized deployment keeps its tables, history and grants.
  IF to_regclass('rica_plugin_newbi.credentials') IS NOT NULL THEN
    IF to_regclass('rica_plugin_newbi.section_glossary_samples') IS NULL
      OR to_regprocedure('rica_plugin_newbi.finish_reply(uuid,integer,uuid,integer,boolean)') IS NULL
      OR to_regprocedure('rica_plugin_newbi.send_connection(uuid)') IS NULL THEN
      RAISE EXCEPTION 'Newbi database is incomplete; finish the previous release migration first';
    END IF;
    SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_role
      FROM pg_catalog.pg_class WHERE oid = 'rica_plugin_newbi.replies'::regclass;
    ALTER FUNCTION public.rica_guard_newbi_reply_executor() SET SCHEMA rica_plugin_newbi;
    ALTER FUNCTION rica_plugin_newbi.rica_guard_newbi_reply_executor() RENAME TO guard_reply_executor;
    ALTER FUNCTION public.rica_clear_newbi_review_handoff() SET SCHEMA rica_plugin_newbi;
    ALTER FUNCTION rica_plugin_newbi.rica_clear_newbi_review_handoff() RENAME TO clear_review_handoff;
    EXECUTE format('ALTER FUNCTION rica_plugin_newbi.guard_reply_executor() OWNER TO %I', owner_role);
    EXECUTE format('ALTER FUNCTION rica_plugin_newbi.clear_review_handoff() OWNER TO %I', owner_role);
    RETURN;
  END IF;

  IF to_regclass('public.newbi_replies') IS NOT NULL OR to_regclass('public.newbi_credentials') IS NOT NULL THEN
    RAISE EXCEPTION 'Newbi tables still use the legacy layout; finish the previous release migration first';
  END IF;

CREATE SCHEMA rica_plugin_newbi;

CREATE FUNCTION rica_plugin_newbi.claim_event_page(account uuid, endpoint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  binding record;
  checkpoint rica_plugin_newbi.event_checkpoints%ROWTYPE;
  stamp timestamptz;
BEGIN
  SELECT b.remote_account_id, b.binding_version, b.auth_epoch INTO binding
  FROM public.rica_newbi_lock_poll_binding_v1(account) b
  WHERE b.instance_key = endpoint;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO rica_plugin_newbi.event_checkpoints(account_id) VALUES (account) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT checkpoint FROM rica_plugin_newbi.event_checkpoints WHERE account_id = account FOR UPDATE;
  stamp := clock_timestamp();
  IF greatest(checkpoint.next_poll_at,checkpoint.lease_until) > stamp THEN
    RETURN jsonb_build_object('nextAt',greatest(checkpoint.next_poll_at,checkpoint.lease_until));
  END IF;

  UPDATE rica_plugin_newbi.event_checkpoints SET ticket = gen_random_uuid(),lease_until = stamp+interval '30 seconds'
  WHERE account_id = account RETURNING * INTO checkpoint;
  RETURN jsonb_build_object('ticket',checkpoint.ticket,'cursor',checkpoint.cursor,'agentId',binding.remote_account_id,
    'bindingVersion',binding.binding_version,'authEpoch',binding.auth_epoch);
END
$$;

CREATE FUNCTION rica_plugin_newbi.claim_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  binding record;
  bound_account uuid;
  claimed rica_plugin_newbi.replies%ROWTYPE;
BEGIN
  SELECT account_id INTO bound_account FROM rica_plugin_newbi.replies WHERE id = reply;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT b.binding_version, b.auth_epoch INTO binding
  FROM public.rica_newbi_lock_poll_binding_v1(bound_account) b
  WHERE b.instance_key = endpoint AND b.remote_account_id = agent::text;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE rica_plugin_newbi.replies r SET status = 'IN_FLIGHT',attempts = attempts+1,
    lease_until = least(r.expires_at,clock_timestamp()+interval '30 seconds')
  WHERE r.id = reply AND r.account_id = bound_account AND rica_plugin_newbi.reply_matches_executor(r,executor)
    AND (r.auth_epoch,r.binding_version) = (binding.auth_epoch,binding.binding_version)
    AND NOT EXISTS (
      SELECT 1 FROM rica_plugin_newbi.replies other
      WHERE other.account_id = r.account_id AND other.id <> r.id AND other.status IN ('IN_FLIGHT','UNKNOWN')
    )
    AND NOT EXISTS (
      SELECT 1 FROM rica_plugin_newbi.replies other
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

CREATE FUNCTION rica_plugin_newbi.close_reply(reply uuid, owner_character uuid, reason text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  UPDATE rica_plugin_newbi.replies SET status = 'CLOSED',closure_reason = reason,lease_until = NULL
  WHERE id = reply AND character_id = owner_character AND (
    status = 'UNKNOWN' OR (status = 'IN_FLIGHT' AND lease_until <= clock_timestamp()
      AND (attempts >= 3 OR expires_at <= clock_timestamp()))
  );
  RETURN FOUND;
END
$$;

CREATE FUNCTION rica_plugin_newbi.execution_target(reply uuid, executor text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT jsonb_build_object('agentId',a.remote_account_id,'endpoint',a.instance_key,'postId',r.post_id,
    'status',r.status,'attempts',r.attempts,'leaseUntil',r.lease_until,'retryNotBefore',(
      SELECT max(other.retry_not_before) FROM rica_plugin_newbi.replies other WHERE other.account_id = r.account_id
    ))
  FROM rica_plugin_newbi.replies r
  CROSS JOIN LATERAL public.rica_newbi_read_active_binding_v1(r.account_id) a
  WHERE r.id = reply AND rica_plugin_newbi.reply_matches_executor(r,executor)
    AND r.status IN ('READY','IN_FLIGHT','UNKNOWN') AND r.expires_at > statement_timestamp()
    AND (r.auth_epoch,r.binding_version) = (a.auth_epoch,a.binding_version)
$$;

CREATE FUNCTION rica_plugin_newbi.finish_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer, failure text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  saved int := 0;
  lost boolean := coalesce((page->>'historyLost')::boolean,false);
  stamp timestamptz;
  due timestamptz;
BEGIN
  PERFORM 1 FROM public.rica_newbi_lock_poll_binding_v1(account) b
  WHERE b.binding_version = version AND b.auth_epoch = epoch;
  IF NOT FOUND THEN RETURN NULL; END IF;

  stamp := clock_timestamp();
  UPDATE rica_plugin_newbi.event_checkpoints SET
    cursor = coalesce(page->>'nextCursor',cursor),
    history_lost_count = history_lost_count+lost::int,
    last_history_lost_at = CASE WHEN lost THEN stamp ELSE last_history_lost_at END,
    last_succeeded_at = CASE WHEN page IS NOT NULL THEN stamp ELSE last_succeeded_at END,
    read_error = CASE WHEN page IS NOT NULL THEN NULL ELSE coalesce(failure,read_error) END,
    next_poll_at = stamp+make_interval(secs => greatest(delay_seconds,0)),
    ticket = NULL,lease_until = NULL
  WHERE account_id = account AND ticket = claim_ticket AND lease_until > stamp
  RETURNING next_poll_at INTO due;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO rica_plugin_newbi.events(account_id,seq,type,post_id,comment_id,occurred_at)
  SELECT account,item.seq,item.type,item."postId",item."commentId",item."createdAt"
  FROM jsonb_to_recordset(page->'items') AS item(
    seq text,type text,"postId" uuid,"commentId" uuid,"createdAt" timestamptz)
  ON CONFLICT (account_id,seq) DO NOTHING;
  GET DIAGNOSTICS saved = ROW_COUNT;
  RETURN jsonb_build_object('nextAt',due,'saved',saved,'historyLost',lost);
END
$$;

CREATE FUNCTION rica_plugin_newbi.finish_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ticket IS NULL THEN RETURN false; END IF;
  UPDATE rica_plugin_newbi.replies SET status = CASE
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

CREATE FUNCTION rica_plugin_newbi.poll_connection(target_account uuid) RETURNS TABLE(endpoint text, credential text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT c.endpoint, c.credential
  FROM public.rica_newbi_read_active_account_v1(target_account) a
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id;
$$;

CREATE TABLE rica_plugin_newbi.replies (
    id uuid CONSTRAINT newbi_replies_id_not_null NOT NULL,
    character_id uuid CONSTRAINT newbi_replies_character_id_not_null NOT NULL,
    identity_id uuid CONSTRAINT newbi_replies_identity_id_not_null NOT NULL,
    account_id uuid CONSTRAINT newbi_replies_account_id_not_null NOT NULL,
    auth_epoch integer CONSTRAINT newbi_replies_auth_epoch_not_null NOT NULL,
    binding_version integer CONSTRAINT newbi_replies_binding_version_not_null NOT NULL,
    post_id uuid CONSTRAINT newbi_replies_post_id_not_null NOT NULL,
    content text,
    review_digest character varying(64) CONSTRAINT newbi_replies_review_digest_not_null NOT NULL,
    proposer_id text CONSTRAINT newbi_replies_proposer_id_not_null NOT NULL,
    reviewer_id text,
    status text DEFAULT 'WAITING'::text CONSTRAINT newbi_replies_status_not_null NOT NULL,
    attempts integer DEFAULT 0 CONSTRAINT newbi_replies_attempts_not_null NOT NULL,
    lease_until timestamp with time zone,
    remote_comment_id uuid,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT newbi_replies_created_at_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT newbi_replies_expires_at_not_null NOT NULL,
    retry_not_before timestamp with time zone,
    closure_reason character varying(240),
    executor_key text CONSTRAINT newbi_replies_executor_key_not_null NOT NULL,
    approved_executor_key text,
    auto_review_version integer,
    auto_review_handoff jsonb,
    review_record jsonb,
    review_prompt jsonb,
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

CREATE FUNCTION rica_plugin_newbi.reply_matches_executor(r rica_plugin_newbi.replies, executor text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT r.approved_executor_key = executor AND strpos(r.content, E'\n\nAI 披露：') = 0
$$;

CREATE FUNCTION rica_plugin_newbi.reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF post_locked THEN
    UPDATE rica_plugin_newbi.replies r SET status = 'CLOSED'
    WHERE r.id = reply AND r.status = 'READY' AND r.attempts = 0
      AND rica_plugin_newbi.reply_matches_executor(r,executor);
  ELSE
    PERFORM public.rica_newbi_lock_poll_binding_v1(r.account_id)
    FROM rica_plugin_newbi.replies r WHERE r.id = reply;
    UPDATE rica_plugin_newbi.replies r SET retry_not_before = greatest(r.retry_not_before,
      clock_timestamp()+make_interval(secs => retry_seconds))
    WHERE r.id = reply AND retry_seconds > 0 AND r.status IN ('READY','IN_FLIGHT','UNKNOWN')
      AND rica_plugin_newbi.reply_matches_executor(r,executor);
  END IF;
  RETURN FOUND;
END
$$;

CREATE FUNCTION rica_plugin_newbi.send_connection(target_reply uuid) RETURNS TABLE(endpoint text, credential text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT c.endpoint, c.credential
  FROM rica_plugin_newbi.replies r
  JOIN LATERAL public.rica_newbi_read_active_account_v1(r.account_id) a ON a.character_id = r.character_id
  JOIN rica_plugin_newbi.credentials c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
  WHERE r.id = target_reply AND r.status IN ('READY', 'IN_FLIGHT', 'UNKNOWN');
$$;

CREATE TABLE rica_plugin_newbi.credentials (
    endpoint text CONSTRAINT newbi_credentials_endpoint_not_null NOT NULL,
    agent_id uuid CONSTRAINT newbi_credentials_agent_id_not_null NOT NULL,
    credential text CONSTRAINT newbi_credentials_credential_not_null NOT NULL,
    username text,
    avatar_url text
);

CREATE VIEW rica_plugin_newbi.account_profiles AS
 SELECT endpoint,
    agent_id,
    username,
    avatar_url
   FROM rica_plugin_newbi.credentials;

CREATE TABLE rica_plugin_newbi.author_terms (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT newbi_author_terms_id_not_null NOT NULL,
    account_id uuid CONSTRAINT newbi_author_terms_account_id_not_null NOT NULL,
    author_key text CONSTRAINT newbi_author_terms_author_key_not_null NOT NULL,
    term_key text CONSTRAINT newbi_author_terms_term_key_not_null NOT NULL,
    term text CONSTRAINT newbi_author_terms_term_not_null NOT NULL,
    meaning text CONSTRAINT newbi_author_terms_meaning_not_null NOT NULL,
    tone text CONSTRAINT newbi_author_terms_tone_not_null NOT NULL,
    source_assessment_id uuid CONSTRAINT newbi_author_terms_source_assessment_id_not_null NOT NULL,
    source_comments uuid[] CONSTRAINT newbi_author_terms_source_comments_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT newbi_author_terms_created_at_not_null NOT NULL,
    CONSTRAINT newbi_author_terms_source_comments_check CHECK ((cardinality(source_comments) = 3)),
    CONSTRAINT newbi_author_terms_tone_check CHECK ((tone = ANY (ARRAY['neutral'::text, 'playful'::text, 'sarcastic'::text, 'sensitive'::text])))
);

CREATE TABLE rica_plugin_newbi.discussion_assessments (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT newbi_discussion_assessments_id_not_null NOT NULL,
    character_id uuid CONSTRAINT newbi_discussion_assessments_character_id_not_null NOT NULL,
    identity_id uuid CONSTRAINT newbi_discussion_assessments_identity_id_not_null NOT NULL,
    account_id uuid CONSTRAINT newbi_discussion_assessments_account_id_not_null NOT NULL,
    post_id uuid CONSTRAINT newbi_discussion_assessments_post_id_not_null NOT NULL,
    auth_epoch integer CONSTRAINT newbi_discussion_assessments_auth_epoch_not_null NOT NULL,
    binding_version integer CONSTRAINT newbi_discussion_assessments_binding_version_not_null NOT NULL,
    identity text CONSTRAINT newbi_discussion_assessments_identity_not_null NOT NULL,
    participation text CONSTRAINT newbi_discussion_assessments_participation_not_null NOT NULL,
    model text,
    system_prompt text,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT newbi_discussion_assessments_created_at_not_null NOT NULL,
    finished_at timestamp with time zone,
    glossary_used jsonb,
    trigger_seq character varying(40),
    CONSTRAINT newbi_discussion_assessments_check CHECK (((result IS NULL) = (finished_at IS NULL))),
    CONSTRAINT newbi_discussion_assessments_participation_check CHECK ((participation = ANY (ARRAY['talkative'::text, 'balanced'::text, 'reserved'::text])))
);

CREATE TABLE rica_plugin_newbi.event_checkpoints (
    account_id uuid CONSTRAINT newbi_event_checkpoints_account_id_not_null NOT NULL,
    cursor character varying(2048),
    next_poll_at timestamp with time zone DEFAULT now() CONSTRAINT newbi_event_checkpoints_next_poll_at_not_null NOT NULL,
    ticket uuid,
    lease_until timestamp with time zone,
    history_lost_count integer DEFAULT 0 CONSTRAINT newbi_event_checkpoints_history_lost_count_not_null NOT NULL,
    last_history_lost_at timestamp with time zone,
    last_succeeded_at timestamp with time zone,
    read_error text,
    CONSTRAINT newbi_checkpoint_read_error CHECK ((read_error = ANY (ARRAY['AGENT_MISMATCH'::text, 'CREDENTIAL_INVALID'::text, 'ACCESS_DENIED'::text, 'RATE_LIMITED'::text, 'SERVICE_UNAVAILABLE'::text, 'COMMUNITY_CLOSED'::text, 'READ_FAILED'::text]))),
    CONSTRAINT newbi_event_checkpoints_check CHECK (((ticket IS NULL) = (lease_until IS NULL))),
    CONSTRAINT newbi_event_checkpoints_check1 CHECK (((history_lost_count = 0) = (last_history_lost_at IS NULL))),
    CONSTRAINT newbi_event_checkpoints_history_lost_count_check CHECK ((history_lost_count >= 0))
);

CREATE TABLE rica_plugin_newbi.events (
    account_id uuid CONSTRAINT newbi_events_account_id_not_null NOT NULL,
    seq character varying(40) CONSTRAINT newbi_events_seq_not_null NOT NULL,
    type text CONSTRAINT newbi_events_type_not_null NOT NULL,
    post_id uuid CONSTRAINT newbi_events_post_id_not_null NOT NULL,
    comment_id uuid,
    occurred_at timestamp with time zone CONSTRAINT newbi_events_occurred_at_not_null NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT newbi_events_received_at_not_null NOT NULL,
    CONSTRAINT newbi_events_seq_check CHECK (((seq)::text ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT newbi_events_type_check CHECK ((type = ANY (ARRAY['POST_REPLIED'::text, 'COMMENT_REPLIED'::text, 'AGENT_MENTIONED'::text])))
);

CREATE TABLE rica_plugin_newbi.section_glossary_samples (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT newbi_section_glossary_samples_id_not_null NOT NULL,
    account_id uuid CONSTRAINT newbi_section_glossary_samples_account_id_not_null NOT NULL,
    section_id integer CONSTRAINT newbi_section_glossary_samples_section_id_not_null NOT NULL,
    author_key text CONSTRAINT newbi_section_glossary_samples_author_key_not_null NOT NULL,
    term_key text CONSTRAINT newbi_section_glossary_samples_term_key_not_null NOT NULL,
    meaning_key text CONSTRAINT newbi_section_glossary_samples_meaning_key_not_null NOT NULL,
    term text CONSTRAINT newbi_section_glossary_samples_term_not_null NOT NULL,
    meaning text CONSTRAINT newbi_section_glossary_samples_meaning_not_null NOT NULL,
    tone text CONSTRAINT newbi_section_glossary_samples_tone_not_null NOT NULL,
    source_assessment_id uuid CONSTRAINT newbi_section_glossary_samples_source_assessment_id_not_null NOT NULL,
    source_comments uuid[] CONSTRAINT newbi_section_glossary_samples_source_comments_not_null NOT NULL,
    CONSTRAINT newbi_section_glossary_samples_section_id_check CHECK ((section_id > 0)),
    CONSTRAINT newbi_section_glossary_samples_source_comments_check CHECK ((cardinality(source_comments) = 3)),
    CONSTRAINT newbi_section_glossary_samples_tone_check CHECK ((tone = ANY (ARRAY['neutral'::text, 'playful'::text, 'sarcastic'::text, 'sensitive'::text])))
);

ALTER TABLE ONLY rica_plugin_newbi.discussion_assessments
    ADD CONSTRAINT newbi_assessments_account_id_key UNIQUE (account_id, id);

ALTER TABLE ONLY rica_plugin_newbi.discussion_assessments
    ADD CONSTRAINT newbi_assessments_background_trigger_key UNIQUE (account_id, trigger_seq);

ALTER TABLE ONLY rica_plugin_newbi.author_terms
    ADD CONSTRAINT newbi_author_terms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rica_plugin_newbi.author_terms
    ADD CONSTRAINT newbi_author_terms_scope_key UNIQUE (account_id, author_key, term_key);

ALTER TABLE ONLY rica_plugin_newbi.credentials
    ADD CONSTRAINT newbi_credentials_pkey PRIMARY KEY (endpoint, agent_id);

ALTER TABLE ONLY rica_plugin_newbi.discussion_assessments
    ADD CONSTRAINT newbi_discussion_assessments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rica_plugin_newbi.event_checkpoints
    ADD CONSTRAINT newbi_event_checkpoints_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY rica_plugin_newbi.events
    ADD CONSTRAINT newbi_events_pkey PRIMARY KEY (account_id, seq);

ALTER TABLE ONLY rica_plugin_newbi.replies
    ADD CONSTRAINT newbi_replies_account_id_remote_comment_id_key UNIQUE (account_id, remote_comment_id);

ALTER TABLE ONLY rica_plugin_newbi.replies
    ADD CONSTRAINT newbi_replies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rica_plugin_newbi.section_glossary_samples
    ADD CONSTRAINT newbi_section_glossary_sample_scope_key UNIQUE (account_id, section_id, term_key, meaning_key, author_key);

ALTER TABLE ONLY rica_plugin_newbi.section_glossary_samples
    ADD CONSTRAINT newbi_section_glossary_samples_pkey PRIMARY KEY (id);

CREATE INDEX newbi_assessments_account_post_idx ON rica_plugin_newbi.discussion_assessments USING btree (account_id, post_id, created_at, id);

CREATE INDEX newbi_assessments_created_at_idx ON rica_plugin_newbi.discussion_assessments USING btree (created_at);

CREATE INDEX newbi_author_terms_source_idx ON rica_plugin_newbi.author_terms USING btree (account_id, source_assessment_id);

CREATE INDEX newbi_events_account_id_occurred_at_idx ON rica_plugin_newbi.events USING btree (account_id, occurred_at);

CREATE INDEX newbi_events_occurred_at_idx ON rica_plugin_newbi.events USING btree (occurred_at);

CREATE INDEX newbi_events_received_at_idx ON rica_plugin_newbi.events USING btree (received_at);

CREATE INDEX newbi_replies_character_created_idx ON rica_plugin_newbi.replies USING btree (character_id, created_at, id);

CREATE INDEX newbi_replies_character_status_created_idx ON rica_plugin_newbi.replies USING btree (character_id, status, created_at, id);

CREATE INDEX newbi_section_glossary_sample_source_idx ON rica_plugin_newbi.section_glossary_samples USING btree (account_id, source_assessment_id);

CREATE FUNCTION rica_plugin_newbi.guard_reply_executor() RETURNS trigger
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

CREATE FUNCTION rica_plugin_newbi.clear_review_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'pg_temp' AS $$
BEGIN
  NEW.auto_review_handoff := NULL;
  NEW.review_prompt := NULL;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION rica_plugin_newbi.guard_reply_executor(), rica_plugin_newbi.clear_review_handoff() FROM PUBLIC;

CREATE TRIGGER newbi_replies_clear_review_handoff BEFORE UPDATE OF content ON rica_plugin_newbi.replies FOR EACH ROW WHEN ((new.content IS NULL)) EXECUTE FUNCTION rica_plugin_newbi.clear_review_handoff();

CREATE TRIGGER newbi_replies_guard_executor BEFORE INSERT OR UPDATE OF executor_key, approved_executor_key, status ON rica_plugin_newbi.replies FOR EACH ROW EXECUTE FUNCTION rica_plugin_newbi.guard_reply_executor();

ALTER TABLE ONLY rica_plugin_newbi.author_terms
    ADD CONSTRAINT newbi_author_terms_source_fkey FOREIGN KEY (account_id, source_assessment_id) REFERENCES rica_plugin_newbi.discussion_assessments(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY rica_plugin_newbi.discussion_assessments
    ADD CONSTRAINT newbi_discussion_assessments_account_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY rica_plugin_newbi.event_checkpoints
    ADD CONSTRAINT newbi_event_checkpoints_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.platform_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY rica_plugin_newbi.events
    ADD CONSTRAINT newbi_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.platform_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY rica_plugin_newbi.replies
    ADD CONSTRAINT newbi_replies_character_id_identity_id_account_id_fkey FOREIGN KEY (character_id, identity_id, account_id) REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY rica_plugin_newbi.section_glossary_samples
    ADD CONSTRAINT newbi_section_glossary_sample_source_fkey FOREIGN KEY (account_id, source_assessment_id) REFERENCES rica_plugin_newbi.discussion_assessments(account_id, id) ON DELETE CASCADE;

GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_admin_api;
GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_runtime;
GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_newbi_poller;
GRANT USAGE ON SCHEMA rica_plugin_newbi TO rica_newbi_executor;

REVOKE ALL ON FUNCTION rica_plugin_newbi.claim_event_page(account uuid, endpoint text) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.claim_event_page(account uuid, endpoint text) TO rica_newbi_poller;

REVOKE ALL ON FUNCTION rica_plugin_newbi.claim_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.claim_reply(reply uuid, allow_retry boolean, agent uuid, endpoint text, executor text) TO rica_newbi_executor;

REVOKE ALL ON FUNCTION rica_plugin_newbi.close_reply(reply uuid, owner_character uuid, reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.close_reply(reply uuid, owner_character uuid, reason text) TO rica_admin_api;

REVOKE ALL ON FUNCTION rica_plugin_newbi.execution_target(reply uuid, executor text) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.execution_target(reply uuid, executor text) TO rica_newbi_executor;

REVOKE ALL ON FUNCTION rica_plugin_newbi.finish_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer, failure text) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.finish_event_page(account uuid, claim_ticket uuid, version integer, epoch integer, page jsonb, delay_seconds integer, failure text) TO rica_newbi_poller;

REVOKE ALL ON FUNCTION rica_plugin_newbi.finish_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.finish_reply(reply uuid, ticket integer, remote_comment uuid, retry_seconds integer, post_locked boolean) TO rica_newbi_executor;

REVOKE ALL ON FUNCTION rica_plugin_newbi.poll_connection(target_account uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.poll_connection(target_account uuid) TO rica_newbi_poller;

GRANT SELECT,INSERT ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(reviewer_id) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(status) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(approved_executor_key) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(auto_review_version) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(auto_review_handoff) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(review_record) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

GRANT UPDATE(review_prompt) ON TABLE rica_plugin_newbi.replies TO rica_admin_api;

REVOKE ALL ON FUNCTION rica_plugin_newbi.reply_matches_executor(r rica_plugin_newbi.replies, executor text) FROM PUBLIC;

REVOKE ALL ON FUNCTION rica_plugin_newbi.reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.reply_preflight(reply uuid, executor text, retry_seconds integer, post_locked boolean) TO rica_newbi_executor;

REVOKE ALL ON FUNCTION rica_plugin_newbi.send_connection(target_reply uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION rica_plugin_newbi.send_connection(target_reply uuid) TO rica_newbi_executor;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE rica_plugin_newbi.credentials TO rica_admin_api;

GRANT SELECT ON TABLE rica_plugin_newbi.account_profiles TO rica_admin_api;

GRANT SELECT,INSERT ON TABLE rica_plugin_newbi.author_terms TO rica_admin_api;

GRANT SELECT,INSERT ON TABLE rica_plugin_newbi.discussion_assessments TO rica_admin_api;

GRANT UPDATE(model) ON TABLE rica_plugin_newbi.discussion_assessments TO rica_admin_api;

GRANT UPDATE(system_prompt) ON TABLE rica_plugin_newbi.discussion_assessments TO rica_admin_api;

GRANT UPDATE(result) ON TABLE rica_plugin_newbi.discussion_assessments TO rica_admin_api;

GRANT UPDATE(finished_at) ON TABLE rica_plugin_newbi.discussion_assessments TO rica_admin_api;

GRANT UPDATE(glossary_used) ON TABLE rica_plugin_newbi.discussion_assessments TO rica_admin_api;

GRANT SELECT(account_id) ON TABLE rica_plugin_newbi.event_checkpoints TO rica_admin_api;

GRANT SELECT(next_poll_at) ON TABLE rica_plugin_newbi.event_checkpoints TO rica_admin_api;

GRANT SELECT(history_lost_count) ON TABLE rica_plugin_newbi.event_checkpoints TO rica_admin_api;

GRANT SELECT(last_history_lost_at) ON TABLE rica_plugin_newbi.event_checkpoints TO rica_admin_api;

GRANT SELECT(last_succeeded_at) ON TABLE rica_plugin_newbi.event_checkpoints TO rica_admin_api;

GRANT SELECT(read_error) ON TABLE rica_plugin_newbi.event_checkpoints TO rica_admin_api;

GRANT SELECT ON TABLE rica_plugin_newbi.events TO rica_admin_api;

GRANT SELECT,INSERT ON TABLE rica_plugin_newbi.section_glossary_samples TO rica_admin_api;

CREATE FUNCTION public.rica_sweep_newbi_events() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE changed int;
BEGIN
  DELETE FROM rica_plugin_newbi.events WHERE (account_id,seq) IN (
    SELECT account_id,seq FROM rica_plugin_newbi.events WHERE occurred_at <= statement_timestamp()-interval '720 hours'
    ORDER BY occurred_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;
REVOKE ALL ON FUNCTION public.rica_sweep_newbi_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_sweep_newbi_events() TO rica_runtime;

CREATE FUNCTION public.rica_sweep_newbi_assessments() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog','pg_temp' AS $$
  WITH removed AS (
    DELETE FROM rica_plugin_newbi.discussion_assessments WHERE id IN (
      SELECT id FROM rica_plugin_newbi.discussion_assessments
      WHERE created_at <= statement_timestamp() - interval '30 days'
      ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
    ) RETURNING 1
  ) SELECT count(*)::integer FROM removed
$$;
REVOKE ALL ON FUNCTION public.rica_sweep_newbi_assessments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_sweep_newbi_assessments() TO rica_runtime;

CREATE FUNCTION public.rica_sweep_newbi_retention()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE changed int;
BEGIN
  UPDATE rica_plugin_newbi.replies SET content = NULL, review_prompt = NULL WHERE id IN (
    SELECT id FROM rica_plugin_newbi.replies
    WHERE (content IS NOT NULL OR review_prompt IS NOT NULL)
      AND created_at <= statement_timestamp() - interval '720 hours' AND expires_at <= statement_timestamp()
    ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$function$;
REVOKE ALL ON FUNCTION public.rica_sweep_newbi_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_sweep_newbi_retention() TO rica_runtime;

  SELECT 'rica_newbi_ddl_' || oid::text INTO STRICT owner_role
    FROM pg_catalog.pg_database WHERE datname = current_database();
  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', owner_role);
  EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', owner_role, current_user);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA rica_plugin_newbi TO %I', owner_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', owner_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.rica_newbi_lock_poll_binding_v1(uuid),
    public.rica_newbi_read_active_binding_v1(uuid), public.rica_newbi_read_active_account_v1(uuid) TO %I', owner_role);

  FOREACH relation_name IN ARRAY ARRAY['credentials', 'events', 'event_checkpoints', 'discussion_assessments',
    'author_terms', 'section_glossary_samples', 'replies']::name[]
  LOOP
    EXECUTE format('ALTER TABLE rica_plugin_newbi.%I OWNER TO %I', relation_name, owner_role);
  END LOOP;
  EXECUTE format('ALTER VIEW rica_plugin_newbi.account_profiles OWNER TO %I', owner_role);
  FOREACH signature IN ARRAY ARRAY[
    'claim_event_page(uuid, text)',
    'finish_event_page(uuid, uuid, integer, integer, jsonb, integer, text)',
    'claim_reply(uuid, boolean, uuid, text, text)', 'close_reply(uuid, uuid, text)',
    'finish_reply(uuid, integer, uuid, integer, boolean)', 'execution_target(uuid, text)',
    'reply_preflight(uuid, text, integer, boolean)', 'reply_matches_executor(rica_plugin_newbi.replies, text)',
    'poll_connection(uuid)', 'send_connection(uuid)', 'guard_reply_executor()', 'clear_review_handoff()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION rica_plugin_newbi.%s OWNER TO %I', signature, owner_role);
  END LOOP;
END
$bootstrap$;

COMMIT;
