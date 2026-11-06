CREATE TABLE "outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMPTZ,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "outbox_processed_at_enqueued_at_created_at_idx"
ON "outbox"("processed_at", "enqueued_at", "created_at");
