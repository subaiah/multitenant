-- Billing: plans with per-seat prices and limits, subscriptions (Razorpay,
-- Stripe), invoices, webhook deliveries
CREATE TYPE "BillingProvider" AS ENUM ('RAZORPAY', 'STRIPE');
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED');

ALTER TABLE "tenants" ADD COLUMN     "payment_required_since" TIMESTAMP(3);

CREATE TABLE "billing_plans" (
    "code" "TenantPlan" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "max_users" INTEGER,
    "max_organizations" INTEGER,
    "max_groups" INTEGER,
    "allow_sso" BOOLEAN NOT NULL DEFAULT false,
    "allow_custom_domain" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "billing_prices" (
    "id" TEXT NOT NULL,
    "plan_code" "TenantPlan" NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "provider_price_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_prices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "provider_subscription_id" TEXT NOT NULL,
    "provider_customer_id" TEXT,
    "plan_code" "TenantPlan" NOT NULL,
    "price_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "seats" INTEGER NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "past_due_since" TIMESTAMP(3),
    "checkout_url" TEXT,
    "seat_sync_error" TEXT,
    "seats_synced_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "provider_invoice_id" TEXT NOT NULL,
    "number" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "url" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenant_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_prices_provider_price_id_key" ON "billing_prices"("provider_price_id");
CREATE INDEX "billing_prices_plan_code_active_idx" ON "billing_prices"("plan_code", "active");
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");
CREATE UNIQUE INDEX "subscriptions_provider_subscription_id_key" ON "subscriptions"("provider_subscription_id");
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");
CREATE UNIQUE INDEX "invoices_provider_invoice_id_key" ON "invoices"("provider_invoice_id");
CREATE INDEX "invoices_tenant_id_created_at_idx" ON "invoices"("tenant_id", "created_at");
CREATE INDEX "billing_events_received_at_idx" ON "billing_events"("received_at");
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events"("provider", "event_id");

ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "billing_plans"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- The plans, with starting limits (platform staff change them on the Plans page)
INSERT INTO "billing_plans" ("code", "name", "description", "public", "sort_order", "max_users", "max_organizations", "max_groups", "allow_sso", "allow_custom_domain", "updated_at") VALUES
  ('FREE', 'Free', 'For trying things out and small teams', true, 0, 5, 1, 5, false, false, CURRENT_TIMESTAMP),
  ('STARTER', 'Starter', 'For growing teams', true, 1, 50, 5, 50, false, true, CURRENT_TIMESTAMP),
  ('PROFESSIONAL', 'Professional', 'Single sign-on, and room to grow', true, 2, 500, NULL, NULL, true, true, CURRENT_TIMESTAMP),
  ('ENTERPRISE', 'Enterprise', 'No limits; arranged with our team', false, 3, NULL, NULL, NULL, true, true, CURRENT_TIMESTAMP);
