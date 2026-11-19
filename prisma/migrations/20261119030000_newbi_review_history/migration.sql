BEGIN;

ALTER TABLE public.newbi_replies ADD COLUMN review_record jsonb, ADD COLUMN review_prompt jsonb;
GRANT UPDATE (review_record, review_prompt) ON public.newbi_replies TO rica_admin_api;

CREATE OR REPLACE FUNCTION public.rica_clear_newbi_review_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'pg_temp' AS $$
BEGIN
  NEW.auto_review_handoff := NULL;
  NEW.review_prompt := NULL;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.rica_sweep_newbi_retention() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
DECLARE changed int;
BEGIN
  UPDATE public.newbi_replies SET content = NULL, review_prompt = NULL WHERE id IN (
    SELECT id FROM public.newbi_replies
    WHERE (content IS NOT NULL OR review_prompt IS NOT NULL)
      AND created_at <= statement_timestamp() - interval '720 hours' AND expires_at <= statement_timestamp()
    ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;

COMMIT;
