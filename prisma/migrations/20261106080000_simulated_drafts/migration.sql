BEGIN;

ALTER TYPE "RunState" ADD VALUE 'DRAFTED' BEFORE 'CANCELED';
ALTER TYPE "RunStateReason" ADD VALUE 'DRAFT_UNAVAILABLE';

ALTER TABLE public.inbound_events ADD COLUMN message_text text,
  ADD CONSTRAINT inbound_events_message_has_conversation CHECK (
    message_text IS NULL OR (
      conversation_id IS NOT NULL AND char_length(message_text) BETWEEN 1 AND 4000
      AND btrim(message_text) <> ''
    )
  );

ALTER TABLE public.outbox ADD CONSTRAINT outbox_draft_queued_requires_run
  CHECK (type <> 'SimulatedDraftQueued.v1' OR run_id IS NOT NULL);

CREATE TABLE public.simulated_drafts (
  character_id uuid NOT NULL,
  run_id uuid NOT NULL,
  content text,
  decision_evidence_ids uuid[] NOT NULL,
  writing_evidence_ids uuid[] NOT NULL,
  citation_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT simulated_drafts_pkey PRIMARY KEY (character_id, run_id),
  CONSTRAINT simulated_drafts_character_id_run_id_fkey
    FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs (character_id, id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT simulated_drafts_content_length CHECK (
    content IS NULL OR (char_length(content) BETWEEN 1 AND 4000 AND btrim(content) <> '')
  ),
  CONSTRAINT simulated_drafts_evidence_bounds CHECK (
    cardinality(decision_evidence_ids) <= 8 AND cardinality(writing_evidence_ids) <= 8
    AND cardinality(citation_ids) <= 8 AND citation_ids <@ writing_evidence_ids
  )
);

-- Until the approval service implements authorized reads, only the owner can inspect drafts.
GRANT INSERT ON public.simulated_drafts TO rica_runtime;
ALTER TABLE public.simulated_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulated_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY simulated_drafts_owner ON public.simulated_drafts TO CURRENT_USER
  USING (true) WITH CHECK (true);
CREATE POLICY simulated_drafts_runtime ON public.simulated_drafts FOR INSERT TO rica_runtime
  WITH CHECK (content IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.agent_runs r
    JOIN public.characters c ON c.id = r.character_id AND c.auth_epoch = r.auth_epoch
    WHERE (r.character_id, r.id) = (simulated_drafts.character_id, simulated_drafts.run_id)
      AND r.state = 'CONTEXT_READY' AND r.mode = 'SIMULATION'
  ));

-- Revocation already takes an exclusive lock on the character. Draft commits hold a
-- shared binding lock, so revocation either clears a committed draft or blocks its write.
CREATE FUNCTION public.rica_clear_stale_draft_content() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  UPDATE public.simulated_drafts SET content = NULL
  WHERE character_id = NEW.id AND content IS NOT NULL;
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rica_clear_stale_draft_content() FROM PUBLIC;
CREATE TRIGGER characters_clear_stale_draft_content
AFTER UPDATE OF auth_epoch ON public.characters
FOR EACH ROW WHEN (OLD.auth_epoch IS DISTINCT FROM NEW.auth_epoch)
EXECUTE FUNCTION public.rica_clear_stale_draft_content();

COMMIT;
