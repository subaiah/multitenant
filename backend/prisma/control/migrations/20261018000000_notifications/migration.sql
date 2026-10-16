-- CreateEnum
CREATE TYPE "NotificationOutboxKind" AS ENUM ('EVENT', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'FAILED');

-- CreateTable
CREATE TABLE "platform_notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_notification_outbox" (
    "id" TEXT NOT NULL,
    "kind" "NotificationOutboxKind" NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,

    CONSTRAINT "platform_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_work" (
    "chain" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_work_pkey" PRIMARY KEY ("chain")
);

-- CreateIndex
CREATE INDEX "platform_notifications_user_id_created_at_idx" ON "platform_notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_notifications_user_id_read_at_idx" ON "platform_notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "platform_notification_outbox_status_next_attempt_at_idx" ON "platform_notification_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_notification_preferences_user_id_type_key" ON "platform_notification_preferences"("user_id", "type");

-- CreateIndex
CREATE INDEX "notification_work_due_at_idx" ON "notification_work"("due_at");
