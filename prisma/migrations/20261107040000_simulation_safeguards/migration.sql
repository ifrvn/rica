BEGIN;

-- AlterTable
ALTER TABLE "simulation_attempts" ADD COLUMN     "contact_id" UUID,
ADD COLUMN     "resolution_evidence" TEXT,
ADD COLUMN     "resolution_reason" TEXT,
ADD COLUMN     "resolved_by" TEXT;

-- CreateIndex
CREATE INDEX "simulation_attempts_account_id_contact_id_permit_until_idx" ON "simulation_attempts"("account_id", "contact_id", "permit_until");

-- Previously recorded reservations count toward the same contact window after upgrade.
UPDATE public.simulation_attempts s SET contact_id = (a.target->>'contactId')::uuid
FROM public.action_proposals a
WHERE (a.character_id, a.id) = (s.character_id, s.action_id)
  AND a.target->>'contactId' IS NOT NULL;

ALTER TABLE public.simulation_attempts ADD CONSTRAINT simulation_resolution_complete CHECK (
  (resolved_by IS NULL AND resolution_reason IS NULL AND resolution_evidence IS NULL)
  OR (resolved_by IS NOT NULL AND resolution_reason IS NOT NULL AND resolution_evidence IS NOT NULL
    AND status IN ('CONFIRMED', 'NOT_SENT'))
);

REVOKE SELECT ON public.simulation_attempts FROM rica_simulation_executor;
GRANT SELECT (action_id, character_id, account_id, contact_id, status, window_start, permit_until, created_at)
  ON public.simulation_attempts TO rica_simulation_executor;

CREATE FUNCTION public.rica_simulation_disclosure(target_run uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT btrim(c.hard_profile->>'aiDisclosure')
  FROM public.agent_runs r
  JOIN public.core_versions c ON (c.character_id, c.version) = (r.character_id, r.core_version)
  WHERE r.id = target_run AND r.mode = 'SIMULATION'
    AND jsonb_typeof(c.hard_profile->'aiDisclosure') = 'string'
    AND char_length(btrim(c.hard_profile->>'aiDisclosure')) BETWEEN 1 AND 240
    AND c.hard_profile->>'aiDisclosure' !~ '[[:cntrl:]]'
$fn$;

REVOKE ALL ON FUNCTION public.rica_simulation_disclosure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_disclosure(uuid) TO rica_runtime;

CREATE OR REPLACE FUNCTION public.rica_simulation_payload_allowed(target_character uuid, target_action uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE(right(payload.content, char_length(disclosure.line)) = disclosure.line, false)
  FROM public.action_proposals a
  CROSS JOIN LATERAL (SELECT public.rica_review_payload(target_character, target_action) AS content) payload
  CROSS JOIN LATERAL (SELECT E'\n\nAI 披露：' || public.rica_simulation_disclosure(a.run_id) AS line) disclosure
  WHERE (a.character_id, a.id) = (target_character, target_action)
$fn$;

-- In this local simulator a sealed permit cannot produce another ledger entry.
-- A ledger entry confirms delivery; an empty sealed ledger proves non-delivery.
CREATE FUNCTION public.rica_simulation_reconciliation(target_character uuid, target_action uuid)
RETURNS TABLE (version int, state text, outcome text, "evidenceRef" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT r.state_version, r.state::text, proof.outcome,
    CASE WHEN proof.outcome IS NOT NULL THEN
      encode(sha256(convert_to(a.id::text || ':local-ledger:' || proof.outcome, 'UTF8')), 'hex')
    END
  FROM public.action_proposals a
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  JOIN public.simulation_attempts s ON (s.character_id, s.action_id) = (a.character_id, a.id)
  LEFT JOIN public.simulation_receipts receipt ON (receipt.character_id, receipt.action_id) = (s.character_id, s.action_id)
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r.state = 'RECONCILING' AND s.status = 'UNKNOWN'
      AND s.permit_until + interval '15 minutes' <= statement_timestamp()
      THEN CASE WHEN receipt.action_id IS NULL THEN 'DEFINITELY_NOT_SENT' ELSE 'CONFIRMED' END
    END AS outcome
  ) proof
  WHERE (a.character_id, a.id) = (target_character, target_action) AND r.mode = 'SIMULATION'
$fn$;

CREATE FUNCTION public.rica_resolve_simulation(
  target_character uuid, target_action uuid, expected_version int, expected_outcome text,
  evidence_ref text, actor text, rationale text
) RETURNS TABLE (version int, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  facts record;
  final_state public."RunState";
BEGIN
  PERFORM 1 FROM public.characters c WHERE c.id = target_character FOR UPDATE;
  SELECT * INTO facts FROM public.rica_simulation_reconciliation(target_character, target_action);
  IF NOT FOUND OR facts.version <> expected_version OR facts.outcome IS NULL
    OR facts.outcome IS DISTINCT FROM expected_outcome OR facts."evidenceRef" IS DISTINCT FROM evidence_ref THEN
    RETURN;
  END IF;

  final_state := (CASE WHEN facts.outcome = 'CONFIRMED' THEN 'SIMULATED' ELSE 'BLOCKED' END)::public."RunState";
  UPDATE public.simulation_attempts s SET
    status = CASE WHEN facts.outcome = 'CONFIRMED' THEN 'CONFIRMED' ELSE 'NOT_SENT' END::public."SimulationAttemptStatus",
    resolved_by = actor, resolution_reason = rationale, resolution_evidence = evidence_ref
  WHERE (s.character_id, s.action_id) = (target_character, target_action) AND s.status = 'UNKNOWN';
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY UPDATE public.agent_runs r
    SET state = final_state, state_version = r.state_version + 1
    FROM public.action_proposals a
    WHERE (a.character_id, a.id) = (target_character, target_action)
      AND (r.character_id, r.id, r.state_version) = (a.character_id, a.run_id, expected_version)
      AND r.state = 'RECONCILING'
    RETURNING r.state_version, r.state::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Simulation changed while resolving'; END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_simulation_reconciliation(uuid, uuid),
  public.rica_resolve_simulation(uuid, uuid, int, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_reconciliation(uuid, uuid),
  public.rica_resolve_simulation(uuid, uuid, int, text, text, text, text) TO rica_admin_api;
COMMIT;
