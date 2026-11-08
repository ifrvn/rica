BEGIN;

CREATE TABLE public.admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(64) NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash varchar(128) NOT NULL,
  actor_id varchar(64) NOT NULL UNIQUE CHECK (actor_id ~ '^[0-9a-f]{64}$'),
  can_create boolean NOT NULL DEFAULT false,
  auth_version int NOT NULL DEFAULT 1 CHECK (auth_version > 0)
);

CREATE TABLE public.admin_passkeys (
  id varchar(1024) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter BETWEEN 0 AND 4294967295)
);
CREATE INDEX admin_passkeys_user_id_idx ON public.admin_passkeys(user_id);

GRANT SELECT ON public.admin_users,public.admin_passkeys TO rica_admin_api;
GRANT INSERT, UPDATE (counter) ON public.admin_passkeys TO rica_admin_api;

COMMIT;
