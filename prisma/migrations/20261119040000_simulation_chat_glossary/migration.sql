BEGIN;

CREATE TABLE public.simulation_chat_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  term_key text NOT NULL,
  term text NOT NULL,
  meaning text NOT NULL,
  tone text NOT NULL CHECK (tone IN ('neutral', 'playful', 'sarcastic', 'sensitive')),
  status text NOT NULL DEFAULT 'LEARNED' CHECK (status IN ('LEARNED', 'CORRECTED', 'DISABLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source_runs uuid[] NOT NULL CHECK (cardinality(source_runs) = 3),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_chat_terms_character_id_chat_id_fkey FOREIGN KEY (character_id, chat_id)
    REFERENCES public.simulation_chats(character_id, id) ON DELETE CASCADE,
  UNIQUE (character_id, chat_id, term_key)
);

CREATE FUNCTION public.rica_chat_term_sources(target_character uuid, target_chat uuid, before_at timestamptz,
  refs uuid[] DEFAULT NULL, page_size integer DEFAULT 24)
RETURNS TABLE(id uuid, speaker text, member text, message text, received_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT r.id, p.display_label, p.remote_key, e.message_text, e.received_at
  FROM public.conversations c
  JOIN public.inbound_events e ON (e.character_id,e.identity_id,e.account_id,e.conversation_id)
    = (c.character_id,c.identity_id,c.account_id,c.id)
  JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id,p.id)
    = (e.character_id,e.identity_id,e.account_id,e.console_speaker_id)
  JOIN public.agent_runs r ON (r.character_id,r.identity_id,r.account_id,r.inbound_event_id)
    = (e.character_id,e.identity_id,e.account_id,e.id)
  WHERE (c.character_id,c.simulation_chat_id) = (target_character,target_chat) AND c.channel = 'PUBLIC'
    AND r.mode = 'SIMULATION' AND e.source_key LIKE 'console-turn:%'
    AND p.remote_key LIKE 'console-member:' || target_chat || ':%' AND p.no_contact_at IS NULL
    AND e.message_text IS NOT NULL AND e.body_expired_at IS NULL
    AND e.received_at > statement_timestamp() - interval '30 days'
    AND (before_at IS NULL OR e.received_at <= before_at)
    AND (refs IS NULL OR r.id = ANY(refs))
  ORDER BY e.received_at DESC,r.id DESC LIMIT greatest(1,least(24,page_size))
$$;

CREATE FUNCTION public.rica_chat_term_available(target_character uuid, target_chat uuid, refs uuid[], before_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT count(*) = 3 AND count(DISTINCT member) >= 2
    AND count(DISTINCT lower(regexp_replace(btrim(message), '[[:space:]]+', ' ', 'g'))) = 3
  FROM public.rica_chat_term_sources(target_character,target_chat,before_at,refs,3)
$$;

CREATE FUNCTION public.rica_chat_glossary_context(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT jsonb_build_object(
    'examples', coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'speaker',s.speaker,'member',s.member,'message',left(s.message,300))
      ORDER BY s.received_at DESC,s.id DESC) FROM public.rica_chat_term_sources(r.character_id,c.simulation_chat_id,e.received_at,NULL,16) s),'[]'::jsonb),
    'terms', coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'term',t.term,'meaning',t.meaning,'tone',t.tone,
      'version',t.version,'sourceRuns',t.source_runs) ORDER BY t.updated_at DESC,t.id DESC)
      FROM public.simulation_chat_terms t WHERE (t.character_id,t.chat_id) = (r.character_id,c.simulation_chat_id)
        AND t.status <> 'DISABLED' AND public.rica_chat_term_available(t.character_id,t.chat_id,t.source_runs,e.received_at)),'[]'::jsonb))
  FROM public.agent_runs r
  JOIN public.inbound_events e ON (e.character_id,e.id) = (r.character_id,r.inbound_event_id)
  JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id) = (e.character_id,e.identity_id,e.account_id,e.conversation_id)
  WHERE r.id = target_run AND c.simulation_chat_id IS NOT NULL AND e.console_speaker_id IS NOT NULL
    AND r.state = 'CONTEXT_READY' AND r.mode = 'SIMULATION' AND c.channel = 'PUBLIC'
    AND public.rica_simulated_review_target(r.id) IS NOT NULL
$$;

