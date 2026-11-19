BEGIN;

CREATE TABLE public.newbi_discussion_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  account_id uuid NOT NULL,
  post_id uuid NOT NULL,
  auth_epoch integer NOT NULL,
  binding_version integer NOT NULL,
  identity text NOT NULL,
  participation text NOT NULL CHECK (participation IN ('talkative','balanced','reserved')),
  model text,
  system_prompt text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT newbi_discussion_assessments_account_fkey FOREIGN KEY (character_id,identity_id,account_id)
    REFERENCES public.platform_accounts(character_id,identity_id,id) ON DELETE CASCADE,
  CHECK ((result IS NULL) = (finished_at IS NULL))
);
CREATE INDEX newbi_assessments_account_post_idx ON public.newbi_discussion_assessments(account_id,post_id,created_at,id);
CREATE INDEX newbi_assessments_created_at_idx ON public.newbi_discussion_assessments(created_at);

GRANT SELECT, INSERT ON public.newbi_discussion_assessments TO rica_admin_api;
GRANT UPDATE (model, system_prompt, result, finished_at) ON public.newbi_discussion_assessments TO rica_admin_api;

CREATE FUNCTION public.rica_sweep_newbi_assessments() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog','pg_temp' AS $$
  WITH removed AS (
    DELETE FROM public.newbi_discussion_assessments WHERE id IN (
      SELECT id FROM public.newbi_discussion_assessments
      WHERE created_at <= statement_timestamp() - interval '30 days'
      ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
    ) RETURNING 1
  ) SELECT count(*)::integer FROM removed
$$;
REVOKE ALL ON FUNCTION public.rica_sweep_newbi_assessments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_sweep_newbi_assessments() TO rica_runtime;

COMMIT;
