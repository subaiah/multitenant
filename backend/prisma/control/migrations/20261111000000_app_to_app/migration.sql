-- Application-to-application calls (docs/adr/0001-app-to-app-calls.md; HUB_GAPS G1)
ALTER TABLE "application_registries" ADD COLUMN "api_open_api_url" TEXT;

CREATE TABLE "product_api_scopes" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "allows_on_behalf_of" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_api_scopes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_api_scopes_name_key" ON "product_api_scopes"("name");
CREATE INDEX "product_api_scopes_application_id_idx" ON "product_api_scopes"("application_id");
ALTER TABLE "product_api_scopes" ADD CONSTRAINT "product_api_scopes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "product_consumed_scopes" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_consumed_scopes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_consumed_scopes_application_id_scope_key" ON "product_consumed_scopes"("application_id", "scope");
ALTER TABLE "product_consumed_scopes" ADD CONSTRAINT "product_consumed_scopes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "app_connection_states" (
    "tenant_id" TEXT NOT NULL,
    "caller_application_id" TEXT NOT NULL,
    "target_application_id" TEXT NOT NULL,
    "blocked_at" TIMESTAMP(3),
    "blocked_by_email" TEXT,
    "tokens_issued" INTEGER NOT NULL DEFAULT 0,
    "last_issued_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_connection_states_pkey" PRIMARY KEY ("tenant_id","caller_application_id","target_application_id")
);
CREATE INDEX "app_connection_states_tenant_id_idx" ON "app_connection_states"("tenant_id");
ALTER TABLE "app_connection_states" ADD CONSTRAINT "app_connection_states_caller_application_id_fkey" FOREIGN KEY ("caller_application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_connection_states" ADD CONSTRAINT "app_connection_states_target_application_id_fkey" FOREIGN KEY ("target_application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
