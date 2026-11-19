BEGIN;

-- Existing inbox history predates background assessment. Only newly committed pages can start it.
ALTER TABLE public.newbi_events ADD COLUMN received_at timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00';
ALTER TABLE public.newbi_events ALTER COLUMN received_at SET DEFAULT clock_timestamp();
CREATE INDEX newbi_events_received_at_idx ON public.newbi_events(received_at);

ALTER TABLE public.newbi_discussion_assessments ADD COLUMN trigger_seq varchar(40);
ALTER TABLE public.newbi_discussion_assessments ADD CONSTRAINT newbi_assessments_background_trigger_key UNIQUE (account_id, trigger_seq);

COMMIT;
