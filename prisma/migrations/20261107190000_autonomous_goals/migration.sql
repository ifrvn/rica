BEGIN;

ALTER TABLE public.goal_versions
  ADD COLUMN origin text NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN topic text,
  ADD COLUMN reflection_day date,
  ADD CONSTRAINT goal_origin_scope CHECK (
    (origin = 'ADMIN' AND topic IS NULL AND reflection_day IS NULL)
    OR (origin = 'SELF' AND topic IS NOT DISTINCT FROM 'REVIEW_INTERACTIONS' AND reflection_day IS NOT NULL)
  ),
  ADD FOREIGN KEY (character_id,identity_id,reflection_day)
    REFERENCES public.identity_reflections(character_id,identity_id,utc_day) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX goal_versions_character_id_identity_id_reflection_day_idx
  ON public.goal_versions(character_id,identity_id,reflection_day);

CREATE OR REPLACE VIEW public.rica_current_goals AS
  SELECT DISTINCT ON (character_id,identity_id,goal_id) *
  FROM public.goal_versions ORDER BY character_id,identity_id,goal_id,version DESC;

CREATE OR REPLACE FUNCTION public.rica_goal_json(g public.goal_versions)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',g.goal_id,'identityId',g.identity_id,'version',g.version,'origin',g.origin,
    'topic',g.topic,'reflectionDay',g.reflection_day,
    'title',g.title,'status',CASE WHEN g.due_at <= statement_timestamp() AND g.status IN ('DRAFT','ACTIVE','PAUSED')
      THEN 'EXPIRED' ELSE g.status END,
    'priority',g.priority,'budget',g.budget,'dueAt',g.due_at,'nextStep',g.next_step,'createdAt',g.created_at)
$fn$;

CREATE FUNCTION public.rica_plan_reflection_goal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  policy jsonb;
  days int;
  budget_limit int;
BEGIN
  IF NEW.observed_receipts = 0 THEN RETURN NEW; END IF;
  SELECT v.role_profile->'autonomousGoal' INTO policy FROM public.identity_versions v
    WHERE (v.character_id,v.identity_id,v.version) = (NEW.character_id,NEW.identity_id,NEW.identity_version);
  IF policy->>'topic' IS DISTINCT FROM 'REVIEW_INTERACTIONS' THEN RETURN NEW; END IF;
  days := (policy->>'maxDays')::int;
  budget_limit := (policy->>'budget')::int;
  IF NOT COALESCE(days BETWEEN 1 AND 7 AND budget_limit BETWEEN 1 AND 100,false) THEN RETURN NEW; END IF;

  -- Reflection and manual goal updates hold the same character lock.
  IF (SELECT count(*) FROM public.rica_current_goals g
    WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.identity_id)
      AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()) >= 3
    OR EXISTS (SELECT 1 FROM public.rica_current_goals g
      WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.identity_id)
        AND g.origin = 'SELF' AND g.topic = 'REVIEW_INTERACTIONS'
        AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp())
    THEN RETURN NEW; END IF;

  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id,created_at,origin,topic,reflection_day)
  VALUES (NEW.character_id,NEW.identity_id,gen_random_uuid(),1,'复盘近期互动','ACTIVE',30,budget_limit,
    statement_timestamp() + make_interval(hours => days * 24),'整理上一日已确认互动中的一个改进点。',
    '每日反思记录了已确认的模拟互动。','system:reflection',statement_timestamp(),'SELF','REVIEW_INTERACTIONS',NEW.utc_day);
  RETURN NEW;
END
$fn$;

CREATE FUNCTION public.rica_cancel_out_of_policy_goals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  policy jsonb;
BEGIN
  SELECT v.role_profile->'autonomousGoal' INTO policy FROM public.identity_versions v
    WHERE (v.character_id,v.identity_id,v.version) = (NEW.character_id,NEW.id,NEW.active_version);
  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id,origin,topic,reflection_day)
  SELECT g.character_id,g.identity_id,g.goal_id,g.version+1,g.title,'CANCELED',g.priority,g.budget,
    g.due_at,g.next_step,'身份许可已撤回或收紧。','system:identity-policy',g.origin,g.topic,g.reflection_day
  FROM public.rica_current_goals g
  WHERE (g.character_id,g.identity_id) = (NEW.character_id,NEW.id)
    AND g.origin = 'SELF' AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()
    AND NOT COALESCE(g.topic = policy->>'topic' AND g.budget <= (policy->>'budget')::int
      AND g.due_at-g.created_at <= make_interval(hours => (policy->>'maxDays')::int * 24),false);
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_plan_reflection_goal(),public.rica_cancel_out_of_policy_goals() FROM PUBLIC;
CREATE TRIGGER plan_reflection_goal AFTER INSERT ON public.identity_reflections
  FOR EACH ROW EXECUTE FUNCTION public.rica_plan_reflection_goal();
CREATE TRIGGER cancel_out_of_policy_goals AFTER UPDATE OF active_version ON public.identities
  FOR EACH ROW WHEN (OLD.active_version IS DISTINCT FROM NEW.active_version)
  EXECUTE FUNCTION public.rica_cancel_out_of_policy_goals();

CREATE OR REPLACE FUNCTION public.rica_write_manual_goal(target_character uuid,target_identity uuid,target_goal uuid,expected int,
  configuration jsonb,operator text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  previous public.rica_current_goals%ROWTYPE;
  next_status text := configuration->>'status';
  deadline timestamptz := (configuration->>'dueAt')::timestamptz;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.identities WHERE (character_id,id) = (target_character,target_identity))
    THEN RETURN 'MISSING'; END IF;
  SELECT * INTO previous FROM public.rica_current_goals
  WHERE (character_id,identity_id,goal_id) = (target_character,target_identity,target_goal);
  IF expected > 0 AND NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF COALESCE(previous.version,0) <> expected THEN RETURN 'STALE'; END IF;
  IF previous.origin = 'SELF' THEN
    IF next_status <> 'CANCELED' THEN RETURN 'SELF_MANAGED'; END IF;
    configuration := configuration || jsonb_build_object('title',previous.title,'priority',previous.priority,
      'budget',previous.budget,'nextStep',previous.next_step);
    deadline := previous.due_at;
  END IF;
  IF previous.status IN ('DONE','CANCELED','EXPIRED')
    OR previous.due_at <= statement_timestamp()
    OR deadline <= statement_timestamp() THEN RETURN 'CLOSED'; END IF;

  IF next_status = 'ACTIVE' AND (SELECT count(*) FROM public.rica_current_goals g
    WHERE (g.character_id,g.identity_id) = (target_character,target_identity)
      AND g.goal_id <> target_goal AND g.status = 'ACTIVE' AND g.due_at > statement_timestamp()) >= 3
    THEN RETURN 'LIMIT'; END IF;

  INSERT INTO public.goal_versions (character_id,identity_id,goal_id,version,title,status,priority,budget,
    due_at,next_step,reason,actor_id,origin,topic,reflection_day)
  VALUES (target_character,target_identity,target_goal,expected+1,configuration->>'title',next_status,
    (configuration->>'priority')::int,(configuration->>'budget')::int,deadline,
    configuration->>'nextStep',configuration->>'reason',operator,COALESCE(previous.origin,'ADMIN'),previous.topic,previous.reflection_day);
  UPDATE public.characters SET auth_epoch = auth_epoch+1 WHERE id = target_character;
  RETURN 'UPDATED';
END
$fn$;

COMMIT;
