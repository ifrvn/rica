BEGIN;

CREATE FUNCTION public.rica_manage_local_user(
    operator_id uuid, operator_version integer, target_username text, new_hash text, operation text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    target_id uuid;
    target_protected boolean;
BEGIN
    PERFORM 1 FROM public.admin_users AS u
      WHERE u.id = operator_id AND u.auth_version = operator_version AND u.can_create
      FOR SHARE;
    IF NOT FOUND THEN
        RETURN 'FORBIDDEN';
    END IF;
    IF target_username IS NULL OR target_username !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
       OR new_hash IS NULL OR new_hash !~ '^[0-9a-f]{32}:[0-9a-f]{64}$'
       OR operation IS NULL OR operation NOT IN ('CREATE', 'RESET') THEN
        RETURN 'INVALID_INPUT';
    END IF;

    -- Serialize changes with the CLI and Passkey registration.
    PERFORM pg_advisory_xact_lock(hashtextextended('rica-admin-user:' || target_username, 0));
    SELECT u.id, u.can_create INTO target_id, target_protected
      FROM public.admin_users AS u WHERE u.username = target_username;
    IF operation = 'CREATE' THEN
        IF target_id IS NOT NULL THEN
            RETURN 'ACCOUNT_EXISTS';
        END IF;
        INSERT INTO public.admin_users (username, password_hash, actor_id, can_create)
        VALUES (target_username, new_hash,
            encode(sha256(convert_to('["rica:local","' || target_username || '"]', 'UTF8')), 'hex'), false);
    ELSE
        IF target_id IS NULL THEN
            RETURN 'ACCOUNT_NOT_FOUND';
        END IF;
        IF target_protected THEN
            RETURN 'ACCOUNT_PROTECTED';
        END IF;
        DELETE FROM public.admin_passkeys WHERE user_id = target_id;
        UPDATE public.admin_users
          SET password_hash = new_hash, auth_version = auth_version + 1
          WHERE id = target_id;
    END IF;
    RETURN 'OK';
END;
$$;

REVOKE ALL ON FUNCTION public.rica_manage_local_user(uuid, integer, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_manage_local_user(uuid, integer, text, text, text) TO rica_admin_api;

COMMIT;
