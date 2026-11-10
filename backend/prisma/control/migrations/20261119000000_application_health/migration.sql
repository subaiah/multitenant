-- Application health checks (manifest v2 health; docs/hub/HUB_GAPS.md G9)
ALTER TABLE "application_registries"
  ADD COLUMN "health_url" TEXT,
  ADD COLUMN "health_status" TEXT,
  ADD COLUMN "health_version" TEXT,
  ADD COLUMN "health_response_ms" INTEGER,
  ADD COLUMN "health_checked_at" TIMESTAMP(3),
  ADD COLUMN "health_changed_at" TIMESTAMP(3),
  ADD COLUMN "health_error" TEXT,
  ADD COLUMN "health_failures" INTEGER NOT NULL DEFAULT 0;
