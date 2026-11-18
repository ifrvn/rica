ALTER TABLE public.action_proposals ADD COLUMN auto_review_until timestamptz;
ALTER TABLE public.inbound_events ADD COLUMN console_speaker_id uuid,
  ADD CONSTRAINT inbound_console_speaker_binding FOREIGN KEY (character_id,identity_id,account_id,console_speaker_id)
    REFERENCES public.contacts(character_id,identity_id,account_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT inbound_console_speaker_is_separate CHECK (console_speaker_id IS NULL OR contact_id IS NULL);

CREATE FUNCTION public.rica_start_console_chat_message(
  target_character uuid, target_account uuid, target_chat uuid, adapter text, adapter_version text,
  speaker text, body text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
DECLARE
  binding record;
  participant uuid;
  participant_key text := 'console-member:' || target_chat || ':' || encode(sha256(convert_to(speaker,'UTF8')), 'hex');
  event_id uuid;
  run_id uuid;
  sent_at timestamptz;
BEGIN
  IF body IS NULL OR speaker IS NULL OR char_length(btrim(body)) NOT BETWEEN 1 AND 4000 OR char_length(btrim(speaker)) NOT BETWEEN 1 AND 40
    OR NULLIF(adapter_version,'') IS NULL OR adapter NOT IN ('mock-a', 'mock-b') THEN RETURN NULL; END IF;
  SELECT * INTO binding FROM public.rica_lock_simulated_binding(target_account);
  IF NOT FOUND OR binding."characterId" <> target_character OR NOT EXISTS (
    SELECT FROM public.platform_accounts WHERE id = target_account AND platform = adapter
  ) THEN RETURN NULL; END IF;
  INSERT INTO public.conversations (id, character_id, identity_id, account_id, remote_key, channel)
  VALUES (target_chat, target_character, binding."identityId", target_account, 'console-chat:' || target_chat, 'PUBLIC')
  ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (
    SELECT FROM public.conversations c WHERE (c.character_id,c.identity_id,c.account_id,c.id,c.remote_key,c.channel)
    = (target_character,binding."identityId",target_account,target_chat,'console-chat:' || target_chat,'PUBLIC'::public."ConversationChannel")
  ) THEN RETURN NULL; END IF;

  INSERT INTO public.contacts (character_id,identity_id,account_id,remote_key,display_label)
  VALUES (target_character,binding."identityId",target_account,participant_key,speaker)
  ON CONFLICT (account_id,remote_key) DO NOTHING;
  SELECT id INTO participant FROM public.contacts
  WHERE (character_id,identity_id,account_id,remote_key) = (target_character,binding."identityId",target_account,participant_key)
    AND no_contact_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  sent_at := clock_timestamp();
  INSERT INTO public.inbound_events (character_id,identity_id,account_id,conversation_id,console_speaker_id,source_key,
    message_text,adapter_id,adapter_version,kind,occurred_at,received_at)
  VALUES (target_character,binding."identityId",target_account,target_chat,participant,'console-turn:' || gen_random_uuid(),
    body,adapter,adapter_version,'REPLY',sent_at,sent_at) RETURNING id INTO event_id;
  INSERT INTO public.agent_runs (character_id,identity_id,account_id,inbound_event_id,core_version,
    identity_version,binding_version,auth_epoch,created_at)
  VALUES (target_character,binding."identityId",target_account,event_id,binding."coreVersion",
    binding."identityVersion",binding."bindingVersion",binding."authEpoch",sent_at) RETURNING id INTO run_id;
  INSERT INTO public.outbox (event_id,type,run_id) VALUES (gen_random_uuid(),'RunQueued.v1',run_id);
  RETURN run_id;
END
$$;

CREATE FUNCTION public.rica_console_simulation_chats(target_character uuid, target_account uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at) ORDER BY created_at DESC,id DESC),'[]'::jsonb)
  FROM (
    SELECT id,created_at FROM public.conversations
    WHERE (character_id,account_id) = (target_character,target_account) AND remote_key = 'console-chat:' || id
    ORDER BY created_at DESC,id DESC LIMIT 50
  ) c
$$;

