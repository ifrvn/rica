BEGIN;

CREATE OR REPLACE FUNCTION rica_plugin_newbi.sweep_retention() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  replies_changed integer;
  events_removed integer;
  assessments_removed integer;
BEGIN
  UPDATE rica_plugin_newbi.replies SET content = NULL, review_prompt = NULL WHERE id IN (
    SELECT id FROM rica_plugin_newbi.replies
    WHERE (content IS NOT NULL OR review_prompt IS NOT NULL)
      AND created_at <= statement_timestamp() - interval '720 hours'
      AND expires_at <= statement_timestamp()
    ORDER BY created_at, id LIMIT 50 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS replies_changed = ROW_COUNT;

  DELETE FROM rica_plugin_newbi.events WHERE (account_id, seq) IN (
    SELECT account_id, seq FROM rica_plugin_newbi.events
    WHERE occurred_at <= statement_timestamp() - interval '720 hours'
    ORDER BY occurred_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS events_removed = ROW_COUNT;

  DELETE FROM rica_plugin_newbi.discussion_assessments WHERE id IN (
    SELECT id FROM rica_plugin_newbi.discussion_assessments
    WHERE created_at <= statement_timestamp() - interval '30 days'
    ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS assessments_removed = ROW_COUNT;

  RETURN replies_changed + events_removed + assessments_removed;
END
$function$;

COMMIT;
