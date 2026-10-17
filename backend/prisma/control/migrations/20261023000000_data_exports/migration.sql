-- Organizations' data exports
CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

CREATE TABLE "data_exports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "requested_by" TEXT,
    "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "size_bytes" BIGINT,
    "tables" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "download_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_exports_tenant_id_created_at_idx" ON "data_exports"("tenant_id", "created_at");
CREATE INDEX "data_exports_status_idx" ON "data_exports"("status");
