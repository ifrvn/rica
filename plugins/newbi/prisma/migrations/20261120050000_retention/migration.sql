BEGIN;

CREATE FUNCTION rica_plugin_newbi.sweep_retention() RETURNS integer
LANGUAGE sql SECURITY INVOKER SET search_path TO 'pg_catalog', 'pg_temp' AS $$
  SELECT public.rica_sweep_newbi_retention()
    + public.rica_sweep_newbi_events()
    + public.rica_sweep_newbi_assessments()
$$;
REVOKE ALL ON FUNCTION rica_plugin_newbi.sweep_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rica_plugin_newbi.sweep_retention() TO rica_runtime;

COMMIT;
