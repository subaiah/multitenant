-- External products registered from a manifest (docs/PRODUCT_INTEGRATION.md):
-- where they live, and their pages in the tenant portal's sidebar
ALTER TABLE "application_registries" ADD COLUMN "base_url" TEXT,
ADD COLUMN "manifest_imported_at" TIMESTAMP(3);

CREATE TABLE "application_menu_items" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "icon" TEXT,
    "permission" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "application_menu_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "application_menu_items_application_id_idx" ON "application_menu_items"("application_id");
ALTER TABLE "application_menu_items" ADD CONSTRAINT "application_menu_items_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
