BEGIN;

CREATE TABLE public.remote_plugin_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id varchar(50) NOT NULL,
  task_type varchar(50) NOT NULL,
  character_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  account_id uuid NOT NULL,
  binding_version integer NOT NULL,
  auth_epoch integer NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '15 minutes'),
  lease uuid,
  lease_until timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED')),
  result jsonb,
  CHECK ((status = 'PENDING') = (lease IS NULL)),
  CHECK ((status = 'LEASED') = (lease_until IS NOT NULL)),
  CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (result IS NOT NULL)),
  CONSTRAINT remote_plugin_tasks_account_fkey FOREIGN KEY (character_id, identity_id, account_id)
    REFERENCES public.platform_accounts(character_id, identity_id, id) ON DELETE CASCADE
);
CREATE INDEX remote_plugin_tasks_queue_idx ON public.remote_plugin_tasks(plugin_id, account_id, created_at, id);
GRANT SELECT ON public.remote_plugin_tasks TO rica_admin_api;

CREATE FUNCTION public.rica_queue_remote_task_v1(source text, target_character uuid, target_account uuid,
  target_version integer, task_kind text, task_data jsonb)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
  INSERT INTO public.remote_plugin_tasks(plugin_id, task_type, character_id, identity_id, account_id, binding_version, auth_epoch, data)
  SELECT source, task_kind, a.character_id, a.identity_id, a.id, a.binding_version, c.auth_epoch, task_data
  FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (a.character_id,a.identity_id)
  WHERE (a.id,a.character_id,a.binding_version) = (target_account,target_character,target_version)
    AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE'
  RETURNING id;
$fn$;

CREATE FUNCTION public.rica_remote_task_v1(source text, target_account uuid, target_version integer, types text[],
  task_id uuid, worker_lease uuid, outcome text, receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  epoch integer;
  job public.remote_plugin_tasks%ROWTYPE;
  stamp timestamptz;
BEGIN
  PERFORM c.id FROM public.characters c JOIN public.platform_accounts a ON a.character_id = c.id
  WHERE a.id = target_account FOR UPDATE OF c;
  SELECT c.auth_epoch INTO epoch FROM public.platform_accounts a JOIN public.characters c ON c.id = a.character_id
  JOIN public.identities i ON (i.character_id,i.id) = (a.character_id,a.identity_id)
  WHERE a.id = target_account AND a.binding_version = target_version
    AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND c.status = 'ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;
  stamp := clock_timestamp();

  IF task_id IS NULL THEN
    UPDATE public.remote_plugin_tasks t
    SET status = 'LEASED', lease = gen_random_uuid(), lease_until = least(t.expires_at, stamp + interval '30 seconds')
    WHERE t.id = (
      SELECT q.id FROM public.remote_plugin_tasks q
      WHERE (q.plugin_id,q.account_id,q.binding_version,q.auth_epoch) = (source,target_account,target_version,epoch)
        AND q.task_type = ANY(types) AND q.expires_at > stamp
        AND (q.status = 'PENDING' OR (q.status = 'LEASED' AND q.lease_until <= stamp))
      ORDER BY q.created_at,q.id LIMIT 1
    ) RETURNING t.* INTO job;
    IF NOT FOUND THEN RETURN jsonb_build_object('task', NULL); END IF;
    RETURN jsonb_build_object('task', jsonb_build_object('id',job.id,'type',job.task_type,
      'characterId',job.character_id,'accountId',job.account_id,'bindingVersion',job.binding_version,
      'data',job.data,'lease',job.lease,'leaseUntil',job.lease_until));
  END IF;

  SELECT t.* INTO job FROM public.remote_plugin_tasks t
  WHERE t.id = task_id AND (t.plugin_id,t.account_id,t.binding_version,t.auth_epoch) = (source,target_account,target_version,epoch)
    AND t.task_type = ANY(types);
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.lease = worker_lease AND job.status = outcome AND job.result = receipt THEN
    RETURN jsonb_build_object('id',job.id,'status',job.status);
  END IF;
  IF job.status <> 'LEASED' OR job.lease IS DISTINCT FROM worker_lease OR job.lease_until <= stamp THEN
    RETURN jsonb_build_object('conflict',true);
  END IF;
  UPDATE public.remote_plugin_tasks SET status = outcome, result = receipt, lease_until = NULL WHERE id = task_id;
  RETURN jsonb_build_object('id',task_id,'status',outcome);
END
$fn$;

REVOKE ALL ON FUNCTION public.rica_queue_remote_task_v1(text,uuid,uuid,integer,text,jsonb),
  public.rica_remote_task_v1(text,uuid,integer,text[],uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rica_queue_remote_task_v1(text,uuid,uuid,integer,text,jsonb) TO rica_admin_api;
GRANT EXECUTE ON FUNCTION public.rica_remote_task_v1(text,uuid,integer,text[],uuid,uuid,text,jsonb) TO rica_plugin_event_api;

COMMIT;
