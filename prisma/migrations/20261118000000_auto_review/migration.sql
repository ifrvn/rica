ALTER TABLE public.characters
  ADD COLUMN auto_review_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_review_prompt text,
  ADD COLUMN auto_review_version integer NOT NULL DEFAULT 0;

GRANT UPDATE (auto_review_enabled, auto_review_prompt, auto_review_version) ON public.characters TO rica_admin_api;

ALTER TABLE public.newbi_replies ADD COLUMN auto_review_version integer;
GRANT UPDATE (auto_review_version) ON public.newbi_replies TO rica_admin_api;
