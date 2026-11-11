BEGIN;

CREATE FUNCTION public.rica_follow_up_accounts(target_run uuid)
RETURNS TABLE ("identityId" uuid, "accountId" uuid, identity text, account text, platform text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH scoped AS MATERIALIZED (
    SELECT r.character_id, r.identity_id, public.rica_simulated_review_target(r.id) AS target
    FROM public.agent_runs r WHERE r.id = target_run AND r.state = 'CONTEXT_READY'
  ), candidates AS (
    SELECT i.id AS identity_id, a.id AS account_id, i.slug AS identity, a.remote_account_id AS account, a.platform,
      count(*) OVER (PARTITION BY a.platform) AS eligible
    FROM scoped s
    JOIN public.platform_accounts a ON a.character_id = s.character_id AND a.identity_id <> s.identity_id
    JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
    WHERE s.target->>'audience' = 'PUBLIC' AND a.status = 'ACTIVE' AND i.status = 'ACTIVE'
      AND a.platform IN ('mock-a', 'mock-b', 'newbi')
  )
  SELECT identity_id, account_id, identity, account, platform FROM candidates WHERE eligible = 1 ORDER BY platform
$fn$;

REVOKE ALL ON FUNCTION public.rica_follow_up_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_follow_up_accounts(uuid) TO rica_runtime;

CREATE OR REPLACE FUNCTION public.rica_register_simulation_follow_up() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  reviewed record;
  follow_kind text;
  follow_title text;
  follow_task text;
  due_text text;
  daily_at text;
  deadline timestamptz;
  next_slot timestamptz;
  timing public."ScheduleKind" := 'REMINDER';
  partners jsonb;
  participant record;
  registered_id uuid := gen_random_uuid();
  conversation uuid;
  schedule uuid;
BEGIN
  SELECT proposal.id AS action_id, proposal.follow_up, proposal.review_digest,
    scope."accountId" AS account_id, scope."identityId" AS identity_id,
    scope."conversationId" AS conversation_id, scope."contactId" AS contact_id,
    draft.content
  INTO reviewed
  FROM public.action_proposals proposal
  JOIN public.action_approvals approval ON (approval.character_id, approval.action_id) = (proposal.character_id, proposal.id)
  JOIN public.simulated_drafts draft ON (draft.character_id, draft.run_id) = (proposal.character_id, proposal.run_id)
  CROSS JOIN LATERAL public.rica_confirmed_commitment_scope(proposal.character_id, proposal.id) scope
  JOIN public.conversations audience ON (audience.character_id, audience.identity_id, audience.account_id, audience.id)
    = (proposal.character_id, scope."identityId", scope."accountId", scope."conversationId")
  JOIN public.platform_accounts owner_account ON (owner_account.character_id, owner_account.identity_id, owner_account.id)
    = (proposal.character_id, scope."identityId", scope."accountId")
  JOIN public.identities owner_identity ON (owner_identity.character_id, owner_identity.id) = (proposal.character_id, scope."identityId")
  WHERE (proposal.character_id, proposal.run_id) = (NEW.character_id, NEW.id)
    AND approval.review_digest = proposal.review_digest AND approval.decision = 'APPROVE'
    AND audience.channel = 'PUBLIC' AND proposal.follow_up IS NOT NULL
    AND owner_account.status = 'ACTIVE' AND owner_identity.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN NEW; END IF;

  follow_kind := reviewed.follow_up->>'kind';
  follow_title := btrim(reviewed.follow_up->>'title');
  follow_task := btrim(reviewed.follow_up->>'task');
  due_text := reviewed.follow_up->>'dueAt';
  daily_at := reviewed.follow_up->>'dailyAt';
  partners := COALESCE(reviewed.follow_up->'participants', '[]'::jsonb);
  IF NOT COALESCE(follow_kind IN ('PLAN', 'COMMITMENT')
    AND char_length(follow_title) BETWEEN 1 AND 72 AND follow_title !~ '[[:cntrl:]]'
    AND char_length(follow_task) BETWEEN 1 AND 300 AND jsonb_typeof(partners) = 'array', false)
    THEN RETURN NEW; END IF;
  IF jsonb_array_length(partners) > 2 OR (
    SELECT count(DISTINCT i.id)
    FROM jsonb_array_elements(partners) AS p(item)
    JOIN public.platform_accounts a ON a.character_id = NEW.character_id
      AND a.id::text = p.item->>'accountId' AND a.platform = p.item->>'platform'
    JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id) AND i.id::text = p.item->>'identityId'
    WHERE a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND i.id <> reviewed.identity_id
      AND a.platform IN ('mock-a', 'mock-b', 'newbi')
      AND (follow_kind = 'COMMITMENT' OR char_length(btrim(p.item->>'task')) BETWEEN 1 AND 300)
  ) <> jsonb_array_length(partners) THEN RETURN NEW; END IF;

  IF daily_at IS NOT NULL THEN
    IF follow_kind <> 'PLAN' OR due_text IS NOT NULL OR daily_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR (reviewed.follow_up->>'zone') IS DISTINCT FROM NEW.context_timezone
      THEN RETURN NEW; END IF;
    timing := 'DAILY';
    next_slot := public.rica_daily_schedule_slot(NEW.context_timezone, daily_at::time, statement_timestamp(), false);
  ELSE
    IF NOT COALESCE(due_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?Z$'
      AND pg_input_is_valid(due_text, 'timestamp with time zone'), false) THEN RETURN NEW; END IF;
    deadline := due_text::timestamptz;
    IF deadline <= statement_timestamp() OR deadline > statement_timestamp() + interval '168 hours'
      THEN RETURN NEW; END IF;
    next_slot := deadline;
  END IF;

  IF follow_kind = 'PLAN' THEN
    INSERT INTO public.simulation_plans (id, character_id, title, zone, kind, local_time, due_at, source)
    VALUES (registered_id, NEW.character_id, follow_title, NEW.context_timezone, timing, daily_at, deadline, 'AI');
    FOR participant IN
      SELECT reviewed.identity_id AS identity_id, reviewed.account_id AS account_id,
        proposal_platform.platform, follow_task AS task
      FROM public.platform_accounts proposal_platform WHERE proposal_platform.id = reviewed.account_id
      UNION ALL
      SELECT (item->>'identityId')::uuid, (item->>'accountId')::uuid, item->>'platform', btrim(item->>'task')
      FROM jsonb_array_elements(partners) AS p(item)
    LOOP
      schedule := NULL;
      IF participant.platform IN ('mock-a', 'mock-b') THEN
        conversation := public.rica_create_plan_conversation(NEW.character_id, participant.identity_id, participant.account_id);
        INSERT INTO public.simulation_schedules
          (character_id, identity_id, account_id, conversation_id, schedule_key, zone, kind, local_time, due_at, next_at)
        VALUES (NEW.character_id, participant.identity_id, participant.account_id, conversation,
          'plan:' || gen_random_uuid(), NEW.context_timezone, timing, daily_at, deadline, next_slot)
        RETURNING id INTO schedule;
      END IF;
      INSERT INTO public.simulation_plan_participants (plan_id, character_id, identity_id, account_id, schedule_id, task)
      VALUES (registered_id, NEW.character_id, participant.identity_id, participant.account_id, schedule, participant.task);
    END LOOP;
  ELSE
    IF COALESCE(position(follow_task IN reviewed.content), 0) = 0
      OR EXISTS (SELECT 1 FROM public.simulation_commitments
        WHERE (character_id, action_id) = (NEW.character_id, reviewed.action_id))
      THEN RETURN NEW; END IF;
    INSERT INTO public.simulation_schedules
      (character_id, identity_id, account_id, conversation_id, contact_id, schedule_key, zone, kind, due_at, next_at)
    VALUES (NEW.character_id, reviewed.identity_id, reviewed.account_id, reviewed.conversation_id,
      reviewed.contact_id, 'commitment:' || registered_id, NEW.context_timezone, 'REMINDER', deadline, next_slot)
    RETURNING id INTO schedule;
    INSERT INTO public.simulation_commitments (id, character_id, action_id, schedule_id, title, task, due_at, source)
    VALUES (registered_id, NEW.character_id, reviewed.action_id, schedule, follow_title, follow_task, deadline, 'AI');
    INSERT INTO public.commitment_revisions (commitment_id, character_id, version, state, due_at, reason, actor_id)
    VALUES (registered_id, NEW.character_id, 1, 'OPEN', deadline, '已确认的模拟回复包含该承诺。', 'system:simulation-follow-up');
    INSERT INTO public.commitment_collaborators (commitment_id, character_id, identity_id, account_id)
    SELECT registered_id, NEW.character_id, (item->>'identityId')::uuid, (item->>'accountId')::uuid
    FROM jsonb_array_elements(partners) AS p(item);
  END IF;
  INSERT INTO public.audit_log (character_id, actor_id, operation, target_id, request_id, digest)
  VALUES (NEW.character_id, 'system:simulation-follow-up', lower(follow_kind) || '.register_from_receipt',
    registered_id, reviewed.action_id, reviewed.review_digest);
  RETURN NEW;
END
$fn$;

COMMIT;
