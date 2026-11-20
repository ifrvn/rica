BEGIN;

DO $migration$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_role FROM pg_catalog.pg_class
    WHERE oid = 'rica_plugin_newbi.credentials'::regclass;
  IF NOT pg_has_role(current_user, owner_role, 'SET') THEN
    RAISE EXCEPTION 'Newbi migration login must be able to assume %', owner_role;
  END IF;
  EXECUTE format('ALTER VIEW rica_plugin_newbi.run_activity OWNER TO %I', owner_role);
  EXECUTE format('ALTER FUNCTION rica_plugin_newbi.sweep_retention() OWNER TO %I', owner_role);
END
$migration$;

COMMIT;
