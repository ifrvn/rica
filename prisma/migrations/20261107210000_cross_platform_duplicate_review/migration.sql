BEGIN;

ALTER TABLE public.action_proposals ADD COLUMN cross_platform_duplicate boolean NOT NULL DEFAULT false;
CREATE INDEX inbound_duplicate_window_idx ON public.inbound_events(character_id,identity_id,received_at,id);

CREATE FUNCTION public.rica_topic_grams(message text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT ARRAY(SELECT DISTINCT substr(text,n,3)
    FROM generate_series(1,char_length(text)-2) n WHERE char_length(text) >= 12)
  FROM (SELECT left(btrim(regexp_replace(lower(normalize(message,NFKC)),'[[:space:][:punct:]]+',' ','g')),480) AS text) s
$fn$;

CREATE FUNCTION public.rica_cross_platform_duplicate(target_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  WITH target AS MATERIALIZED (
    SELECT r.character_id,r.identity_id,e.id,e.adapter_id,e.received_at,
      public.rica_topic_grams(e.message_text) AS grams,
      (v.role_profile->'duplicateReview'->>'windowHours')::int AS hours,
      (v.role_profile->'duplicateReview'->>'similarityPercent')::int AS threshold
    FROM public.agent_runs r
    JOIN public.inbound_events e ON e.id = r.inbound_event_id
    JOIN public.identity_versions v ON (v.character_id,v.identity_id,v.version) = (r.character_id,r.identity_id,r.identity_version)
    WHERE r.id = target_run AND r.state = 'CONTEXT_READY'
      AND e.adapter_id IN ('mock-a','mock-b') AND e.message_text IS NOT NULL
      AND v.role_profile ? 'duplicateReview'
      AND public.rica_simulated_review_target(r.id)->>'audience' = 'PUBLIC'
  ), recent AS MATERIALIZED (
    SELECT public.rica_topic_grams(e.message_text) AS grams
    FROM target t JOIN public.inbound_events e ON (e.character_id,e.identity_id) = (t.character_id,t.identity_id)
    JOIN public.conversations c ON (c.character_id,c.identity_id,c.account_id,c.id)
      = (e.character_id,e.identity_id,e.account_id,e.conversation_id) AND c.channel = 'PUBLIC'
    JOIN public.platform_accounts a ON (a.character_id,a.identity_id,a.id) = (e.character_id,e.identity_id,e.account_id)
      AND a.status = 'ACTIVE' AND a.platform = e.adapter_id
    WHERE t.hours BETWEEN 1 AND 168 AND t.threshold BETWEEN 65 AND 100 AND cardinality(t.grams) > 0
      AND e.adapter_id IN ('mock-a','mock-b') AND e.adapter_id <> t.adapter_id AND e.id <> t.id
      AND e.received_at >= t.received_at - make_interval(hours => t.hours)
      AND e.received_at <= t.received_at + make_interval(hours => t.hours)
      AND e.message_text IS NOT NULL
    ORDER BY e.received_at DESC,e.id LIMIT 64
  )
  SELECT EXISTS (
    SELECT 1 FROM target t CROSS JOIN recent r
    CROSS JOIN LATERAL (
      SELECT count(*) AS shared FROM (SELECT unnest(t.grams) INTERSECT SELECT unnest(r.grams)) grams
    ) overlap
    WHERE cardinality(r.grams) > 0
      AND overlap.shared * 100 >= t.threshold * (cardinality(t.grams) + cardinality(r.grams) - overlap.shared)
  )
$fn$;

REVOKE ALL ON FUNCTION public.rica_topic_grams(text),public.rica_cross_platform_duplicate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_cross_platform_duplicate(uuid) TO rica_runtime;

COMMIT;
