-- Trials that end, and organizations closed by their own admins
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "trial_reminder_sent_at" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "trial_ended_notified_at" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "closed_at" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "closed_by" TEXT;
ALTER TABLE "tenants" ADD COLUMN "delete_after" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "status_before_close" "TenantStatus";
