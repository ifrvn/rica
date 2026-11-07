BEGIN;

CREATE TABLE public.identity_reflections (
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  utc_day date NOT NULL,
  core_version int NOT NULL,
  identity_version int NOT NULL,
  fictional_profile boolean NOT NULL,
  observed_receipts int NOT NULL CHECK (observed_receipts >= 0),
  unverified_events int NOT NULL CHECK (unverified_events >= 0),
  candidate_belief_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id,identity_id,utc_day),
  FOREIGN KEY (character_id,identity_id) REFERENCES public.identities(character_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE FUNCTION public.rica_due_reflections(after_identity uuid)
RETURNS TABLE (id uuid, "characterId" uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT i.id,i.character_id
  FROM public.identities i JOIN public.characters c ON c.id = i.character_id
  WHERE (after_identity IS NULL OR i.id > after_identity)
    AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM public.identity_reflections r
      WHERE (r.character_id,r.identity_id,r.utc_day) = (i.character_id,i.id,(statement_timestamp() AT TIME ZONE 'UTC')::date - 1)
    )
  ORDER BY i.id LIMIT 16
$fn$;

CREATE FUNCTION public.rica_reflect_identity(target_character uuid,target_identity uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  day date := (statement_timestamp() AT TIME ZONE 'UTC')::date - 1;
  start_at timestamptz := day::timestamp AT TIME ZONE 'UTC';
  end_at timestamptz := (day+1)::timestamp AT TIME ZONE 'UTC';
  profile record;
  observed int;
  unverified int;
  candidate uuid;
  citation record;
BEGIN
  -- Keep scope, evidence and any resulting versions consistent with management commands and revocation.
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  SELECT c.active_core_version,i.active_version,COALESCE(core.hard_profile ? 'fictionalBackground',false) AS fictional
  INTO profile
  FROM public.identities i JOIN public.characters c ON c.id = i.character_id
  JOIN public.core_versions core ON (core.character_id,core.version) = (c.id,c.active_core_version)
  WHERE (i.character_id,i.id) = (target_character,target_identity) AND i.status = 'ACTIVE' AND c.status = 'ACTIVE';
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.identity_reflections r WHERE (r.character_id,r.identity_id,r.utc_day) = (target_character,target_identity,day)
  ) THEN RETURN false; END IF;

  SELECT count(*) INTO observed
  FROM public.agent_runs r
  JOIN public.action_proposals a ON (a.character_id,a.run_id) = (r.character_id,r.id)
  JOIN public.simulation_attempts s ON (s.character_id,s.action_id) = (a.character_id,a.id) AND s.status = 'CONFIRMED'
  JOIN public.simulation_receipts receipt ON (receipt.character_id,receipt.action_id) = (s.character_id,s.action_id)
  WHERE (r.character_id,r.identity_id) = (target_character,target_identity) AND r.mode = 'SIMULATION'
    AND receipt.created_at >= start_at AND receipt.created_at < end_at;
  SELECT count(*) INTO unverified FROM public.inbound_events e
  WHERE (e.character_id,e.identity_id) = (target_character,target_identity) AND e.message_text IS NOT NULL
    AND e.received_at >= start_at AND e.received_at < end_at;

  SELECT m.id,m.revision,source.id AS source_id INTO citation
  FROM public.memories m
  CROSS JOIN LATERAL (SELECT public.rica_belief_source(m.character_id,m.identity_id,m.id,m.revision) AS id) source
  WHERE (m.character_id,m.identity_id) = (target_character,target_identity)
    AND m.scope = 'IDENTITY' AND m.status = 'ACTIVE' AND m.created_at >= start_at AND m.created_at < end_at
    AND source.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.belief_evidence e JOIN public.belief_versions v USING (character_id,identity_id,belief_id,version)
      WHERE (e.character_id,e.identity_id,e.source_id) = (target_character,target_identity,source.id)
        AND v.actor_id = 'system:reflection'
    )
  ORDER BY m.created_at DESC,m.id LIMIT 1;
  IF FOUND THEN
    candidate := gen_random_uuid();
    INSERT INTO public.belief_versions (character_id,identity_id,belief_id,version,kind,statement,status,confidence,reason,actor_id)
    VALUES (target_character,target_identity,candidate,1,'PREFERENCE','我可能愿意进一步了解这段经历。','PENDING',0.55,
      '每日反思选出一条身份内有效经历，待复核。','system:reflection');
    INSERT INTO public.belief_evidence (character_id,identity_id,belief_id,version,source_id,memory_id,memory_revision,direction,weight)
    VALUES (target_character,target_identity,candidate,1,citation.source_id,citation.id,citation.revision,'SUPPORT',0.5);
  END IF;

  INSERT INTO public.identity_reflections (character_id,identity_id,utc_day,core_version,identity_version,fictional_profile,
    observed_receipts,unverified_events,candidate_belief_id)
  VALUES (target_character,target_identity,day,profile.active_core_version,profile.active_version,profile.fictional,
    observed,unverified,candidate);
  RETURN true;
END
$fn$;

CREATE FUNCTION public.rica_read_identity_reflection(target_character uuid,target_identity uuid,day date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('identityId',r.identity_id,'utcDay',r.utc_day,'coreVersion',r.core_version,
    'identityVersion',r.identity_version,'createdAt',r.created_at,'candidateBeliefId',r.candidate_belief_id,
    'fictionalProfile',jsonb_build_object('kind','FICTIONAL_PROFILE','present',r.fictional_profile),
    'observedActivity',jsonb_build_object('kind','OBSERVED_ACTIVITY','simulatedReceipts',r.observed_receipts),
    'unverifiedExternal',jsonb_build_object('kind','UNVERIFIED_EXTERNAL','inboundMessages',r.unverified_events))
  FROM public.identity_reflections r
  WHERE (r.character_id,r.identity_id,r.utc_day) = (target_character,target_identity,day)
$fn$;

REVOKE ALL ON FUNCTION public.rica_due_reflections(uuid),public.rica_reflect_identity(uuid,uuid),
  public.rica_read_identity_reflection(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_due_reflections(uuid),public.rica_reflect_identity(uuid,uuid) TO rica_runtime;
GRANT EXECUTE ON FUNCTION public.rica_read_identity_reflection(uuid,uuid,date) TO rica_admin_api;

COMMIT;
