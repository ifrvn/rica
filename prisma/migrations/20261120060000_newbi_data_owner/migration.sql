BEGIN;

DO $migration$
DECLARE
  owner_role name;
  previous_owner name;
  relation_name name;
  tables name[] := ARRAY['credentials', 'events', 'event_checkpoints', 'discussion_assessments',
    'author_terms', 'section_glossary_samples', 'replies'];
BEGIN
  -- PostgreSQL roles are cluster-wide. Scope this owner to the database's OID.
  SELECT 'rica_newbi_ddl_' || oid::text INTO STRICT owner_role
    FROM pg_catalog.pg_database WHERE datname = current_database();
  EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', owner_role);
  EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', owner_role, current_user);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA rica_plugin_newbi TO %I', owner_role);

  FOREACH relation_name IN ARRAY tables
  LOOP
    SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT previous_owner
    FROM pg_catalog.pg_class WHERE relnamespace = 'rica_plugin_newbi'::regnamespace AND relname = relation_name;
    EXECUTE format('ALTER TABLE rica_plugin_newbi.%I OWNER TO %I', relation_name, owner_role);
    -- Existing definer functions can be owned by a former table owner.
    IF previous_owner <> current_user THEN
      EXECUTE format('GRANT ALL ON TABLE rica_plugin_newbi.%I TO %I WITH GRANT OPTION', relation_name, previous_owner);
    END IF;
  END LOOP;
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT previous_owner FROM pg_catalog.pg_class
    WHERE oid = 'rica_plugin_newbi.account_profiles'::regclass;
  EXECUTE format('ALTER VIEW rica_plugin_newbi.account_profiles OWNER TO %I', owner_role);
  IF previous_owner <> current_user THEN
    EXECUTE format('GRANT ALL ON TABLE rica_plugin_newbi.account_profiles TO %I WITH GRANT OPTION', previous_owner);
  END IF;
END
$migration$;

COMMIT;
