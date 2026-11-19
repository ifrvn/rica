BEGIN;

ALTER TABLE public.newbi_discussion_assessments ADD COLUMN glossary_used jsonb;
ALTER TABLE public.newbi_discussion_assessments ADD CONSTRAINT newbi_assessments_account_id_key UNIQUE (account_id, id);

CREATE TABLE public.newbi_author_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  author_key text NOT NULL,
  term_key text NOT NULL,
  term text NOT NULL,
  meaning text NOT NULL,
  tone text NOT NULL CHECK (tone IN ('neutral','playful','sarcastic','sensitive')),
  source_assessment_id uuid NOT NULL,
  source_comments uuid[] NOT NULL CHECK (cardinality(source_comments) = 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newbi_author_terms_scope_key UNIQUE (account_id, author_key, term_key),
  CONSTRAINT newbi_author_terms_source_fkey FOREIGN KEY (account_id, source_assessment_id)
    REFERENCES public.newbi_discussion_assessments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX newbi_author_terms_source_idx ON public.newbi_author_terms(account_id, source_assessment_id);

GRANT UPDATE (glossary_used) ON public.newbi_discussion_assessments TO rica_admin_api;
GRANT SELECT, INSERT ON public.newbi_author_terms TO rica_admin_api;

COMMIT;
