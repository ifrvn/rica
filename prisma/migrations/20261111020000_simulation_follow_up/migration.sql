BEGIN;

ALTER TABLE public.action_proposals ADD COLUMN follow_up jsonb;
ALTER TABLE public.simulation_commitments ADD COLUMN source text NOT NULL DEFAULT 'MANUAL'
  CHECK (source IN ('MANUAL', 'AI'));

CREATE FUNCTION public.rica_register_simulation_follow_up() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  reviewed record;
  follow_kind text;
  follow_title text;
  follow_task text;
  due_text text;
  deadline timestamptz;
  registered_id uuid := gen_random_uuid();
  conversation uuid;
  schedule uuid;
BEGIN
  SELECT proposal.id AS action_id, proposal.follow_up, proposal.review_digest,
    scope."accountId" AS account_id, scope."identityId" AS identity_id,
    scope."conversationId" AS conversation_id, scope."contactId" AS contact_id, scope.zone,
    draft.content
  INTO reviewed
  FROM public.action_proposals proposal
  JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (proposal.character_id, proposal.id)
  JOIN public.simulated_drafts draft ON (draft.character_id, draft.run_id) = (proposal.character_id, proposal.run_id)
  CROSS JOIN LATERAL public.rica_confirmed_commitment_scope(proposal.character_id, proposal.id) scope
  JOIN public.conversations audience ON (audience.character_id, audience.identity_id, audience.account_id, audience.id)
    = (proposal.character_id, scope."identityId", scope."accountId", scope."conversationId")
  WHERE (proposal.character_id, proposal.run_id) = (NEW.character_id, NEW.id)
    AND approval.review_digest = proposal.review_digest AND approval.decision = 'APPROVE'
    AND audience.channel = 'PUBLIC' AND proposal.follow_up IS NOT NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;

  follow_kind := reviewed.follow_up->>'kind';
  follow_title := btrim(reviewed.follow_up->>'title');
  follow_task := btrim(reviewed.follow_up->>'task');
  due_text := reviewed.follow_up->>'dueAt';
  IF NOT COALESCE(follow_kind IN ('PLAN', 'COMMITMENT')
    AND char_length(follow_title) BETWEEN 1 AND 72 AND follow_title !~ '[[:cntrl:]]'
    AND char_length(follow_task) BETWEEN 1 AND 300
    AND due_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?Z$'
    AND pg_input_is_valid(due_text, 'timestamp with time zone'), false)
    THEN RETURN NEW; END IF;
  deadline := due_text::timestamptz;
  IF deadline <= statement_timestamp() OR deadline > statement_timestamp() + interval '168 hours'
    THEN RETURN NEW; END IF;

  IF follow_kind = 'PLAN' THEN
    conversation := public.rica_create_plan_conversation(NEW.character_id, reviewed.identity_id, reviewed.account_id);
    IF conversation IS NULL THEN RETURN NEW; END IF;
  ELSE
    IF COALESCE(position(follow_task IN reviewed.content), 0) = 0
      OR EXISTS (SELECT 1 FROM public.simulation_commitments
        WHERE (character_id, action_id) = (NEW.character_id, reviewed.action_id))
      THEN RETURN NEW; END IF;
    conversation := reviewed.conversation_id;
  END IF;

  INSERT INTO public.simulation_schedules
    (character_id, identity_id, account_id, conversation_id, contact_id, schedule_key, zone, kind, due_at, next_at)
  VALUES (NEW.character_id, reviewed.identity_id, reviewed.account_id, conversation,
    CASE WHEN follow_kind = 'COMMITMENT' THEN reviewed.contact_id END,
    lower(follow_kind) || ':' || registered_id, reviewed.zone, 'REMINDER', deadline, deadline)
  RETURNING id INTO schedule;

  IF follow_kind = 'PLAN' THEN
    INSERT INTO public.simulation_plans (id, character_id, title, zone, kind, due_at, source)
    VALUES (registered_id, NEW.character_id, follow_title, reviewed.zone, 'REMINDER', deadline, 'AI');
    INSERT INTO public.simulation_plan_participants (plan_id, character_id, identity_id, account_id, schedule_id, task)
    VALUES (registered_id, NEW.character_id, reviewed.identity_id, reviewed.account_id, schedule, follow_task);
  ELSE
    INSERT INTO public.simulation_commitments (id, character_id, action_id, schedule_id, title, task, due_at, source)
    VALUES (registered_id, NEW.character_id, reviewed.action_id, schedule, follow_title, follow_task, deadline, 'AI');
    INSERT INTO public.commitment_revisions (commitment_id, character_id, version, state, due_at, reason, actor_id)
    VALUES (registered_id, NEW.character_id, 1, 'OPEN', deadline, '已确认的模拟回复包含该承诺。', 'system:simulation-follow-up');
  END IF;
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  VALUES (NEW.character_id, 'system:simulation-follow-up', lower(follow_kind) || '.register_from_receipt',
    registered_id, reviewed.action_id, reviewed.review_digest);
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_register_simulation_follow_up() FROM PUBLIC;
CREATE TRIGGER register_simulation_follow_up AFTER UPDATE OF state ON public.agent_runs
FOR EACH ROW WHEN (OLD.state IN ('EXECUTING', 'RECONCILING') AND NEW.state = 'SIMULATED' AND NEW.mode = 'SIMULATION')
EXECUTE FUNCTION public.rica_register_simulation_follow_up();

COMMIT;
