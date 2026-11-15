BEGIN;

ALTER TABLE public.admin_passkeys ADD COLUMN created_at timestamptz(6);
ALTER TABLE public.admin_passkeys ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

CREATE FUNCTION public.rica_remove_passkey(account_id uuid, account_version integer, credential_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    account_name text;
BEGIN
    SELECT u.username INTO account_name FROM public.admin_users AS u WHERE u.id = account_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- Use the same lock as password resets and Passkey registration.
    PERFORM pg_advisory_xact_lock(hashtextextended('rica-admin-user:' || account_name, 0));
    DELETE FROM public.admin_passkeys AS p
      USING public.admin_users AS u
      WHERE p.id = credential_id AND p.user_id = account_id
        AND u.id = account_id AND u.auth_version = account_version;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.rica_remove_passkey(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_remove_passkey(uuid, integer, text) TO rica_admin_api;

COMMIT;
