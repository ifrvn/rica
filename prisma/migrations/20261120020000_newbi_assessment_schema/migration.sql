BEGIN;

ALTER TABLE public.newbi_discussion_assessments SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_discussion_assessments RENAME TO discussion_assessments;
ALTER TABLE public.newbi_author_terms SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_author_terms RENAME TO author_terms;
ALTER TABLE public.newbi_section_glossary_samples SET SCHEMA rica_plugin_newbi;
ALTER TABLE rica_plugin_newbi.newbi_section_glossary_samples RENAME TO section_glossary_samples;

CREATE OR REPLACE FUNCTION public.rica_sweep_newbi_assessments() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog','pg_temp' AS $$
  WITH removed AS (
    DELETE FROM rica_plugin_newbi.discussion_assessments WHERE id IN (
      SELECT id FROM rica_plugin_newbi.discussion_assessments
      WHERE created_at <= statement_timestamp() - interval '30 days'
      ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
    ) RETURNING 1
  ) SELECT count(*)::integer FROM removed
$$;

COMMIT;
