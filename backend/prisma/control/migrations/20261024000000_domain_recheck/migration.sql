-- Re-checking verified custom domains
ALTER TABLE "tenants" ADD COLUMN "custom_domain_failures" INTEGER NOT NULL DEFAULT 0;
