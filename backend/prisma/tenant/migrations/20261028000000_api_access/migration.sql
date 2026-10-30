-- API keys and outgoing webhooks (docs/API_ACCESS.md)
ALTER TYPE "AuditActorType" ADD VALUE 'API_KEY';

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "permissions" TEXT[],
    "user_type" "UserType" NOT NULL,
    "created_by_id" TEXT,
    "created_by_email" TEXT,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "signing_secret" TEXT NOT NULL,
    "created_by_id" TEXT,
    "last_success_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "response_status" INTEGER,
    "last_error" TEXT,
    "duration_ms" INTEGER,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_keys_tenant_id_revoked_at_idx" ON "api_keys"("tenant_id", "revoked_at");
CREATE INDEX "webhook_endpoints_tenant_id_enabled_idx" ON "webhook_endpoints"("tenant_id", "enabled");
CREATE INDEX "webhook_deliveries_tenant_id_status_next_attempt_at_idx" ON "webhook_deliveries"("tenant_id", "status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_tenant_id_endpoint_id_created_at_idx" ON "webhook_deliveries"("tenant_id", "endpoint_id", "created_at");

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
