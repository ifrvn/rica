-- The digest covers the stored payload, including each U+001E message boundary.
ALTER TABLE public.simulated_drafts ADD CONSTRAINT simulated_drafts_message_boundaries
  CHECK (content IS NULL OR (
    cardinality(string_to_array(content, chr(30))) BETWEEN 1 AND 3
    AND array_position(string_to_array(content, chr(30)), '') IS NULL
  ));

ALTER TABLE public.simulation_receipts ADD COLUMN message_count integer NOT NULL DEFAULT 1
  CHECK (message_count BETWEEN 1 AND 3);

CREATE OR REPLACE FUNCTION public.rica_record_simulation_receipt(target_action uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  PERFORM 1 FROM public.characters c
  JOIN public.simulation_attempts s ON s.character_id = c.id
  WHERE s.action_id = target_action FOR SHARE OF c;

  -- Serialize the final local side effect with a concurrent inbound opt-out.
  PERFORM p.id FROM public.contacts p
  JOIN public.simulation_attempts s
    ON (p.character_id,p.account_id,p.id) = (s.character_id,s.account_id,s.contact_id)
  WHERE s.action_id = target_action FOR SHARE OF p;

  -- Commit the whole local delivery together. Retries still converge on one action receipt.
  INSERT INTO public.simulation_receipts (character_id, action_id, message_count)
  SELECT s.character_id, s.action_id, cardinality(string_to_array(payload.body, chr(30)))
  FROM public.simulation_attempts s
  JOIN public.action_proposals a ON (a.character_id, a.id) = (s.character_id, s.action_id)
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  CROSS JOIN LATERAL (
    SELECT public.rica_bound_simulation_payload(s.character_id, s.action_id, true) AS body OFFSET 0
  ) payload
  WHERE s.action_id = target_action AND s.status = 'PERMITTED' AND s.permit_until > clock_timestamp()
    AND r.mode = 'SIMULATION' AND r.state::text = 'EXECUTING'
    AND payload.body IS NOT NULL
  FOR SHARE OF s
  ON CONFLICT (action_id) DO NOTHING;

  RETURN EXISTS (SELECT 1 FROM public.simulation_receipts WHERE action_id = target_action);
END
$$;

CREATE OR REPLACE FUNCTION public.rica_console_simulation_chat(target_character uuid, target_chat uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT jsonb_build_object('id',c.id,
    'speakers',coalesce((SELECT jsonb_agg(member.display_label ORDER BY member.joined_at,member.display_label)
      FROM (
        SELECT p.display_label,min(p.created_at) AS joined_at
        FROM public.conversations binding
        JOIN public.contacts p ON (p.character_id,p.identity_id,p.account_id)
          = (binding.character_id,binding.identity_id,binding.account_id)
        WHERE (binding.character_id,binding.simulation_chat_id) = (c.character_id,c.id)
          AND p.remote_key LIKE 'console-member:' || c.id || ':%' AND p.no_contact_at IS NULL
        GROUP BY p.display_label
      ) member),'[]'::jsonb),
    'turns',coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.run_id,'accountId',t.account_id,
      'identityId',t.identity_id,'state',t.state,'speaker',t.speaker,'message',t.message,
      'sentAt',t.sent_at,'replies',string_to_array(t.reply,chr(30)),'repliedAt',t.replied_at) ORDER BY t.sent_at,t.run_id)
      FROM public.rica_shared_console_chat_turns(c.character_id,c.id,NULL,40) t),'[]'::jsonb))
  FROM public.simulation_chats c WHERE (c.character_id,c.id) = (target_character,target_chat)
$$;

CREATE OR REPLACE FUNCTION public.rica_console_chat_writing(target_run uuid)
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
      SELECT * FROM public.rica_shared_console_chat_turns(c.character_id,c.simulation_chat_id,e.received_at,8)
    )
    SELECT jsonb_agg(jsonb_build_object('speaker',s.speaker,'message',left(s.body,300)) ORDER BY s.sent_at,s.run_id,s.position) AS messages
    FROM (
      SELECT t.run_id,t.speaker,t.sent_at,t.message AS body,0 AS position FROM turns t
      UNION ALL
      SELECT t.run_id,'角色',t.replied_at,reply.body,reply.position FROM turns t
      CROSS JOIN LATERAL unnest(string_to_array(t.reply,chr(30))) WITH ORDINALITY AS reply(body,position)
    ) s WHERE s.body IS NOT NULL
  ) history ON true
  WHERE r.id = target_run AND r.state = 'CONTEXT_READY' AND r.mode = 'SIMULATION'
    AND c.simulation_chat_id IS NOT NULL AND e.source_key LIKE 'console-turn:%'
    AND p.remote_key LIKE 'console-member:' || c.simulation_chat_id || ':%' AND p.no_contact_at IS NULL
    AND public.rica_simulated_review_target(r.id) IS NOT NULL
$$;
