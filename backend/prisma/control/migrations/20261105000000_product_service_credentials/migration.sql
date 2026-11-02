-- External products' credentials for calling API v1 (lib/product-service.ts)
CREATE TABLE "product_service_credentials" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "product_service_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_service_credentials_client_id_key" ON "product_service_credentials"("client_id");
CREATE INDEX "product_service_credentials_application_id_idx" ON "product_service_credentials"("application_id");
ALTER TABLE "product_service_credentials" ADD CONSTRAINT "product_service_credentials_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
