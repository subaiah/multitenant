-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'PLATFORM', 'SYSTEM', 'ANONYMOUS');

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" TEXT,
    "actor_email" TEXT,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "resource_label" TEXT,
    "changes" JSONB,
    "details" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_event_idx" ON "audit_events"("tenant_id", "event");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_resource_type_resource_id_idx" ON "audit_events"("tenant_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_actor_id_idx" ON "audit_events"("tenant_id", "actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_tenant_id_seq_key" ON "audit_events"("tenant_id", "seq");
