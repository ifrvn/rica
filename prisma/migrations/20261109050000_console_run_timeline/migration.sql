BEGIN;

CREATE OR REPLACE FUNCTION public.rica_replay_run_with_time(target_character uuid, target_run uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  WITH replay AS MATERIALIZED (
    SELECT public.rica_replay_simulation_run(target_character,target_run) AS view,
      r.context_timezone, r.goal_refs, r.references_expired_at, d.belief_refs, a.adapter_id, a.adapter_contract_version,
      e.kind, e.received_at, d.created_at AS draft_at, d.model_id, d.model_version,
      a.created_at AS proposed_at, approval.created_at AS reviewed_at, attempt.created_at AS permitted_at
    FROM public.agent_runs r
    JOIN public.inbound_events e ON (e.character_id, e.identity_id, e.account_id, e.id)
      = (r.character_id, r.identity_id, r.account_id, r.inbound_event_id)
    LEFT JOIN public.simulated_drafts d ON (d.character_id,d.run_id) = (r.character_id,r.id)
    LEFT JOIN public.action_proposals a ON (a.character_id,a.run_id) = (r.character_id,r.id)
    LEFT JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (a.character_id, a.id)
    LEFT JOIN public.simulation_attempts attempt ON (attempt.character_id, attempt.action_id) = (a.character_id, a.id)
    WHERE (r.character_id,r.id) = (target_character,target_run)
  )
  SELECT view
    || jsonb_build_object('contextTimezone',context_timezone,'goalRefs',goal_refs,
      'referencesExpiredAt',references_expired_at,'beliefRefs',COALESCE(belief_refs,'[]'::jsonb),
      'inbound',jsonb_build_object('kind',kind,'receivedAt',received_at),
      'draft',CASE WHEN draft_at IS NOT NULL THEN
        jsonb_build_object('createdAt',draft_at,'modelId',model_id,'modelVersion',model_version) END)
    || CASE WHEN references_expired_at IS NOT NULL THEN jsonb_build_object('schedule',NULL) ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(view->'proposal') = 'object' THEN jsonb_build_object('proposal',view->'proposal'
      || jsonb_build_object('adapterId',adapter_id,'adapterContractVersion',adapter_contract_version,
        'createdAt',proposed_at,'reviewedAt',reviewed_at,'permittedAt',permitted_at)) ELSE '{}'::jsonb END
  FROM replay
$$;

COMMIT;
