-- Lifecycle events for external products (lib/product-lifecycle.ts)
CREATE TYPE "EntitlementProvisioning" AS ENUM ('NOT_REQUIRED', 'PENDING', 'READY', 'FAILED');
CREATE TYPE "ProductEventStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

ALTER TABLE "application_registries" ADD COLUMN "provisioning_callback_url" TEXT,
ADD COLUMN "callback_signing_secret" TEXT,
ADD COLUMN "deletes_data_on_deprovision" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tenant_applications" ADD COLUMN "provisioning_status" "EntitlementProvisioning" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN "provisioning_error" TEXT,
ADD COLUMN "provisioned_at" TIMESTAMP(3);

CREATE TABLE "product_events" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "public_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ProductEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_events_seq_key" ON "product_events"("seq");
CREATE UNIQUE INDEX "product_events_public_id_key" ON "product_events"("public_id");
CREATE INDEX "product_events_status_next_attempt_at_idx" ON "product_events"("status", "next_attempt_at");
CREATE INDEX "product_events_application_id_tenant_id_seq_idx" ON "product_events"("application_id", "tenant_id", "seq");
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
