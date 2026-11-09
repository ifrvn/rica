BEGIN;

GRANT SELECT (id, character_id, identity_id, account_id, display_label, created_at, boundary_version, no_contact_at)
  ON public.contacts TO rica_admin_api;
GRANT SELECT (character_id, identity_id, belief_id, version, kind) ON public.belief_versions TO rica_admin_api;

COMMIT;
