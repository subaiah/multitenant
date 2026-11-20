-- Each health check's outcome, so organizations see uptime over time (lib/app-figures.ts).
-- Kept 31 days (lib/product-health.ts prunes older ones).
-- outcome: UP, DEGRADED, or FAILED (no answer, an error, not 200)
CREATE TABLE "application_health_samples" (
    "id" BIGSERIAL NOT NULL,
    "application_id" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "response_ms" INTEGER,

    CONSTRAINT "application_health_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "application_health_samples_application_id_checked_at_idx" ON "application_health_samples"("application_id", "checked_at");
CREATE INDEX "application_health_samples_checked_at_idx" ON "application_health_samples"("checked_at");

ALTER TABLE "application_health_samples" ADD CONSTRAINT "application_health_samples_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
