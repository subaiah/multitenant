-- AlterEnum
ALTER TYPE "UserTokenType" ADD VALUE 'EMAIL_CHANGE';

-- AlterTable
ALTER TABLE "platform_user_tokens" ADD COLUMN     "new_email" TEXT;