CREATE FUNCTION public.rica_console_chat_turns(target_character uuid, target_chat uuid, before_at timestamptz, page_size integer)
RETURNS TABLE(run_id uuid, state text, speaker text, message text, sent_at timestamptz, reply text, replied_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH latest AS MATERIALIZED (
    SELECT e.message_text,e.received_at,r.id,r.state,p.display_label AS speaker
    FROM public.conversations c
    JOIN public.inbound_events e ON (e.character_id,e.identity_id,e.account_id,e.conversation_id)
      = (c.character_id,c.identity_id,c.account_id,c.id)
    JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id,p.id)
      = (e.character_id,e.identity_id,e.account_id,e.console_speaker_id)
    JOIN public.agent_runs r ON (r.character_id,r.identity_id,r.account_id,r.inbound_event_id)
      = (e.character_id,e.identity_id,e.account_id,e.id)
    WHERE (c.character_id,c.id) = (target_character,target_chat)
      AND c.channel = 'PUBLIC' AND c.remote_key = 'console-chat:' || c.id
      AND e.source_key LIKE 'console-turn:%' AND p.remote_key LIKE 'console-member:' || c.id || ':%'
      AND p.no_contact_at IS NULL AND r.mode = 'SIMULATION'
      AND (before_at IS NULL OR e.received_at < before_at)
    ORDER BY e.received_at DESC,r.id DESC LIMIT greatest(1,least(100,page_size))
  )
  SELECT t.id,t.state::text,t.speaker,
    CASE WHEN t.received_at > statement_timestamp() - interval '720 hours' THEN t.message_text END,t.received_at,
    CASE WHEN receipt.created_at IS NOT NULL THEN public.rica_validate_simulation_payload(target_character,a.id,'REPLAY') END,
    receipt.created_at
  FROM latest t
  LEFT JOIN public.action_proposals a ON (a.character_id,a.run_id) = (target_character,t.id)
  LEFT JOIN public.simulation_receipts receipt ON (receipt.character_id,receipt.action_id) = (target_character,a.id)
    AND (before_at IS NULL OR receipt.created_at < before_at)
  ORDER BY t.received_at,t.id
$$;

CREATE FUNCTION public.rica_console_simulation_chat(target_character uuid, target_chat uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT jsonb_build_object('id',c.id,'accountId',c.account_id,
    'speakers',coalesce((SELECT jsonb_agg(p.display_label ORDER BY p.created_at,p.id) FROM public.contacts p
      WHERE (p.character_id,p.identity_id,p.account_id) = (c.character_id,c.identity_id,c.account_id)
        AND p.remote_key LIKE 'console-member:' || c.id || ':%' AND p.no_contact_at IS NULL),'[]'::jsonb),
    'turns',coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.run_id,'state',t.state,'speaker',t.speaker,
      'message',t.message,'sentAt',t.sent_at,'reply',t.reply,'repliedAt',t.replied_at) ORDER BY t.sent_at,t.run_id)
      FROM public.rica_console_chat_turns(c.character_id,c.id,NULL,40) t),'[]'::jsonb))
  FROM public.conversations c WHERE (c.character_id,c.id) = (target_character,target_chat)
    AND c.remote_key = 'console-chat:' || c.id AND c.channel = 'PUBLIC'
$$;

CREATE FUNCTION public.rica_console_chat_writing(target_run uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT jsonb_build_object('speaker',p.display_label,'history',coalesce(history.messages,'[]'::jsonb))
  FROM public.agent_runs r
  JOIN public.inbound_events e ON (e.character_id,e.identity_id,e.account_id,e.id)
    = (r.character_id,r.identity_id,r.account_id,r.inbound_event_id)
  JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id)
    = (e.character_id,e.identity_id,e.account_id,e.conversation_id)
  JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id,p.id) = (e.character_id,e.identity_id,e.account_id,e.console_speaker_id)
  LEFT JOIN LATERAL (
    WITH turns AS MATERIALIZED (
      SELECT * FROM public.rica_console_chat_turns(c.character_id,c.id,e.received_at,8)
    )
    SELECT jsonb_agg(jsonb_build_object('speaker',s.speaker,'message',left(s.body,300)) ORDER BY s.sent_at,s.run_id,s.speaker) AS messages
    FROM (
      SELECT t.run_id,t.speaker,t.sent_at,t.message AS body FROM turns t
      UNION ALL
      SELECT t.run_id,'角色',t.replied_at,t.reply FROM turns t
    ) s WHERE s.body IS NOT NULL
  ) history ON true
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND c.channel = 'PUBLIC'
    AND c.remote_key = 'console-chat:' || c.id AND e.source_key LIKE 'console-turn:%'
    AND p.remote_key LIKE 'console-member:' || c.id || ':%' AND p.no_contact_at IS NULL
    AND public.rica_simulated_review_target(r.id) IS NOT NULL