CREATE FUNCTION public.rica_save_chat_terms(target_run uuid, candidates jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
DECLARE scope record; item record;
BEGIN
  SELECT r.character_id,c.simulation_chat_id,e.received_at INTO scope
  FROM public.agent_runs r
  JOIN public.inbound_events e ON (e.character_id,e.id) = (r.character_id,r.inbound_event_id)
  JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id) = (e.character_id,e.identity_id,e.account_id,e.conversation_id)
  JOIN public.simulation_chats chat ON (chat.character_id,chat.id) = (c.character_id,c.simulation_chat_id)
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND e.console_speaker_id IS NOT NULL
    AND r.mode = 'SIMULATION' AND c.channel = 'PUBLIC' AND public.rica_simulated_review_target(r.id) IS NOT NULL
  FOR UPDATE OF chat;
  IF NOT FOUND OR jsonb_typeof(candidates) <> 'array' OR jsonb_array_length(candidates) > 2 THEN RETURN; END IF;
  DELETE FROM public.simulation_chat_terms t WHERE (t.character_id,t.chat_id) = (scope.character_id,scope.simulation_chat_id)
    AND t.status = 'LEARNED' AND t.updated_at <= statement_timestamp() - interval '30 days'
    AND NOT public.rica_chat_term_available(t.character_id,t.chat_id,t.source_runs,NULL);
  FOR item IN SELECT * FROM jsonb_to_recordset(candidates) AS x("termKey" text, term text, meaning text, tone text, "sourceRuns" uuid[]) LOOP
    IF char_length(item.term) BETWEEN 2 AND 24 AND char_length(item."termKey") BETWEEN 2 AND 40
      AND char_length(item.meaning) BETWEEN 1 AND 120 AND item.meaning !~ '[[:cntrl:]]'
      AND cardinality(item."sourceRuns") = 3
      AND public.rica_chat_term_available(scope.character_id,scope.simulation_chat_id,item."sourceRuns",scope.received_at)
    THEN
      INSERT INTO public.simulation_chat_terms AS stored (character_id,chat_id,term_key,term,meaning,tone,source_runs)
      SELECT scope.character_id,scope.simulation_chat_id,item."termKey",item.term,item.meaning,item.tone,item."sourceRuns"
      WHERE (SELECT count(*) FROM public.simulation_chat_terms
        WHERE (character_id,chat_id) = (scope.character_id,scope.simulation_chat_id)) < 64
        OR EXISTS (SELECT 1 FROM public.simulation_chat_terms
          WHERE (character_id,chat_id,term_key) = (scope.character_id,scope.simulation_chat_id,item."termKey"))
      ON CONFLICT (character_id,chat_id,term_key) DO UPDATE SET
        term = EXCLUDED.term, meaning = EXCLUDED.meaning, tone = EXCLUDED.tone, source_runs = EXCLUDED.source_runs,
        version = stored.version + 1, updated_at = now()
      WHERE stored.status = 'LEARNED'
        AND NOT public.rica_chat_term_available(stored.character_id,stored.chat_id,stored.source_runs,NULL);
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.rica_bound_simulation_payload(target_character uuid, target_action uuid, writing_receipt boolean)
RETURNS text LANGUAGE sql SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT public.rica_validate_simulation_payload(target_character, target_action,
    CASE WHEN writing_receipt THEN 'RECEIPT' ELSE 'REVIEW' END)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id,r.id) = (a.character_id,a.run_id)
    CROSS JOIN LATERAL jsonb_to_recordset(r.participation_decision->'glossary') AS used(id uuid, version integer)
    WHERE (a.character_id,a.id) = (target_character,target_action) AND NOT EXISTS (
      SELECT 1 FROM public.simulation_chat_terms t WHERE t.character_id = r.character_id AND t.id = used.id
        AND t.chat_id = public.rica_console_chat_for_run(r.character_id,r.id)
        AND t.version = used.version AND t.status <> 'DISABLED'
        AND public.rica_chat_term_available(t.character_id,t.chat_id,t.source_runs,NULL)
    )
  )
$$;

CREATE FUNCTION public.rica_run_glossary(target_character uuid, target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT coalesce(jsonb_agg(term.entry - 'sourceRuns' ORDER BY term.rank), '[]'::jsonb)
  FROM public.agent_runs r
  CROSS JOIN LATERAL jsonb_array_elements(r.participation_decision->'glossary') WITH ORDINALITY AS term(entry, rank)
  WHERE (r.character_id,r.id) = (target_character,target_run) AND r.references_expired_at IS NULL
    AND public.rica_chat_term_available(r.character_id,public.rica_console_chat_for_run(r.character_id,r.id),
      ARRAY(SELECT jsonb_array_elements_text(term.entry->'sourceRuns')::uuid),NULL)
$$;

REVOKE ALL ON FUNCTION public.rica_chat_term_sources(uuid,uuid,timestamptz,uuid[],integer),
  public.rica_chat_term_available(uuid,uuid,uuid[],timestamptz),public.rica_chat_glossary_context(uuid),
  public.rica_save_chat_terms(uuid,jsonb),public.rica_run_glossary(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_chat_glossary_context(uuid),public.rica_save_chat_terms(uuid,jsonb) TO rica_runtime;
GRANT EXECUTE ON FUNCTION public.rica_chat_term_available(uuid,uuid,uuid[],timestamptz),public.rica_run_glossary(uuid,uuid) TO rica_admin_api;
GRANT SELECT ON public.simulation_chat_terms TO rica_admin_api;
GRANT UPDATE (meaning,tone,status,version,updated_at) ON public.simulation_chat_terms TO rica_admin_api;

COMMIT;
