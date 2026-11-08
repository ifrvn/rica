BEGIN;

ALTER TABLE public.action_proposals
  ADD COLUMN adapter_id text,
  ADD COLUMN adapter_contract_version int,
  ADD CONSTRAINT action_proposals_adapter_binding_check CHECK (
    (policy_version < 3 AND adapter_id IS NULL AND adapter_contract_version IS NULL)
    OR (policy_version >= 3 AND adapter_id IS NOT NULL AND adapter_id <> '' AND adapter_version <> ''
      AND adapter_contract_version IS NOT NULL AND adapter_contract_version > 0)
  );

ALTER TABLE public.simulation_attempts
  ADD COLUMN review_digest varchar(64),
  ADD CONSTRAINT simulation_attempts_review_digest_check CHECK (review_digest ~ '^[0-9a-f]{64}$');

-- Historical review payloads are no longer eligible for approval or a new permit.
-- The receipt path calls rica_bound_simulation_payload directly and keeps its existing checks.
CREATE OR REPLACE FUNCTION public.rica_review_payload(target_character uuid, target_action uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT public.rica_bound_simulation_payload(a.character_id, a.id, false)
  FROM public.action_proposals a
  WHERE (a.character_id, a.id) = (target_character, target_action)
    AND a.adapter_id IS NOT NULL
$fn$;

CREATE FUNCTION public.rica_guard_simulation_permit_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.status <> 'PERMITTED' OR NOT EXISTS (
    SELECT 1 FROM public.action_proposals a
    JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    WHERE (a.character_id, a.id) = (NEW.character_id, NEW.action_id)
      AND a.adapter_id IS NOT NULL AND a.review_digest = NEW.review_digest
      AND approval.decision = 'APPROVE' AND approval.review_digest = a.review_digest
      AND r.mode = 'SIMULATION' AND r.state = 'READY' AND r.account_id = NEW.account_id
      AND NEW.permit_until <= least(a.expires_at, approval.expires_at)
      AND NEW.permit_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Simulation permit requires a current adapter-bound approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_guard_simulation_permit_binding() FROM PUBLIC;
CREATE TRIGGER simulation_permit_binding
  BEFORE INSERT ON public.simulation_attempts
  FOR EACH ROW EXECUTE FUNCTION public.rica_guard_simulation_permit_binding();

CREATE OR REPLACE FUNCTION public.rica_replay_run_with_time(target_character uuid,target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH replay AS MATERIALIZED (
    SELECT public.rica_replay_simulation_run(target_character,target_run) AS view,
      r.context_timezone,r.goal_refs,r.references_expired_at,d.belief_refs,a.adapter_id,a.adapter_contract_version
    FROM public.agent_runs r
    LEFT JOIN public.simulated_drafts d ON (d.character_id,d.run_id) = (r.character_id,r.id)
    LEFT JOIN public.action_proposals a ON (a.character_id,a.run_id) = (r.character_id,r.id)
    WHERE (r.character_id,r.id) = (target_character,target_run)
  )
  SELECT view
    || jsonb_build_object('contextTimezone',context_timezone,'goalRefs',goal_refs,
      'referencesExpiredAt',references_expired_at,'beliefRefs',COALESCE(belief_refs,'[]'::jsonb))
    || CASE WHEN references_expired_at IS NOT NULL THEN jsonb_build_object('schedule',NULL) ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(view->'proposal') = 'object' THEN jsonb_build_object('proposal',view->'proposal'
      || jsonb_build_object('adapterId',adapter_id,'adapterContractVersion',adapter_contract_version)) ELSE '{}'::jsonb END
  FROM replay
$fn$;

COMMIT;
