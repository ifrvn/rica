BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rica_plugin_event_api') THEN
    CREATE ROLE rica_plugin_event_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rica_plugin_event_api'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Unexpected privileges on Rica plugin event role';
  END IF;
END
$roles$;
GRANT rica_plugin_event_api TO rica_runtime WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public TO rica_plugin_event_api;

CREATE TABLE public.plugin_activity_events (
  sequence bigint NOT NULL CHECK (sequence > 0),
  plugin_id varchar(50) NOT NULL,
  event_id uuid NOT NULL,
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  account_id uuid NOT NULL,
  binding_version integer NOT NULL CHECK (binding_version > 0),
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ASSESSMENT', 'PROPOSAL')),
  state varchar(64) NOT NULL CHECK (state ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT plugin_activity_events_pkey PRIMARY KEY (account_id, binding_version, sequence),
  CONSTRAINT plugin_activity_events_plugin_event_key UNIQUE (plugin_id, event_id),
  CONSTRAINT plugin_activity_events_account_fkey FOREIGN KEY (character_id, identity_id, account_id)
    REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE CASCADE
);
CREATE INDEX plugin_activity_events_character_idx ON public.plugin_activity_events(character_id, occurred_at DESC, event_id DESC);
GRANT SELECT ON public.plugin_activity_events TO rica_admin_api;

CREATE FUNCTION public.rica_publish_plugin_activity_v1(
  source_plugin text, source_event uuid, target_character uuid, target_account uuid, target_version integer,
  event_time timestamptz, activity_kind text, activity_state text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  bound_identity uuid;
BEGIN
  -- Account controls take the same character lock. Offsets for an account are assigned in commit order.
  PERFORM c.id FROM public.characters c JOIN public.platform_accounts a ON a.character_id = c.id
  WHERE c.id = target_character AND a.id = target_account FOR UPDATE OF c;

  SELECT a.identity_id INTO bound_identity
  FROM public.platform_accounts a
  JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
  WHERE (a.character_id, a.id, a.binding_version) = (target_character, target_account, target_version)
    AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN 'UNAVAILABLE'; END IF;
  IF event_time > statement_timestamp() + interval '5 minutes' THEN RETURN 'INVALID_TIME'; END IF;

  INSERT INTO public.plugin_activity_events(sequence, plugin_id, event_id, character_id, identity_id, account_id,
    binding_version, occurred_at, kind, state)
  SELECT coalesce(max(e.sequence), 0) + 1, source_plugin, source_event, target_character, bound_identity,
    target_account, target_version, event_time, activity_kind, activity_state
  FROM public.plugin_activity_events e WHERE e.account_id = target_account AND e.binding_version = target_version
  ON CONFLICT (plugin_id, event_id) DO NOTHING;
  IF FOUND THEN RETURN 'CREATED'; END IF;

  IF EXISTS (
    SELECT FROM public.plugin_activity_events e WHERE (e.plugin_id, e.event_id) = (source_plugin, source_event)
      AND (e.character_id, e.identity_id, e.account_id, e.binding_version, e.occurred_at, e.kind, e.state)
        = (target_character, bound_identity, target_account, target_version, event_time, activity_kind, activity_state)
  ) THEN RETURN 'REPLAYED'; END IF;
  RETURN 'CONFLICT';
END
$function$;

CREATE FUNCTION public.rica_read_plugin_activity_v1(
  target_account uuid, target_version integer, after_sequence bigint, sources text[], page_size integer
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE WHEN EXISTS (
    SELECT FROM public.platform_accounts a
    JOIN public.characters c ON c.id = a.character_id
    JOIN public.identities i ON (i.character_id, i.id) = (a.character_id, a.identity_id)
    WHERE a.id = target_account AND a.binding_version = target_version
      AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
  ) THEN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'offset', e.sequence::text, 'pluginId', e.plugin_id, 'id', e.event_id,
      'type', 'activity.recorded.v1', 'characterId', e.character_id, 'bindingVersion', e.binding_version,
      'occurredAt', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'payload', jsonb_build_object('kind', e.kind, 'state', e.state)
    ) ORDER BY e.sequence), '[]'::jsonb)
    FROM (
      SELECT * FROM public.plugin_activity_events
      WHERE account_id = target_account AND binding_version = target_version
        AND sequence > after_sequence AND plugin_id = ANY (sources)
      ORDER BY sequence LIMIT greatest(1, least(page_size, 100))
    ) e
  ) END;
$function$;

REVOKE ALL ON FUNCTION public.rica_publish_plugin_activity_v1(text, uuid, uuid, uuid, integer, timestamptz, text, text),
  public.rica_read_plugin_activity_v1(uuid, integer, bigint, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_publish_plugin_activity_v1(text, uuid, uuid, uuid, integer, timestamptz, text, text),
  public.rica_read_plugin_activity_v1(uuid, integer, bigint, text[], integer) TO rica_plugin_event_api;

COMMIT;
