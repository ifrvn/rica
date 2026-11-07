BEGIN;
ALTER TABLE public.contacts ADD COLUMN no_contact_at timestamptz,
  ADD COLUMN boundary_changed_at timestamptz,
  ADD COLUMN boundary_version int NOT NULL DEFAULT 0,
  ADD COLUMN boundary_reason text;

CREATE FUNCTION public.rica_capture_contact_opt_out() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NEW.message_text IS NOT NULL
    AND lower(btrim(regexp_replace(btrim(NEW.message_text), '[.!。！]+$', ''))) IN
      ('stop','unsubscribe','do not contact me','不要联系我','请不要联系我','停止联系我','別再聯絡我','不要聯絡我') THEN
    UPDATE public.contacts p SET no_contact_at = clock_timestamp(), boundary_changed_at = clock_timestamp(),
      boundary_version = boundary_version+1, boundary_reason = 'INBOUND_OPT_OUT'
    WHERE (p.character_id,p.identity_id,p.account_id,p.id)
      = (NEW.character_id,NEW.identity_id,NEW.account_id,NEW.contact_id)
      AND p.no_contact_at IS NULL;
    IF FOUND THEN
      INSERT INTO public.audit_log (character_id,actor_id,operation,target_id,request_id,digest)
      VALUES (NEW.character_id,'platform-contact','contact.opt_out',NEW.contact_id,NEW.id,
        encode(sha256(convert_to(NEW.id::text || ':contact.opt_out','UTF8')),'hex'));
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_capture_contact_opt_out() FROM PUBLIC;
CREATE TRIGGER capture_contact_opt_out AFTER INSERT ON public.inbound_events
  FOR EACH ROW EXECUTE FUNCTION public.rica_capture_contact_opt_out();

CREATE FUNCTION public.rica_read_contact_boundary(target_character uuid,target_contact uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object('id',p.id,'accountId',p.account_id,'version',p.boundary_version,
    'blocked',p.no_contact_at IS NOT NULL,'changedAt',p.boundary_changed_at,'reason',p.boundary_reason)
  FROM public.contacts p WHERE (p.character_id,p.id) = (target_character,target_contact)
$fn$;

CREATE FUNCTION public.rica_change_contact_boundary(target_character uuid,target_contact uuid,expected int,
  blocked boolean,rationale text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  current_version int;
  current_blocked boolean;
  changed_at timestamptz;
BEGIN
  PERFORM id FROM public.characters WHERE id = target_character FOR UPDATE;
  SELECT p.boundary_version,p.no_contact_at IS NOT NULL INTO current_version,current_blocked
  FROM public.contacts p WHERE (p.character_id,p.id) = (target_character,target_contact) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF current_version <> expected THEN RETURN 'STALE'; END IF;
  IF current_blocked = blocked THEN RETURN 'UNCHANGED'; END IF;
  changed_at := clock_timestamp();
  UPDATE public.contacts SET no_contact_at = CASE WHEN blocked THEN changed_at END,
    boundary_changed_at = changed_at, boundary_version = boundary_version+1, boundary_reason = rationale
  WHERE (character_id,id) = (target_character,target_contact);
  RETURN 'UPDATED';
END
$fn$;
REVOKE ALL ON FUNCTION public.rica_read_contact_boundary(uuid,uuid),
  public.rica_change_contact_boundary(uuid,uuid,int,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_read_contact_boundary(uuid,uuid),
  public.rica_change_contact_boundary(uuid,uuid,int,boolean,text) TO rica_admin_api;
CREATE OR REPLACE FUNCTION public.rica_simulated_review_target(target_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'platform', a.platform, 'instance', a.instance_key, 'accountId', a.id,
    'account', a.remote_account_id, 'identity', i.slug, 'identityId', i.id,
    'conversationId', t.id, 'conversation', t.remote_key, 'audience', t.channel,
    'contactId', p.id, 'contact', p.remote_key, 'message', e.source_key
  )
  FROM public.agent_runs r
  JOIN public.characters c ON c.id = r.character_id
  JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
  JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
  JOIN public.inbound_events e ON e.id = r.inbound_event_id
  JOIN public.conversations t ON (t.character_id, t.identity_id, t.account_id, t.id)
    = (r.character_id, r.identity_id, r.account_id, e.conversation_id)
  LEFT JOIN public.contacts p ON (p.character_id, p.identity_id, p.account_id, p.id)
    = (r.character_id, r.identity_id, r.account_id, e.contact_id)
  WHERE r.id = target_run AND r.mode = 'SIMULATION'
    AND a.platform IN ('mock-a', 'mock-b') AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
    AND (r.core_version, r.identity_version, r.binding_version, r.auth_epoch)
      = (c.active_core_version, i.active_version, a.binding_version, c.auth_epoch)
    AND (t.channel = 'PUBLIC' OR t.private_contact_id = p.id)
    AND p.no_contact_at IS NULL
    AND (p.boundary_changed_at IS NULL OR p.boundary_changed_at <= r.created_at)
$fn$;
CREATE OR REPLACE FUNCTION public.rica_record_simulation_receipt(target_action uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  PERFORM 1 FROM public.characters c
  JOIN public.simulation_attempts s ON s.character_id = c.id
  WHERE s.action_id = target_action FOR SHARE OF c;

  -- Serialize the final local side effect with a concurrent inbound opt-out.
  PERFORM p.id FROM public.contacts p
  JOIN public.simulation_attempts s
    ON (p.character_id,p.account_id,p.id) = (s.character_id,s.account_id,s.contact_id)
  WHERE s.action_id = target_action FOR SHARE OF p;

  INSERT INTO public.simulation_receipts (character_id, action_id)
  SELECT s.character_id, s.action_id
  FROM public.simulation_attempts s
  JOIN public.action_proposals a ON (a.character_id, a.id) = (s.character_id, s.action_id)
  JOIN public.agent_runs r ON (r.character_id, r.id) = (a.character_id, a.run_id)
  WHERE s.action_id = target_action AND s.status = 'PERMITTED' AND s.permit_until > clock_timestamp()
    AND r.mode = 'SIMULATION' AND r.state::text = 'EXECUTING'
    AND a.target = public.rica_simulated_review_target(r.id)
  FOR SHARE OF s
  ON CONFLICT (action_id) DO NOTHING;

  RETURN EXISTS (SELECT 1 FROM public.simulation_receipts WHERE action_id = target_action);
END
$fn$;

COMMIT;
