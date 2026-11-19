BEGIN;

CREATE TABLE public.newbi_section_glossary_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  section_id integer NOT NULL CHECK (section_id > 0),
  author_key text NOT NULL,
  term_key text NOT NULL,
  meaning_key text NOT NULL,
  term text NOT NULL,
  meaning text NOT NULL,
  tone text NOT NULL CHECK (tone IN ('neutral','playful','sarcastic','sensitive')),
  source_assessment_id uuid NOT NULL,
  source_comments uuid[] NOT NULL CHECK (cardinality(source_comments) = 3),
  CONSTRAINT newbi_section_glossary_sample_scope_key UNIQUE (account_id, section_id, term_key, meaning_key, author_key),
  CONSTRAINT newbi_section_glossary_sample_source_fkey FOREIGN KEY (account_id, source_assessment_id)
    REFERENCES public.newbi_discussion_assessments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX newbi_section_glossary_sample_source_idx ON public.newbi_section_glossary_samples(account_id, source_assessment_id);
GRANT SELECT, INSERT ON public.newbi_section_glossary_samples TO rica_admin_api;

COMMIT;
