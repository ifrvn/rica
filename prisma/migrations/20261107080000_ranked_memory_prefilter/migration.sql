BEGIN;

-- The scope function decodes one transaction-local record. The default estimate
-- of 1000 rows encourages expensive plans for the grant and provenance checks.
ALTER FUNCTION public.rica_memory_scope() ROWS 1;

-- A single scope lookup and native access check precede grant and provenance lookups.
CREATE OR REPLACE FUNCTION public.rica_memory_allowed(m public.memories) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
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
    AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()),
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
        AND g.valid_from <= statement_timestamp() AND g.valid_until > statement_timestamp()
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
$fn$;

-- Only ranked reads add keyword patterns to the transaction scope. The guard rejects
-- ASCII rows that cannot match, while Unicode and the current conversation still
-- reach the original authorization check. Direct reads retain the full policy.
ALTER POLICY memories_reader ON public.memories USING (
  character_id = (SELECT character_id FROM public.rica_memory_scope())
  -- Native memory belongs to this identity or the core. Any other row needs
  -- at least one grant visible to this scope before further verification.
  AND (
    scope = 'CORE'
    OR identity_id = (SELECT identity_id FROM public.rica_memory_scope())
    OR id IN (
      SELECT g.memory_id FROM public.memory_grants g
      WHERE g.character_id = (SELECT character_id FROM public.rica_memory_scope())
    )
  )
  AND CASE
    WHEN (SELECT NULLIF(current_setting('rica.memory_scope', true), '')::jsonb -> 'keyword_patterns') IS NULL
      OR (SELECT getdatabaseencoding() <> 'UTF8')
      OR octet_length(content) <> length(content)
      OR lower(content COLLATE pg_catalog."C") LIKE ANY (
        ARRAY(SELECT jsonb_array_elements_text(
          NULLIF(current_setting('rica.memory_scope', true), '')::jsonb -> 'keyword_patterns'
        ))
      )
      OR conversation_id = (SELECT conversation_id FROM public.rica_memory_scope())
      OR id IN (
        SELECT ms.memory_id
        FROM public.memory_sources ms
        JOIN public.sources_registry source ON (source.character_id, source.id) = (ms.character_id, ms.source_id)
        WHERE source.character_id = (SELECT character_id FROM public.rica_memory_scope())
          AND source.conversation_id = (SELECT conversation_id FROM public.rica_memory_scope())
      )
    THEN public.rica_memory_allowed(memories)
    ELSE false
  END
);

COMMIT;
