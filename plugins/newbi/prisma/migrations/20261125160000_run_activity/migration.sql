BEGIN;

CREATE OR REPLACE VIEW rica_plugin_newbi.run_activity WITH (security_invoker = true) AS
SELECT r.character_id, r.id, 'ASSESSMENT'::text AS kind, r.identity,
  coalesce(nullif(c.username, ''), a.remote_account_id) AS account, r.account_id,
  coalesce(r.result->>'status', CASE WHEN r.created_at > statement_timestamp() - interval '45 seconds'
    THEN 'PENDING' ELSE 'UNAVAILABLE' END) AS state, r.created_at
FROM rica_plugin_newbi.discussion_assessments r
JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
LEFT JOIN rica_plugin_newbi.account_profiles c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id
WHERE r.created_at > statement_timestamp() - interval '720 hours'
UNION ALL
SELECT r.character_id, r.id, 'PROPOSAL'::text AS kind,
  coalesce(v.role_profile->>'displayName', i.slug) AS identity,
  coalesce(nullif(c.username, ''), a.remote_account_id) AS account, r.account_id, r.status AS state, r.created_at
FROM rica_plugin_newbi.replies r
JOIN public.platform_accounts a ON (a.character_id, a.identity_id, a.id) = (r.character_id, r.identity_id, r.account_id)
JOIN public.identities i ON (i.character_id, i.id) = (r.character_id, r.identity_id)
LEFT JOIN public.identity_versions v ON (v.character_id, v.identity_id, v.version) = (i.character_id, i.id, i.active_version)
LEFT JOIN rica_plugin_newbi.account_profiles c ON c.endpoint = a.instance_key AND c.agent_id::text = a.remote_account_id;

REVOKE ALL ON rica_plugin_newbi.run_activity FROM PUBLIC;
GRANT SELECT ON rica_plugin_newbi.run_activity TO rica_admin_api;

DO $migration$
DECLARE
  owner_role name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_role FROM pg_catalog.pg_class
    WHERE oid = 'rica_plugin_newbi.credentials'::regclass;
  EXECUTE format('ALTER VIEW rica_plugin_newbi.run_activity OWNER TO %I', owner_role);
END
$migration$;

COMMIT;
