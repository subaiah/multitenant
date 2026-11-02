-- Products that are told when people change (lib/product-user-events.ts)
ALTER TABLE "application_registries" ADD COLUMN "user_events" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "product_member_states" (
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "user_type" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "name_hash" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_member_states_pkey" PRIMARY KEY ("application_id","tenant_id","user_id")
);

CREATE INDEX "product_member_states_tenant_id_idx" ON "product_member_states"("tenant_id");
ALTER TABLE "product_member_states" ADD CONSTRAINT "product_member_states_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
