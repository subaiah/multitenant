-- Record types applications own, for references across applications (docs/hub/HUB_GAPS.md G8)
ALTER TABLE "application_registries" ADD COLUMN "access_check_path" TEXT;

CREATE TABLE "product_resource_types" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url_template" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_resource_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_resource_types_application_id_type_key" ON "product_resource_types"("application_id", "type");
ALTER TABLE "product_resource_types" ADD CONSTRAINT "product_resource_types_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
