BEGIN;

CREATE TABLE public.auto_review_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  prompt text NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 4000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (character_id, id),
  UNIQUE (character_id, name)
);

ALTER TABLE public.identities
  ADD COLUMN auto_review_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN im_manual_review_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_review_version integer NOT NULL DEFAULT 0 CHECK (auto_review_version >= 0),
  ADD COLUMN auto_review_template_id uuid,
  ADD FOREIGN KEY (character_id, auto_review_template_id)
    REFERENCES public.auto_review_templates(character_id, id) ON DELETE RESTRICT;

CREATE INDEX identities_character_id_auto_review_template_id_idx
  ON public.identities (character_id, auto_review_template_id);

INSERT INTO public.auto_review_templates (character_id, name, prompt)
SELECT id, '原角色审核规则', auto_review_prompt FROM public.characters
WHERE auto_review_prompt IS NOT NULL;

UPDATE public.identities i
SET auto_review_enabled = c.auto_review_enabled,
    im_manual_review_enabled = c.im_manual_review_enabled,
    auto_review_version = c.auto_review_version,
    auto_review_template_id = t.id
FROM public.characters c LEFT JOIN public.auto_review_templates t ON t.character_id = c.id
WHERE c.id = i.character_id;

GRANT SELECT, INSERT ON public.auto_review_templates TO rica_admin_api;
GRANT UPDATE (name, prompt, version) ON public.auto_review_templates TO rica_admin_api;
GRANT UPDATE (auto_review_enabled, im_manual_review_enabled, auto_review_version, auto_review_template_id)
  ON public.identities TO rica_admin_api;
GRANT SELECT (identity_id) ON public.agent_runs TO rica_admin_api;

CREATE FUNCTION public.rica_simulation_review_flags(target_run uuid)
RETURNS TABLE(enabled boolean, manual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT i.auto_review_enabled, i.im_manual_review_enabled
  FROM public.agent_runs r
  JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
$$;
REVOKE ALL ON FUNCTION public.rica_simulation_review_flags(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_review_flags(uuid) TO rica_runtime;

CREATE OR REPLACE FUNCTION public.rica_close_unapproved_im_reply(target_run uuid DEFAULT NULL) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH closed AS (
    UPDATE public.agent_runs r
    SET state = 'CANCELED', state_reason = 'IM_MANUAL_REVIEW_DISABLED', state_version = r.state_version + 1
    FROM public.action_proposals a, public.identities i
    WHERE (r.character_id,r.id) = (a.character_id,a.run_id) AND r.state = 'WAITING_APPROVAL'
      AND (i.character_id,i.id) = (r.character_id,r.identity_id)
      AND (target_run IS NULL OR r.id = target_run)
      AND a.is_im AND NOT i.im_manual_review_enabled
      AND (NOT i.auto_review_enabled OR a.auto_review_handoff IS NOT NULL
        OR a.auto_review_until IS NULL OR a.auto_review_until <= statement_timestamp())
    RETURNING 1
  ) SELECT count(*)::integer FROM closed
$$;

ALTER TABLE public.characters
  DROP COLUMN auto_review_enabled,
  DROP COLUMN im_manual_review_enabled,
  DROP COLUMN auto_review_prompt,
  DROP COLUMN auto_review_version;

COMMIT;
