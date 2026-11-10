-- Per-application prices and usage charges on the organization's subscription (docs/hub/HUB_GAPS.md G6)
CREATE TABLE "application_prices" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "model" TEXT NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_prices_application_id_currency_interval_key" ON "application_prices"("application_id", "currency", "interval");
ALTER TABLE "application_prices" ADD CONSTRAINT "application_prices_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "meter_prices" (
    "id" TEXT NOT NULL,
    "meter_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "per_quantity" INTEGER NOT NULL DEFAULT 1,
    "included_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meter_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meter_prices_meter_id_currency_key" ON "meter_prices"("meter_id", "currency");
ALTER TABLE "meter_prices" ADD CONSTRAINT "meter_prices_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "product_usage_meters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "application_charges" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "meter_key" TEXT NOT NULL DEFAULT '',
    "quantity" DOUBLE PRECISION NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_charge_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_charges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_charges_once" ON "application_charges"("tenant_id", "application_id", "period_end", "kind", "meter_key");
CREATE INDEX "application_charges_status_idx" ON "application_charges"("status");
CREATE INDEX "application_charges_tenant_id_period_end_idx" ON "application_charges"("tenant_id", "period_end");
