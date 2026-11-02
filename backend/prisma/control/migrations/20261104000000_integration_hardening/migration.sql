-- Lifecycle hardening (lib/product-lifecycle.ts): setup operations with
-- generations, so a late report can't overwrite a newer setup; overlapping
-- rotation of the callback signing secret
ALTER TABLE "application_registries" ADD COLUMN "previous_callback_signing_secret" TEXT,
ADD COLUMN "previous_callback_secret_expires_at" TIMESTAMP(3);

ALTER TABLE "tenant_applications" ADD COLUMN "provisioning_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "provisioning_operation_id" TEXT;

ALTER TABLE "product_events" ADD COLUMN "operation_id" TEXT,
ADD COLUMN "generation" INTEGER;
