-- AlterTable
ALTER TABLE "platform_users" ADD COLUMN     "mfa_enabled_at" TIMESTAMP(3),
ADD COLUMN     "mfa_last_step" INTEGER,
ADD COLUMN     "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totp_secret" TEXT;

-- AlterTable
ALTER TABLE "platform_refresh_tokens" ADD COLUMN     "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "session_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
