BEGIN;

DO $roles$
DECLARE
  role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['rica_runtime', 'rica_memory_reader', 'rica_memory_admin']::name[]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
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
GRANT USAGE ON SCHEMA public TO rica_runtime, rica_memory_reader, rica_memory_admin;
GRANT SELECT ON public.characters, public.contacts, public.inbound_events, public.agent_runs, public.outbox TO rica_runtime;
GRANT INSERT ON public.inbound_events, public.agent_runs, public.outbox TO rica_runtime;
GRANT UPDATE (state, state_version, state_reason) ON public.agent_runs TO rica_runtime;
GRANT UPDATE (enqueued_at, processed_at) ON public.outbox TO rica_runtime;
GRANT SELECT ON public.characters TO rica_memory_admin;
GRANT UPDATE (auth_epoch) ON public.characters TO rica_memory_admin;
GRANT SELECT, INSERT, UPDATE ON public.memories, public.memory_sources, public.sources_registry, public.memory_grants
  TO rica_memory_admin;

-- Row locks run with the migration owner's privileges. The runtime role has no binding-table UPDATE grant.
CREATE FUNCTION public.rica_lock_simulated_binding(target_account uuid)
RETURNS TABLE ("characterId" uuid, "identityId" uuid, "accountId" uuid,
               "coreVersion" int, "identityVersion" int, "bindingVersion" int, "authEpoch" int)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.id, i.id, a.id, c.active_core_version, i.active_version, a.binding_version, c.auth_epoch
  FROM public.platform_accounts a
  JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
  JOIN public.characters c ON c.id = i.character_id
  WHERE a.id = target_account AND a.platform IN ('mock-a', 'mock-b')
    AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
  FOR SHARE OF c, i, a
$fn$;

CREATE FUNCTION public.rica_lock_conversation(
  target_character uuid, target_identity uuid, target_account uuid, target_conversation uuid, target_contact uuid
) RETURNS TABLE (channel public."ConversationChannel")
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.channel FROM public.conversations c
  WHERE (c.character_id, c.identity_id, c.account_id, c.id)
    = (target_character, target_identity, target_account, target_conversation)
    AND (c.channel = 'PUBLIC' OR c.private_contact_id = target_contact)
  FOR SHARE
$fn$;

