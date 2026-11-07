BEGIN;

-- Resolve external keys within the locked account without granting table-wide account reads.
CREATE FUNCTION public.rica_resolve_simulated_event_scope(
  target_account uuid, target_platform text, target_instance text, target_remote_account text,
  target_thread text, target_contact text
) RETURNS TABLE ("conversationId" uuid, "contactId" uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
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
$fn$;

REVOKE ALL ON FUNCTION public.rica_resolve_simulated_event_scope(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_resolve_simulated_event_scope(uuid, text, text, text, text, text) TO rica_runtime;

-- Old drafts predate explicit model provenance and retain a null pair.
ALTER TABLE public.simulated_drafts
  ADD COLUMN model_id text,
  ADD COLUMN model_version text,
  ADD CONSTRAINT simulated_drafts_model_pair CHECK (
    (model_id IS NULL AND model_version IS NULL)
    OR (model_id IS NOT NULL AND model_version IS NOT NULL AND model_id <> '' AND model_version <> '')
  );

ALTER TABLE public.inbound_events
  ADD COLUMN adapter_id text,
  ADD COLUMN adapter_version text,
  ADD CONSTRAINT inbound_events_adapter_pair CHECK (
    (adapter_id IS NULL AND adapter_version IS NULL)
    OR (adapter_id IN ('mock-a', 'mock-b') AND adapter_id IS NOT NULL
      AND adapter_version IS NOT NULL AND adapter_version <> '' AND message_text IS NOT NULL)
  );

COMMIT;
