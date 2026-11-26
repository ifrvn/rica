BEGIN;

ALTER TYPE public."RunStateReason" ADD VALUE 'IM_MANUAL_REVIEW_DISABLED';

ALTER TABLE public.characters ADD COLUMN im_manual_review_enabled boolean NOT NULL DEFAULT false;
GRANT UPDATE (im_manual_review_enabled) ON public.characters TO rica_admin_api;

ALTER TABLE public.action_proposals ADD COLUMN is_im boolean NOT NULL DEFAULT false;
-- mock-a is the only IM adapter shipped before this migration.
UPDATE public.action_proposals SET is_im = true WHERE adapter_id = 'mock-a';

COMMIT;

CREATE FUNCTION public.rica_close_unapproved_im_reply(target_run uuid DEFAULT NULL) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH closed AS (
    UPDATE public.agent_runs r
    SET state = 'CANCELED', state_reason = 'IM_MANUAL_REVIEW_DISABLED', state_version = r.state_version + 1
    FROM public.action_proposals a JOIN public.characters c ON c.id = a.character_id
    WHERE (r.character_id,r.id) = (a.character_id,a.run_id) AND r.state = 'WAITING_APPROVAL'
      AND (target_run IS NULL OR r.id = target_run)
      AND a.is_im AND NOT c.im_manual_review_enabled
      AND (NOT c.auto_review_enabled OR a.auto_review_handoff IS NOT NULL
        OR a.auto_review_until IS NULL OR a.auto_review_until <= statement_timestamp())
    RETURNING 1
  ) SELECT count(*)::integer FROM closed
$$;

REVOKE ALL ON FUNCTION public.rica_close_unapproved_im_reply(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_close_unapproved_im_reply(uuid) TO rica_runtime;
