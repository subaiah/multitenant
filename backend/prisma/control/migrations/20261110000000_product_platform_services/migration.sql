-- Manifest v2 foundation and platform services for products (docs/hub/HUB_GAPS.md G3)
ALTER TYPE "AuditActorType" ADD VALUE 'APPLICATION';

ALTER TABLE "application_registries" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'specific';
ALTER TABLE "application_registries" ADD COLUMN "manifest_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "product_declared_types" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "default_in_app" BOOLEAN NOT NULL DEFAULT true,
    "default_email" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_declared_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_declared_types_type_key" ON "product_declared_types"("type");
CREATE INDEX "product_declared_types_application_id_idx" ON "product_declared_types"("application_id");
ALTER TABLE "product_declared_types" ADD CONSTRAINT "product_declared_types_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
