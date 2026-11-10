-- Applications publishing events for each other (manifest v2 events; docs/hub/HUB_GAPS.md G4)
ALTER TABLE "product_declared_types" ADD COLUMN "schema_url" TEXT;

CREATE TABLE "product_event_subscriptions" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_event_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_event_subscriptions_application_id_type_key" ON "product_event_subscriptions"("application_id", "type");
CREATE INDEX "product_event_subscriptions_type_idx" ON "product_event_subscriptions"("type");
ALTER TABLE "product_event_subscriptions" ADD CONSTRAINT "product_event_subscriptions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "product_published_events" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "applications" INTEGER NOT NULL DEFAULT 0,
    "webhooks" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_published_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_published_events_idempotency_key" ON "product_published_events"("application_id", "tenant_id", "idempotency_key");
CREATE INDEX "product_published_events_tenant_id_type_created_at_idx" ON "product_published_events"("tenant_id", "type", "created_at");
ALTER TABLE "product_published_events" ADD CONSTRAINT "product_published_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
