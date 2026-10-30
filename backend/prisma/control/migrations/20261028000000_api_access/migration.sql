-- API keys can act (audit entries); organizations with webhook deliveries waiting
ALTER TYPE "AuditActorType" ADD VALUE 'API_KEY';

CREATE TABLE "webhook_work" (
    "tenant_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_work_pkey" PRIMARY KEY ("tenant_id")
);

CREATE INDEX "webhook_work_due_at_idx" ON "webhook_work"("due_at");
