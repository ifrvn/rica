BEGIN;

CREATE TABLE public.platform_account_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL,
  platform text NOT NULL,
  instance_key text NOT NULL,
  remote_account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  bound_at timestamptz,
  CONSTRAINT platform_account_registrations_character_id_fkey
    FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX account_registration_platform_key
  ON public.platform_account_registrations (platform, instance_key, remote_account_id);
CREATE INDEX account_registration_character_idx
  ON public.platform_account_registrations (character_id, bound_at, created_at, id);

GRANT SELECT, INSERT ON public.platform_account_registrations TO rica_admin_api;
GRANT UPDATE (bound_at) ON public.platform_account_registrations TO rica_admin_api;

COMMIT;
