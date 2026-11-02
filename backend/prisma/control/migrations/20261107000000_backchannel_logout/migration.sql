-- Back-Channel Logout and access token lifetimes for "Sign in with" (lib/oidc/logout.ts)
ALTER TABLE "application_sign_ins" ADD COLUMN "backchannel_logout_uri" TEXT;
ALTER TABLE "application_sign_ins" ADD COLUMN "access_token_lifetime" INTEGER NOT NULL DEFAULT 900;

CREATE TABLE "oidc_logout_deliveries" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ProductEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oidc_logout_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "oidc_logout_deliveries_status_next_attempt_at_idx" ON "oidc_logout_deliveries"("status", "next_attempt_at");
CREATE INDEX "oidc_logout_deliveries_application_id_created_at_idx" ON "oidc_logout_deliveries"("application_id", "created_at");
ALTER TABLE "oidc_logout_deliveries" ADD CONSTRAINT "oidc_logout_deliveries_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
