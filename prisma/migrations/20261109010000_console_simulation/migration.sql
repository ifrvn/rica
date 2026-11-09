BEGIN;

CREATE INDEX agent_runs_character_created_id_idx ON public.agent_runs(character_id, created_at, id);

CREATE FUNCTION public.rica_start_console_simulation(
  target_character uuid, target_account uuid, adapter text, adapter_version text, message_text text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  binding record;
  conversation uuid;
  event_id uuid;
  run_id uuid;
BEGIN
  IF message_text IS NULL OR char_length(btrim(message_text)) NOT BETWEEN 1 AND 4000
    OR adapter_version IS NULL OR adapter_version = '' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT FROM public.platform_accounts a WHERE (a.character_id, a.id, a.platform) =
      (target_character, target_account, adapter)
  ) THEN RETURN NULL; END IF;

  SELECT * INTO binding FROM public.rica_lock_simulated_binding(target_account);
  IF NOT FOUND OR binding."characterId" <> target_character THEN RETURN NULL; END IF;

  conversation := gen_random_uuid();
  INSERT INTO public.conversations (id, character_id, identity_id, account_id, remote_key, channel)
  VALUES (conversation, binding."characterId", binding."identityId", target_account, 'console:' || conversation, 'PUBLIC');
  INSERT INTO public.inbound_events (character_id, identity_id, account_id, conversation_id, source_key, message_text,
    adapter_id, adapter_version, kind, occurred_at)
  VALUES (binding."characterId", binding."identityId", target_account, conversation, 'console:' || conversation,
    message_text, adapter, adapter_version, 'POST', clock_timestamp()) RETURNING id INTO event_id;
  INSERT INTO public.agent_runs (character_id, identity_id, account_id, inbound_event_id, core_version, identity_version,
    binding_version, auth_epoch)
  VALUES (binding."characterId", binding."identityId", target_account, event_id, binding."coreVersion",
    binding."identityVersion", binding."bindingVersion", binding."authEpoch") RETURNING id INTO run_id;
  INSERT INTO public.outbox (event_id, type, run_id) VALUES (gen_random_uuid(), 'RunQueued.v1', run_id);
  RETURN run_id;
END
$fn$;

CREATE FUNCTION public.rica_console_simulation_runs(target_character uuid, after_run uuid, page_size integer)
RETURNS TABLE(id uuid, state text, "identityId" uuid, "accountId" uuid, platform text, "createdAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT r.id, r.state::text, r.identity_id, r.account_id, a.platform, r.created_at
  FROM public.agent_runs r
  JOIN public.platform_accounts a ON (a.character_id, a.id) = (r.character_id, r.account_id)
  WHERE r.character_id = target_character AND r.mode = 'SIMULATION' AND (after_run IS NULL OR
    (r.created_at, r.id) < (
      SELECT cursor_run.created_at, cursor_run.id FROM public.agent_runs cursor_run
      WHERE (cursor_run.character_id, cursor_run.id) = (target_character, after_run)
    ))
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT greatest(1, least(page_size, 101))
$fn$;

REVOKE ALL ON FUNCTION public.rica_start_console_simulation(uuid, uuid, text, text, text),
  public.rica_console_simulation_runs(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_start_console_simulation(uuid, uuid, text, text, text),
  public.rica_console_simulation_runs(uuid, uuid, integer) TO rica_admin_api;

COMMIT;
