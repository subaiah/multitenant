-- CreateEnum
CREATE TYPE "SupportAccess" AS ENUM ('READ_ONLY', 'READ_WRITE');

-- CreateEnum
CREATE TYPE "SupportSessionStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED', 'EXPIRED');

-- DropForeignKey
ALTER TABLE "support_sessions" DROP CONSTRAINT "support_sessions_approved_by_fkey";

-- DropIndex
DROP INDEX "support_sessions_platform_user_id_idx";

-- DropIndex
DROP INDEX "support_sessions_valid_from_valid_to_idx";

-- AlterTable
ALTER TABLE "support_sessions" ADD COLUMN     "access" "SupportAccess" NOT NULL DEFAULT 'READ_ONLY',
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "decision_note" TEXT,
ADD COLUMN     "duration_minutes" INTEGER NOT NULL DEFAULT 60,
ALTER COLUMN "approved_by" DROP NOT NULL,
ALTER COLUMN "valid_from" DROP NOT NULL,
ALTER COLUMN "valid_from" DROP DEFAULT,
ALTER COLUMN "valid_to" DROP NOT NULL;

-- Status becomes an enum, keeping the history (edited by hand: Prisma would
-- drop and re-add the column). Sessions "active" before this were never
-- enforced nor approved by anyone else, so they end now.
UPDATE "support_sessions" SET "status" = 'EXPIRED' WHERE "status" = 'ACTIVE';
ALTER TABLE "support_sessions" ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "status" TYPE "SupportSessionStatus" USING "status"::"SupportSessionStatus",
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "platform_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_assignments" (
    "id" TEXT NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_roles_name_key" ON "platform_roles"("name");

-- CreateIndex
CREATE INDEX "platform_role_assignments_role_id_idx" ON "platform_role_assignments"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_assignments_platform_user_id_role_id_key" ON "platform_role_assignments"("platform_user_id", "role_id");

-- CreateIndex
CREATE INDEX "support_sessions_platform_user_id_tenant_id_status_idx" ON "support_sessions"("platform_user_id", "tenant_id", "status");

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
