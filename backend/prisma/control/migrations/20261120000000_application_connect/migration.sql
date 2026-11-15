-- One-time hand-overs of an application's credentials (docs/hub/CONNECT.md)

-- CreateTable
CREATE TABLE "application_connect_grants" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_connect_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "application_connect_grants_code_hash_key" ON "application_connect_grants"("code_hash");

-- CreateIndex
CREATE INDEX "application_connect_grants_application_id_idx" ON "application_connect_grants"("application_id");

-- AddForeignKey
ALTER TABLE "application_connect_grants" ADD CONSTRAINT "application_connect_grants_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
