-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'PLATFORM', 'SYSTEM', 'ANONYMOUS');

-- CreateTable
CREATE TABLE "platform_audit_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
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

    CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_heads" (
    "chain" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_heads_pkey" PRIMARY KEY ("chain")
);

-- CreateTable
CREATE TABLE "audit_archives" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tenant_id" TEXT,
    "from_seq" INTEGER NOT NULL,
    "to_seq" INTEGER NOT NULL,
    "from_at" TIMESTAMP(3) NOT NULL,
    "to_at" TIMESTAMP(3) NOT NULL,
    "rows" INTEGER NOT NULL,
    "first_prev_hash" TEXT NOT NULL,
    "last_hash" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_archives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_audit_events_seq_key" ON "platform_audit_events"("seq");

-- CreateIndex
CREATE INDEX "platform_audit_events_occurred_at_idx" ON "platform_audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_events_tenant_id_idx" ON "platform_audit_events"("tenant_id");

-- CreateIndex
CREATE INDEX "platform_audit_events_event_idx" ON "platform_audit_events"("event");

-- CreateIndex
CREATE INDEX "audit_archives_tenant_id_idx" ON "audit_archives"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_archives_chain_from_seq_key" ON "audit_archives"("chain", "from_seq");
