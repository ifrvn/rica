BEGIN;

CREATE FUNCTION public.rica_change_local_password(account_id uuid, account_version integer, new_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    account_name text;
BEGIN
    IF new_hash IS NULL OR new_hash !~ '^[0-9a-f]{32}:[0-9a-f]{64}$' THEN
        RETURN false;
    END IF;
    SELECT u.username INTO account_name FROM public.admin_users AS u WHERE u.id = account_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('rica-admin-user:' || account_name, 0));
    UPDATE public.admin_users AS u
      SET password_hash = new_hash, auth_version = auth_version + 1
      WHERE u.id = account_id AND u.auth_version = account_version;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.rica_change_local_password(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_change_local_password(uuid, integer, text) TO rica_admin_api;

COMMIT;
