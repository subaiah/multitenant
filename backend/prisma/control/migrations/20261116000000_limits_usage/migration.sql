-- Per-application limits by plan, and usage reporting (docs/hub/HUB_GAPS.md G6)
ALTER TABLE "tenant_applications" ADD COLUMN "limits_state_hash" TEXT;

CREATE TABLE "product_limits" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "default_value" JSONB NOT NULL,
    "unit" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_limits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_limits_key_key" ON "product_limits"("key");
CREATE INDEX "product_limits_application_id_idx" ON "product_limits"("application_id");
ALTER TABLE "product_limits" ADD CONSTRAINT "product_limits_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "product_plan_limits" (
    "id" TEXT NOT NULL,
    "limit_id" TEXT NOT NULL,
    "plan_code" "TenantPlan" NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_plan_limits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_plan_limits_limit_id_plan_code_key" ON "product_plan_limits"("limit_id", "plan_code");
ALTER TABLE "product_plan_limits" ADD CONSTRAINT "product_plan_limits_limit_id_fkey" FOREIGN KEY ("limit_id") REFERENCES "product_limits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "product_usage_meters" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_usage_meters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_usage_meters_key_key" ON "product_usage_meters"("key");
CREATE INDEX "product_usage_meters_application_id_idx" ON "product_usage_meters"("application_id");
ALTER TABLE "product_usage_meters" ADD CONSTRAINT "product_usage_meters_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "product_usage_records" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "meter_key" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_usage_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_usage_records_idempotency_key" ON "product_usage_records"("application_id", "tenant_id", "idempotency_key");
CREATE INDEX "product_usage_records_tenant_id_meter_key_occurred_at_idx" ON "product_usage_records"("tenant_id", "meter_key", "occurred_at");
CREATE INDEX "product_usage_records_application_id_occurred_at_idx" ON "product_usage_records"("application_id", "occurred_at");
ALTER TABLE "product_usage_records" ADD CONSTRAINT "product_usage_records_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
