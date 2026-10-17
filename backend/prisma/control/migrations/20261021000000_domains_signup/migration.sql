-- CreateEnum
CREATE TYPE "CustomDomainStatus" AS ENUM ('PENDING', 'VERIFIED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "custom_domain_checked_at" TIMESTAMP(3),
ADD COLUMN     "custom_domain_error" TEXT,
ADD COLUMN     "custom_domain_status" "CustomDomainStatus",
ADD COLUMN     "custom_domain_token" TEXT,
ADD COLUMN     "custom_domain_verified_at" TIMESTAMP(3);

-- A domain set before verification existed was never proven: ask again
UPDATE "tenants" SET "custom_domain_status" = 'PENDING', "custom_domain_token" = md5(random()::text || id) WHERE "custom_domain" IS NOT NULL;

-- CreateTable
CREATE TABLE "signup_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "password_hash" TEXT,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "tenant_id" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signup_requests_token_hash_key" ON "signup_requests"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "signup_requests_tenant_id_key" ON "signup_requests"("tenant_id");

-- CreateIndex
CREATE INDEX "signup_requests_email_idx" ON "signup_requests"("email");

-- CreateIndex
CREATE INDEX "signup_requests_expires_at_idx" ON "signup_requests"("expires_at");
