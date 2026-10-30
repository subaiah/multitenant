-- A tenant is set up even when its first administrator's invitation email fails
ALTER TABLE "tenants" ADD COLUMN "admin_invite_error" TEXT;
