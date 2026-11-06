BEGIN;

-- CreateTable
CREATE TABLE "context_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "character_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "purpose" "MemoryPurpose" NOT NULL,
    "audience_key" TEXT NOT NULL,
    "query_digest" VARCHAR(64) NOT NULL,
    "ranking_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_snapshot_evidence" (
    "character_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "memory_revision" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "estimated_tokens" INTEGER NOT NULL,

    CONSTRAINT "context_snapshot_evidence_pkey" PRIMARY KEY ("character_id","snapshot_id","rank")
);

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshots_character_id_id_key" ON "context_snapshots"("character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshots_run_id_purpose_audience_key_key" ON "context_snapshots"("run_id", "purpose", "audience_key");

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshot_evidence_character_id_snapshot_id_memory_i_key" ON "context_snapshot_evidence"("character_id", "snapshot_id", "memory_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_character_id_id_key" ON "agent_runs"("character_id", "id");

-- AddForeignKey
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_character_id_run_id_fkey" FOREIGN KEY ("character_id", "run_id") REFERENCES "agent_runs"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "context_snapshot_evidence" ADD CONSTRAINT "context_snapshot_evidence_character_id_snapshot_id_fkey" FOREIGN KEY ("character_id", "snapshot_id") REFERENCES "context_snapshots"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "context_snapshot_evidence" ADD CONSTRAINT "context_snapshot_evidence_character_id_memory_id_fkey" FOREIGN KEY ("character_id", "memory_id") REFERENCES "memories"("character_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE public.context_snapshots
  ADD CONSTRAINT "context_snapshots_audience_matches_purpose" CHECK (
    (purpose = 'PUBLIC_REFERENCE' AND btrim(audience_key) <> '')
    OR (purpose <> 'PUBLIC_REFERENCE' AND audience_key = '')
  ),
  ADD CONSTRAINT "context_snapshots_digest_format" CHECK (query_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "context_snapshots_ranker_positive" CHECK (ranking_version > 0);

ALTER TABLE public.context_snapshot_evidence
  ADD CONSTRAINT "context_snapshot_evidence_values_in_range" CHECK (
    rank BETWEEN 1 AND 8 AND score BETWEEN 0 AND 1
    AND estimated_tokens BETWEEN 1 AND 1500 AND memory_revision > 0
  );

GRANT SELECT, INSERT ON public.context_snapshots, public.context_snapshot_evidence TO rica_runtime;
ALTER TABLE public.context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.context_snapshot_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_snapshot_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY context_snapshots_owner ON public.context_snapshots TO CURRENT_USER
  USING (true) WITH CHECK (true);
CREATE POLICY context_snapshot_evidence_owner ON public.context_snapshot_evidence TO CURRENT_USER
  USING (true) WITH CHECK (true);
CREATE POLICY context_snapshots_runtime ON public.context_snapshots TO rica_runtime
  USING (run_id = (SELECT NULLIF(current_setting('rica.snapshot_run', true), '')::uuid))
  WITH CHECK (run_id = (SELECT NULLIF(current_setting('rica.snapshot_run', true), '')::uuid));
-- The snapshot's RLS policy controls which reference rows can be read or written.
CREATE POLICY context_snapshot_evidence_runtime ON public.context_snapshot_evidence TO rica_runtime
  USING (EXISTS (
    SELECT 1 FROM public.context_snapshots s
    WHERE (s.character_id, s.id) = (context_snapshot_evidence.character_id, context_snapshot_evidence.snapshot_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.context_snapshots s
    WHERE (s.character_id, s.id) = (context_snapshot_evidence.character_id, context_snapshot_evidence.snapshot_id)
  ));

COMMIT;
