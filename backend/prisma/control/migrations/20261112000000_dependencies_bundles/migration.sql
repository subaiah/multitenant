-- Application dependencies and bundles (docs/hub/HUB_GAPS.md G2)
CREATE TABLE "product_dependencies" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_dependencies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_dependencies_application_id_product_key_key" ON "product_dependencies"("application_id", "product_key");
CREATE INDEX "product_dependencies_product_key_idx" ON "product_dependencies"("product_key");
ALTER TABLE "product_dependencies" ADD CONSTRAINT "product_dependencies_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "bundles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bundles_key_key" ON "bundles"("key");

CREATE TABLE "bundle_applications" (
    "bundle_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bundle_applications_pkey" PRIMARY KEY ("bundle_id","application_id")
);
ALTER TABLE "bundle_applications" ADD CONSTRAINT "bundle_applications_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bundle_applications" ADD CONSTRAINT "bundle_applications_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
