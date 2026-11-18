CREATE FUNCTION public.rica_simulation_review_context(target_character uuid, target_action uuid)
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
      = (e.character_id, e.identity_id, e.account_id, e.contact_id)
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
    = (o.character_id, o.identity_id, o.account_id, o.contact_id)
$$;

REVOKE ALL ON FUNCTION public.rica_simulation_review_context(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_simulation_review_context(uuid, uuid) TO rica_admin_api;