$$;

CREATE FUNCTION public.rica_console_chat_for_run(target_character uuid, target_run uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT c.id FROM public.agent_runs r JOIN public.inbound_events e ON e.id = r.inbound_event_id
  JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id)
    = (r.character_id,r.identity_id,r.account_id,e.conversation_id)
  WHERE (r.character_id,r.id) = (target_character,target_run) AND c.remote_key = 'console-chat:' || c.id
    AND e.console_speaker_id IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.rica_start_console_chat_message(uuid,uuid,uuid,text,text,text,text),
  public.rica_console_simulation_chats(uuid,uuid), public.rica_console_simulation_chat(uuid,uuid),
  public.rica_console_chat_turns(uuid,uuid,timestamptz,integer), public.rica_console_chat_writing(uuid),
  public.rica_console_chat_for_run(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_start_console_chat_message(uuid,uuid,uuid,text,text,text,text),
  public.rica_console_simulation_chats(uuid,uuid), public.rica_console_simulation_chat(uuid,uuid),
  public.rica_console_chat_for_run(uuid,uuid) TO rica_admin_api;
GRANT EXECUTE ON FUNCTION public.rica_console_chat_writing(uuid) TO rica_runtime;

-- Resolve synthetic senders in the approval preview as well as in the chat.
CREATE OR REPLACE FUNCTION public.rica_simulation_review_context(target_character uuid, target_action uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  WITH origin AS MATERIALIZED (
    SELECT e.*, c.channel, r.created_at AS run_created_at
    FROM public.action_proposals a
    JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
    JOIN public.inbound_events e ON (e.character_id, e.identity_id, e.account_id, e.id)
      = (r.character_id, r.identity_id, r.account_id, r.inbound_event_id)
    JOIN public.conversations c ON (c.character_id, c.identity_id, c.account_id, c.id)
      = (e.character_id, e.identity_id, e.account_id, e.conversation_id)
    WHERE (a.character_id, a.id) = (target_character, target_action)
      AND public.rica_review_payload(a.character_id, a.id) IS NOT NULL
  ), recent AS (
    SELECT e.id, e.kind, e.occurred_at, e.message_text, coalesce(p.display_label, p.remote_key) AS sender
    FROM origin o
    JOIN public.inbound_events e ON (e.character_id, e.identity_id, e.account_id, e.conversation_id)
      = (o.character_id, o.identity_id, o.account_id, o.conversation_id)
    LEFT JOIN public.contacts p ON (p.character_id, p.identity_id, p.account_id, p.id)
      = (e.character_id, e.identity_id, e.account_id, coalesce(e.contact_id, e.console_speaker_id))
    WHERE (o.channel = 'PUBLIC' OR e.contact_id = o.contact_id)
      AND e.id <> o.id AND e.received_at <= o.run_created_at AND e.occurred_at <= o.occurred_at
      AND e.received_at > statement_timestamp() - interval '720 hours'
      AND e.message_text IS NOT NULL AND p.no_contact_at IS NULL
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT 12
  )
  SELECT jsonb_build_object(
    'trigger', jsonb_build_object('id', o.id, 'kind', o.kind, 'occurredAt', o.occurred_at,
      'sender', coalesce(p.display_label, p.remote_key),
      'content', CASE WHEN o.received_at > statement_timestamp() - interval '720 hours' THEN o.message_text END),
    'previous', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'occurredAt', e.occurred_at, 'sender', e.sender, 'content', e.message_text
    ) ORDER BY e.occurred_at, e.id) FROM recent e), '[]'::jsonb)
  )
  FROM origin o
  LEFT JOIN public.contacts p ON (p.character_id, p.identity_id, p.account_id, p.id)
    = (o.character_id, o.identity_id, o.account_id, coalesce(o.contact_id, o.console_speaker_id))
$$;
