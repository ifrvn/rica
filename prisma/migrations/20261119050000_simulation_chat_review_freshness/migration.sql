BEGIN;

ALTER TYPE public."RunStateReason" ADD VALUE 'CHAT_REPEAT';
ALTER TYPE public."RunStateReason" ADD VALUE 'CHAT_MOVED_ON';
GRANT SELECT (state_reason) ON public.agent_runs TO rica_admin_api;

CREATE FUNCTION public.rica_chat_reply_key(body text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT lower(btrim(regexp_replace(normalize(body, NFKC), '[[:space:]]+', ' ', 'g')))
$$;

CREATE FUNCTION public.rica_chat_reply_stop(target_run uuid, decision_reason text DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH origin AS MATERIALIZED (
    SELECT r.id, r.character_id, c.simulation_chat_id AS chat_id, e.received_at,
      sender.remote_key AS member, public.rica_chat_reply_key(e.message_text) AS message,
      coalesce(decision_reason,r.participation_decision->>'reason') AS reason
    FROM public.agent_runs r
    JOIN public.inbound_events e ON (e.character_id,e.id) = (r.character_id,r.inbound_event_id)
    JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id) = (e.character_id,e.identity_id,e.account_id,e.conversation_id)
    JOIN public.contacts sender ON (sender.character_id,sender.identity_id,sender.account_id,sender.id)
      = (e.character_id,e.identity_id,e.account_id,e.console_speaker_id)
    WHERE r.id = target_run AND r.mode = 'SIMULATION' AND c.channel = 'PUBLIC'
      AND c.simulation_chat_id IS NOT NULL AND e.source_key LIKE 'console-turn:%'
      AND e.message_text IS NOT NULL AND sender.no_contact_at IS NULL
  )
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.inbound_events e ON (e.character_id,e.identity_id,e.account_id,e.conversation_id) = (c.character_id,c.identity_id,c.account_id,c.id)
    JOIN public.contacts sender ON (sender.character_id,sender.identity_id,sender.account_id,sender.id)
      = (e.character_id,e.identity_id,e.account_id,e.console_speaker_id)
    JOIN public.agent_runs previous ON (previous.character_id,previous.inbound_event_id) = (e.character_id,e.id)
    JOIN public.action_proposals p ON (p.character_id,p.run_id) = (previous.character_id,previous.id)
    WHERE (c.character_id,c.simulation_chat_id) = (o.character_id,o.chat_id) AND c.channel = 'PUBLIC'
      AND sender.remote_key = o.member AND sender.no_contact_at IS NULL AND e.source_key LIKE 'console-turn:%'
      AND e.received_at BETWEEN o.received_at - interval '5 minutes' AND o.received_at + interval '5 minutes'
      AND previous.id <> o.id AND public.rica_chat_reply_key(e.message_text) = o.message
      AND (previous.state IN ('EXECUTING','RECONCILING','SIMULATED')
        OR ((e.received_at,previous.id) < (o.received_at,o.id)
          AND previous.state IN ('WAITING_APPROVAL','READY') AND p.expires_at > statement_timestamp()))
  ) THEN 'CHAT_REPEAT'
  WHEN o.reason = 'SOCIAL_OPENING' AND (
    o.received_at <= statement_timestamp() - interval '10 minutes'
    OR (SELECT count(DISTINCT public.rica_chat_reply_key(message)) >= 4 AND count(DISTINCT member) >= 2
      FROM public.rica_chat_term_sources(o.character_id,o.chat_id,NULL,NULL,16) newer
      WHERE (newer.received_at,newer.id) > (o.received_at,o.id))
  ) THEN 'CHAT_MOVED_ON' END
  FROM origin o
$$;

CREATE OR REPLACE FUNCTION public.rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean)
RETURNS text LANGUAGE sql SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT public.rica_validate_simulation_payload(target_character, target_action,
    CASE WHEN writing_receipt THEN 'RECEIPT' ELSE 'REVIEW' END)
  FROM public.action_proposals a
  WHERE (a.character_id,a.id) = (target_character,target_action)
    AND public.rica_chat_reply_stop(a.run_id) IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.agent_runs r
      CROSS JOIN LATERAL jsonb_to_recordset(r.participation_decision->'glossary') AS used(id uuid, version integer)
      WHERE (r.character_id,r.id) = (a.character_id,a.run_id) AND NOT EXISTS (
        SELECT 1 FROM public.simulation_chat_terms t WHERE t.character_id = r.character_id AND t.id = used.id
          AND t.chat_id = public.rica_console_chat_for_run(r.character_id,r.id)
          AND t.version = used.version AND t.status <> 'DISABLED'
          AND public.rica_chat_term_available(t.character_id,t.chat_id,t.source_runs,NULL)
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.rica_finish_action_review(target_character uuid, target_run uuid, expected_version integer,
  next_state public."RunState") RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  UPDATE public.agent_runs r SET state = next_state, state_version = r.state_version + 1,
    state_reason = CASE WHEN next_state = 'CANCELED'
      THEN coalesce(public.rica_chat_reply_stop(r.id)::public."RunStateReason",r.state_reason) ELSE r.state_reason END
  WHERE (r.character_id,r.id,r.state_version) = (target_character,target_run,expected_version)
    AND r.state = 'WAITING_APPROVAL' AND next_state IN ('READY','REJECTED','CANCELED','EXPIRED')
    AND EXISTS (
      SELECT 1 FROM public.action_proposals a WHERE (a.character_id,a.run_id) = (r.character_id,r.id)
        AND (next_state IN ('CANCELED','EXPIRED') OR public.rica_review_payload(a.character_id,a.id) IS NOT NULL)
    )
  RETURNING r.state_version
$$;

CREATE FUNCTION public.rica_sweep_obsolete_chat_replies() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH obsolete AS MATERIALIZED (
    SELECT r.id, stop.reason FROM public.agent_runs r
    JOIN public.inbound_events e ON (e.character_id,e.id) = (r.character_id,r.inbound_event_id)
    CROSS JOIN LATERAL (SELECT public.rica_chat_reply_stop(r.id) AS reason OFFSET 0) stop
    WHERE r.state = 'WAITING_APPROVAL' AND e.console_speaker_id IS NOT NULL AND stop.reason IS NOT NULL
    ORDER BY r.created_at,r.id LIMIT 50 FOR UPDATE OF r SKIP LOCKED
  ), closed AS (
    UPDATE public.agent_runs r SET state = 'CANCELED', state_reason = obsolete.reason::public."RunStateReason",
      state_version = r.state_version + 1 FROM obsolete
    WHERE r.id = obsolete.id AND r.state = 'WAITING_APPROVAL' RETURNING 1
  ) SELECT count(*)::integer FROM closed
$$;

REVOKE ALL ON FUNCTION public.rica_chat_reply_key(text), public.rica_chat_reply_stop(uuid,text),
  public.rica_sweep_obsolete_chat_replies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_chat_reply_stop(uuid,text) TO rica_runtime, rica_admin_api, rica_simulation_executor;
GRANT EXECUTE ON FUNCTION public.rica_sweep_obsolete_chat_replies() TO rica_runtime;

COMMIT;
