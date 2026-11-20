ALTER TABLE public.action_proposals ADD COLUMN auto_review_handoff jsonb;

GRANT UPDATE (auto_review_handoff) ON public.action_proposals TO rica_admin_api;

-- Review feedback can refer to the draft. Discard it when the draft is erased.
CREATE FUNCTION public.rica_clear_simulation_review_handoff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  UPDATE public.action_proposals SET auto_review_handoff = NULL
  WHERE character_id = NEW.character_id AND run_id = NEW.run_id AND auto_review_handoff IS NOT NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.rica_clear_simulation_review_handoff() FROM PUBLIC;
CREATE TRIGGER simulated_drafts_clear_review_handoff
AFTER UPDATE OF content ON public.simulated_drafts FOR EACH ROW
WHEN (OLD.content IS NOT NULL AND NEW.content IS NULL)
EXECUTE FUNCTION public.rica_clear_simulation_review_handoff();