REVOKE ALL ON FUNCTION public.rica_lock_simulated_binding(uuid),
  public.rica_lock_conversation(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_lock_simulated_binding(uuid),
  public.rica_lock_conversation(uuid, uuid, uuid, uuid, uuid) TO rica_runtime;

-- Scope comes from the validated persisted run and lasts only for the calling transaction.
CREATE FUNCTION public.rica_memory_scope()
RETURNS TABLE (character_id uuid, identity_id uuid, account_id uuid,
               conversation_id uuid, contact_id uuid, channel text, purpose text, audience text)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT * FROM jsonb_to_record(NULLIF(current_setting('rica.memory_scope', true), '')::jsonb)
    AS scope(character_id uuid, identity_id uuid, account_id uuid,
             conversation_id uuid, contact_id uuid, channel text, purpose text, audience text)
$fn$;

REVOKE ALL ON FUNCTION public.rica_memory_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_memory_scope() TO rica_memory_reader;

GRANT SELECT ON public.memories TO rica_memory_reader;
GRANT SELECT (character_id, memory_id, source_id) ON public.memory_sources TO rica_memory_reader;
GRANT SELECT (id, character_id, identity_id, account_id, conversation_id, classification, revoked_at)
  ON public.sources_registry TO rica_memory_reader;
GRANT SELECT (character_id, memory_id, recipient_identity_id, recipient_account_id,
              recipient_conversation_id, recipient_contact_id, purpose, audience, valid_from, valid_until, revoked_at)
  ON public.memory_grants TO rica_memory_reader;

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sources_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memory_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY memories_admin ON public.memories TO CURRENT_USER, rica_memory_admin USING (true) WITH CHECK (true);
CREATE POLICY memory_sources_admin ON public.memory_sources TO CURRENT_USER, rica_memory_admin USING (true) WITH CHECK (true);
CREATE POLICY sources_registry_admin ON public.sources_registry TO CURRENT_USER, rica_memory_admin USING (true) WITH CHECK (true);
CREATE POLICY memory_grants_admin ON public.memory_grants TO CURRENT_USER, rica_memory_admin USING (true) WITH CHECK (true);

-- Inspect every source link in the character. Hiding a disallowed source could make a negative check pass.
CREATE POLICY memory_sources_reader ON public.memory_sources FOR SELECT TO rica_memory_reader
  USING (character_id = (SELECT character_id FROM public.rica_memory_scope()));
CREATE POLICY sources_registry_reader ON public.sources_registry FOR SELECT TO rica_memory_reader
  USING (character_id = (SELECT character_id FROM public.rica_memory_scope()));
CREATE POLICY memory_grants_reader ON public.memory_grants FOR SELECT TO rica_memory_reader
  USING (EXISTS (
    SELECT 1 FROM public.rica_memory_scope() s
    WHERE memory_grants.character_id = s.character_id AND recipient_identity_id = s.identity_id
      AND (recipient_account_id IS NULL OR recipient_account_id = s.account_id)
  ));

CREATE FUNCTION public.rica_memory_allowed(m public.memories) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.rica_memory_scope() s
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM public.memory_grants g
        WHERE g.character_id = m.character_id AND g.memory_id = m.id
          AND g.recipient_identity_id = s.identity_id
          AND (g.recipient_account_id IS NULL OR g.recipient_account_id = s.account_id)
          AND g.purpose::text = s.purpose AND g.audience IS NOT DISTINCT FROM s.audience
          AND (g.purpose <> 'PRIVATE_REPLY' OR (
            g.recipient_conversation_id = s.conversation_id AND g.recipient_contact_id = s.contact_id
          ))
          AND g.valid_from <= statement_timestamp() AND g.valid_until > statement_timestamp()
          AND g.revoked_at IS NULL
      ) AS granted
    ) grant_match
    WHERE m.character_id = s.character_id AND s.identity_id IS NOT NULL AND s.account_id IS NOT NULL
      AND m.status = 'ACTIVE' AND m.visibility <> 'RESTRICTED'
      AND (m.scope <> 'CONVERSATION' OR m.conversation_id = s.conversation_id)
      AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
      AND EXISTS (
        SELECT 1 FROM public.memory_sources ms WHERE (ms.character_id, ms.memory_id) = (m.character_id, m.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.memory_sources ms
        JOIN public.sources_registry source ON (source.character_id, source.id) = (ms.character_id, ms.source_id)
        WHERE (ms.character_id, ms.memory_id) = (m.character_id, m.id)
          AND (
            source.revoked_at IS NOT NULL OR source.classification = 'RESTRICTED'
            OR (source.conversation_id IS NOT NULL AND source.conversation_id IS DISTINCT FROM s.conversation_id)
            OR (s.purpose = 'PRIVATE_REPLY' AND source.classification = 'CONFIDENTIAL')
            OR (source.classification <> 'PUBLIC' AND (
              m.scope = 'CORE' OR s.purpose = 'PUBLIC_REFERENCE'
              OR source.identity_id IS DISTINCT FROM s.identity_id
              OR (source.account_id IS NOT NULL AND source.account_id <> s.account_id)
            ))
          )
      )
      AND (
        (s.purpose IN ('INTERNAL_CONTEXT', 'DECISION_SUPPORT') AND (
          m.scope = 'CORE'
          OR (m.scope = 'IDENTITY' AND m.identity_id = s.identity_id)
          OR (m.scope = 'ACCOUNT' AND m.account_id = s.account_id)
          OR (m.scope = 'CONVERSATION' AND m.conversation_id = s.conversation_id)
          OR (grant_match.granted AND m.visibility IN ('PUBLIC', 'PERSONAL'))
        ))
        OR (s.purpose = 'PUBLIC_REFERENCE' AND s.channel IS DISTINCT FROM 'PRIVATE'
            AND m.visibility = 'PUBLIC' AND grant_match.granted)
        OR (s.purpose = 'PRIVATE_REPLY' AND s.channel = 'PRIVATE' AND s.contact_id IS NOT NULL
            AND m.visibility IN ('PUBLIC', 'PERSONAL') AND grant_match.granted)
      )
  )
$fn$;

REVOKE ALL ON FUNCTION public.rica_memory_allowed(public.memories) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_memory_allowed(public.memories) TO rica_memory_reader;

CREATE POLICY memories_reader ON public.memories FOR SELECT TO rica_memory_reader
  USING (
    character_id = (SELECT character_id FROM public.rica_memory_scope())
    AND public.rica_memory_allowed(memories)
  );

COMMIT;
