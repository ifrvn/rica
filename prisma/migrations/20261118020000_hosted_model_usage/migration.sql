CREATE TABLE public.hosted_model_usage_daily (
  day date NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  character_id text NOT NULL CHECK (character_id = '' OR nullif(character_id, '')::uuid IS NOT NULL),
  identity_id text NOT NULL CHECK (identity_id = '' OR nullif(identity_id, '')::uuid IS NOT NULL),
  platform text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('DRAFT', 'REVIEW', 'CHECK')),
  outcome text NOT NULL CHECK (outcome IN ('OK', 'HTTP_ERROR', 'RATE_LIMITED', 'TIMED_OUT', 'CONNECTION_FAILED', 'INVALID_OUTPUT')),
  requests bigint NOT NULL DEFAULT 0,
  token_reports bigint NOT NULL DEFAULT 0,
  sent_bytes bigint NOT NULL DEFAULT 0,
  received_bytes bigint NOT NULL DEFAULT 0,
  elapsed_ms bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model, character_id, identity_id, platform, purpose, outcome)
);

GRANT SELECT ON public.hosted_model_usage_daily TO rica_admin_api;

CREATE FUNCTION public.rica_record_hosted_model_usage(
  utc_day date, provider text, model text, character_id text, identity_id text, platform text,
  purpose text, outcome text, sent_bytes bigint, received_bytes bigint, elapsed_ms bigint,
  input_tokens bigint, output_tokens bigint, total_tokens bigint
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  INSERT INTO public.hosted_model_usage_daily AS summary (
    day, provider, model, character_id, identity_id, platform, purpose, outcome,
    requests, token_reports, sent_bytes, received_bytes, elapsed_ms, input_tokens, output_tokens, total_tokens
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,($14 IS NOT NULL)::integer,$9,$10,$11,coalesce($12,0),coalesce($13,0),coalesce($14,0))
  ON CONFLICT ON CONSTRAINT hosted_model_usage_daily_pkey DO UPDATE
  SET requests = summary.requests + 1, token_reports = summary.token_reports + excluded.token_reports,
      sent_bytes = summary.sent_bytes + excluded.sent_bytes, received_bytes = summary.received_bytes + excluded.received_bytes,
      elapsed_ms = summary.elapsed_ms + excluded.elapsed_ms, input_tokens = summary.input_tokens + excluded.input_tokens,
      output_tokens = summary.output_tokens + excluded.output_tokens, total_tokens = summary.total_tokens + excluded.total_tokens
$$;

REVOKE ALL ON FUNCTION public.rica_record_hosted_model_usage(date,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_record_hosted_model_usage(date,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint) TO rica_runtime, rica_admin_api;
