BEGIN;

ALTER TABLE public.identity_state_revisions ADD COLUMN rule_configuration jsonb;

CREATE TABLE public.daily_energy_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  utc_day date NOT NULL,
  energy text NOT NULL CHECK (energy IN ('LOW','NORMAL','HIGH')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (character_id,utc_day)
);
ALTER TABLE public.daily_energy_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_energy_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY daily_energy_owner ON public.daily_energy_projections TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE FUNCTION public.rica_approve_daily_energy(target_character uuid,target_day date,target_energy text,
  operator text,rationale text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  projection_id uuid;
BEGIN
  IF target_day <= (statement_timestamp() AT TIME ZONE 'UTC')::date THEN RETURN 'DAY_NOT_FUTURE'; END IF;
  INSERT INTO public.daily_energy_projections (character_id,utc_day,energy,actor_id,reason)
  VALUES (target_character,target_day,target_energy,operator,rationale)
  ON CONFLICT (character_id,utc_day) DO NOTHING RETURNING id INTO projection_id;
  RETURN COALESCE(projection_id::text,'DAY_EXISTS');
END
$fn$;

CREATE FUNCTION public.rica_read_daily_energy(target_character uuid,target_day date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',id,'utcDay',utc_day,'energy',energy,'approvedAt',approved_at)
  FROM public.daily_energy_projections WHERE (character_id,utc_day) = (target_character,target_day)
$fn$;
REVOKE ALL ON FUNCTION public.rica_approve_daily_energy(uuid,date,text,text,text),
  public.rica_read_daily_energy(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_approve_daily_energy(uuid,date,text,text,text),
  public.rica_read_daily_energy(uuid,date) TO rica_admin_api;

CREATE FUNCTION public.rica_fold_identity_state(previous double precision[],seconds double precision,
  kind public."InboundKind",configuration jsonb)
RETURNS double precision[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT CASE WHEN configuration IS NULL THEN public.rica_identity_state_v1(previous,seconds,kind)
  ELSE (
    SELECT array_agg(greatest(CASE WHEN n = 5 THEN -1 ELSE 0 END,
      least(1, base[n] + (previous[n] - base[n])
        * power(0.5::double precision, least(64, greatest(seconds,0) / (3600 * half_life)))
        + delta)) ORDER BY n)
    FROM generate_series(1,7) AS pos(n)
    CROSS JOIN (SELECT ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[] AS base) b
    CROSS JOIN LATERAL (SELECT configuration->(CASE WHEN n <= 4 THEN 'motivationHalfLifeHours'
      ELSE 'affectHalfLifeHours' END) AS hours,
      configuration->'deltas'->kind::text->(n-1) AS step) entry
    CROSS JOIN LATERAL (
      SELECT CASE WHEN jsonb_typeof(hours) = 'number'
        THEN greatest(1,least(168,(hours #>> '{}')::numeric))::double precision
        ELSE CASE WHEN n <= 4 THEN 24 ELSE 8 END END AS half_life,
        CASE WHEN jsonb_typeof(step) = 'number'
          THEN greatest(-0.15,least(0.15,(step #>> '{}')::numeric))::double precision ELSE 0 END AS delta
    ) config
  ) END
$fn$;
REVOKE ALL ON FUNCTION public.rica_fold_identity_state(double precision[],double precision,public."InboundKind",jsonb)
  FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.rica_record_identity_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  event public.inbound_events%ROWTYPE;
  latest public.identity_state_revisions%ROWTYPE;
  checkpoint public.identity_state_revisions%ROWTYPE;
  item record;
  effective timestamptz;
  through_time timestamptz;
  through_id uuid;
  state double precision[];
  next_revision int;
  configuration jsonb;
BEGIN
  IF NEW.mode <> 'SIMULATION' THEN RETURN NEW; END IF;
  SELECT e.* INTO event FROM public.inbound_events e WHERE e.id = NEW.inbound_event_id
    AND e.adapter_id IS NOT NULL AND e.source_key NOT LIKE 'schedule:%';
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rica_lock_simulated_binding(NEW.account_id) b
    WHERE (b."characterId",b."identityId",b."accountId",b."coreVersion",b."identityVersion",b."bindingVersion",b."authEpoch")
      = (NEW.character_id,NEW.identity_id,NEW.account_id,NEW.core_version,NEW.identity_version,NEW.binding_version,NEW.auth_epoch)
  ) THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rica.identity-state:' || NEW.identity_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.identity_state_revisions WHERE event_id = event.id) THEN RETURN NEW; END IF;
  SELECT * INTO latest FROM public.identity_state_revisions
  WHERE (character_id,identity_id) = (NEW.character_id,NEW.identity_id)
  ORDER BY revision DESC LIMIT 1;
  SELECT v.role_profile->'stateRule' INTO configuration
  FROM public.identity_versions v
  WHERE (v.character_id,v.identity_id,v.version) = (NEW.character_id,NEW.identity_id,NEW.identity_version);
  IF jsonb_typeof(configuration) IS DISTINCT FROM 'object' THEN configuration := NULL; END IF;
  next_revision := COALESCE(latest.revision,0) + 1;
  effective := least(event.occurred_at,event.received_at);
  state := ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[];

  IF latest.revision IS NULL OR (effective,event.id) > (latest.through_at,latest.through_event_id) THEN
    state := public.rica_fold_identity_state(COALESCE(latest.state_vector,state),
      extract(epoch FROM effective - COALESCE(latest.through_at,effective))::double precision, event.kind, configuration);
    through_time := effective;
    through_id := event.id;
  ELSE
    -- A checkpoint predating the late event is valid only if it includes every earlier input.
    SELECT cp.* INTO checkpoint FROM public.identity_state_revisions cp
    WHERE (cp.character_id,cp.identity_id) = (NEW.character_id,NEW.identity_id)
      AND (cp.through_at,cp.through_event_id) < (effective,event.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.identity_state_revisions added
        WHERE (added.character_id,added.identity_id) = (cp.character_id,cp.identity_id)
          AND added.revision > cp.revision
          AND (added.effective_at,added.event_id) <= (cp.through_at,cp.through_event_id)
      )
    ORDER BY cp.revision DESC LIMIT 1;
    IF FOUND THEN
      state := checkpoint.state_vector;
      through_time := checkpoint.through_at;
      through_id := checkpoint.through_event_id;
    END IF;
    FOR item IN
      SELECT effective_at,event_id,event_kind,rule_configuration FROM public.identity_state_revisions
      WHERE (character_id,identity_id) = (NEW.character_id,NEW.identity_id)
        AND (checkpoint.revision IS NULL OR (effective_at,event_id) > (checkpoint.through_at,checkpoint.through_event_id))
      UNION ALL SELECT effective,event.id,event.kind,configuration
      ORDER BY effective_at,event_id
    LOOP
      state := public.rica_fold_identity_state(state,
        extract(epoch FROM item.effective_at - COALESCE(through_time,item.effective_at))::double precision,
        item.event_kind,item.rule_configuration);
      through_time := item.effective_at;
      through_id := item.event_id;
    END LOOP;
  END IF;

  INSERT INTO public.identity_state_revisions (character_id,identity_id,revision,run_id,event_id,event_kind,
    effective_at,through_at,through_event_id,state_vector,rule_version,actor_id,rule_configuration)
  VALUES (NEW.character_id,NEW.identity_id,next_revision,NEW.id,event.id,event.kind,
    effective,through_time,through_id,state,1,'simulation-worker',configuration);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rica_run_identity_state(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('revision',s.revision,'ruleVersion',COALESCE(s.rule_version,1),
    'configurationVersion',CASE WHEN s.rule_configuration IS NOT NULL THEN r.identity_version END,
    'sharedEnergy',COALESCE(d.energy,'NORMAL'),
    'motivation',jsonb_build_object('exploration',v.x[1],'expression',v.x[2],'social',v.x[3],'rest',v.x[4]),
    'affect',jsonb_build_object('pleasure',v.x[5],'arousal',v.x[6],'energy',v.x[7]))
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (r.character_id,r.identity_id,r.account_id)
  LEFT JOIN public.identity_state_revisions s ON s.run_id = r.id
  LEFT JOIN public.identity_state_revisions through_event ON through_event.event_id = s.through_event_id
  LEFT JOIN public.daily_energy_projections d ON (d.character_id,d.utc_day)
    = (r.character_id,(r.created_at AT TIME ZONE 'UTC')::date)
  CROSS JOIN LATERAL (
    SELECT public.rica_fold_identity_state(COALESCE(s.state_vector, ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[]),
      extract(epoch FROM r.created_at - COALESCE(s.through_at,r.created_at))::double precision, NULL, through_event.rule_configuration) AS x
  ) v
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND c.status = 'ACTIVE' AND i.status = 'ACTIVE' AND a.status = 'ACTIVE'
    AND (r.core_version,r.identity_version,r.binding_version,r.auth_epoch)
      = (c.active_core_version,i.active_version,a.binding_version,c.auth_epoch)
$fn$;

COMMIT;
