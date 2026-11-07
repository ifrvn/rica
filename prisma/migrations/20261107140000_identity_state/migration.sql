BEGIN;

CREATE TABLE public.identity_state_revisions (
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  revision int NOT NULL CHECK (revision > 0),
  run_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  event_kind public."InboundKind" NOT NULL,
  effective_at timestamptz NOT NULL,
  through_at timestamptz NOT NULL,
  through_event_id uuid NOT NULL,
  state_vector double precision[] NOT NULL CHECK (cardinality(state_vector) = 7),
  rule_version int NOT NULL CHECK (rule_version = 1),
  actor_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (character_id, identity_id, revision),
  FOREIGN KEY (character_id, run_id) REFERENCES public.agent_runs(character_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX identity_state_event_order_idx ON public.identity_state_revisions
  (character_id, identity_id, effective_at, event_id);
ALTER TABLE public.identity_state_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_state_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_state_owner ON public.identity_state_revisions TO CURRENT_USER
  USING (true) WITH CHECK (true);

-- Exploration, expression, social, rest, pleasure, arousal, energy.
CREATE FUNCTION public.rica_identity_state_v1(previous double precision[], seconds double precision,
  kind public."InboundKind")
RETURNS double precision[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT array_agg(greatest(CASE WHEN n = 5 THEN -1 ELSE 0 END,
    least(1, baseline[n] + (previous[n] - baseline[n])
      * power(0.5::double precision, least(64, greatest(seconds, 0) / CASE WHEN n <= 4 THEN 86400 ELSE 28800 END))
      + delta[n])) ORDER BY n)
  FROM generate_series(1, 7) AS position(n)
  CROSS JOIN (SELECT ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[] AS baseline,
    CASE kind
      WHEN 'POST' THEN ARRAY[0.08,0.03,0,0,0.01,0.03,-0.01]
      WHEN 'MENTION' THEN ARRAY[0.03,0.04,0.06,0.02,0.02,0.07,-0.02]
      WHEN 'REPLY' THEN ARRAY[0.01,-0.03,-0.07,0.03,0.04,0.04,-0.03]
      ELSE ARRAY[0,0,0,0,0,0,0]
    END::double precision[] AS delta) AS rule
$fn$;
REVOKE ALL ON FUNCTION public.rica_identity_state_v1(double precision[],double precision,public."InboundKind") FROM PUBLIC;

CREATE FUNCTION public.rica_record_identity_state() RETURNS trigger
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
  next_revision := COALESCE(latest.revision,0) + 1;
  effective := least(event.occurred_at,event.received_at);
  state := ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[];

  IF latest.revision IS NULL OR (effective,event.id) > (latest.through_at,latest.through_event_id) THEN
    state := public.rica_identity_state_v1(COALESCE(latest.state_vector,state),
      extract(epoch FROM effective - COALESCE(latest.through_at,effective))::double precision, event.kind);
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
      SELECT effective_at,event_id,event_kind FROM public.identity_state_revisions
      WHERE (character_id,identity_id) = (NEW.character_id,NEW.identity_id)
        AND (checkpoint.revision IS NULL OR (effective_at,event_id) > (checkpoint.through_at,checkpoint.through_event_id))
      UNION ALL SELECT effective,event.id,event.kind
      ORDER BY effective_at,event_id
    LOOP
      state := public.rica_identity_state_v1(state,
        extract(epoch FROM item.effective_at - COALESCE(through_time,item.effective_at))::double precision,
        item.event_kind);
      through_time := item.effective_at;
      through_id := item.event_id;
    END LOOP;
  END IF;

  INSERT INTO public.identity_state_revisions (character_id,identity_id,revision,run_id,event_id,event_kind,
    effective_at,through_at,through_event_id,state_vector,rule_version,actor_id)
  VALUES (NEW.character_id,NEW.identity_id,next_revision,NEW.id,event.id,event.kind,
    effective,through_time,through_id,state,1,'simulation-worker');
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_record_identity_state() FROM PUBLIC;
CREATE TRIGGER record_identity_state AFTER UPDATE OF state ON public.agent_runs
  FOR EACH ROW WHEN (OLD.state = 'QUEUED' AND NEW.state = 'CONTEXT_READY')
  EXECUTE FUNCTION public.rica_record_identity_state();

CREATE FUNCTION public.rica_run_identity_state(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('revision',s.revision,'ruleVersion',COALESCE(s.rule_version,1),
    'motivation',jsonb_build_object('exploration',v.x[1],'expression',v.x[2],'social',v.x[3],'rest',v.x[4]),
    'affect',jsonb_build_object('pleasure',v.x[5],'arousal',v.x[6],'energy',v.x[7]))
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (r.character_id,r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (r.character_id,r.identity_id,r.account_id)
  LEFT JOIN public.identity_state_revisions s ON s.run_id = r.id
  CROSS JOIN LATERAL (
    SELECT public.rica_identity_state_v1(COALESCE(s.state_vector, ARRAY[0.5,0.5,0.5,0.5,0,0.5,0.7]::double precision[]),
      extract(epoch FROM r.created_at - COALESCE(s.through_at,r.created_at))::double precision, NULL) AS x
  ) v
  WHERE r.id = target_run AND r.mode = 'SIMULATION' AND r.state = 'CONTEXT_READY'
    AND c.status = 'ACTIVE' AND i.status = 'ACTIVE' AND a.status = 'ACTIVE'
    AND (r.core_version,r.identity_version,r.binding_version,r.auth_epoch)
      = (c.active_core_version,i.active_version,a.binding_version,c.auth_epoch)
$fn$;
REVOKE ALL ON FUNCTION public.rica_run_identity_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_run_identity_state(uuid) TO rica_runtime;

COMMIT;
