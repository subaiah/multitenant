-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('PENDING', 'PROVISIONING', 'READY', 'FAILED', 'DEPROVISIONING');

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TRIAL');

-- CreateEnum
CREATE TYPE "DatabaseStrategy" AS ENUM ('DATABASE_PER_TENANT', 'SCHEMA_PER_TENANT', 'SHARED_TABLES');

-- CreateEnum
CREATE TYPE "DatabaseProvider" AS ENUM ('POSTGRESQL');

-- CreateEnum
CREATE TYPE "PlatformUserType" AS ENUM ('PLATFORM_ADMIN', 'PLATFORM_USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "UserTokenType" AS ENUM ('INVITE', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('DEPLOY', 'CONFIG', 'USER', 'BILLING', 'ALERT', 'AUTH', 'API');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "TenantPlan" NOT NULL,
    "status" "TenantStatus" NOT NULL,
    "logo_url" TEXT,
    "primary_color" TEXT DEFAULT '#3b82f6',
    "custom_domain" TEXT,
    "login_title" TEXT,
    "login_subtitle" TEXT,
    "provisioning_status" "ProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "provisioning_error" TEXT,
    "provisioned_at" TIMESTAMP(3),
    "initial_admin_email" TEXT,
    "initial_admin_name" TEXT,
    "admin_invited_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage" (
    "tenant_id" TEXT NOT NULL,
    "users" INTEGER NOT NULL DEFAULT 0,
    "applications" INTEGER NOT NULL DEFAULT 0,
    "apps_by_status" JSONB NOT NULL DEFAULT '{}',
    "last_active_at" TIMESTAMP(3),
    "activity_by_day" JSONB NOT NULL DEFAULT '[]',
    "recent_activity" JSONB NOT NULL DEFAULT '[]',
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "database_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "strategy" "DatabaseStrategy" NOT NULL,
    "provider" "DatabaseProvider" NOT NULL DEFAULT 'POSTGRESQL',
    "region" TEXT NOT NULL,
    "backup_enabled" BOOLEAN NOT NULL DEFAULT false,
    "encryption_at_rest" BOOLEAN NOT NULL DEFAULT false,
    "max_connections" INTEGER NOT NULL DEFAULT 100,
    "storage_limit" TEXT NOT NULL,
    "connection_string" TEXT,
    "schema_name" TEXT,
    "database_name" TEXT,
    "tenant_column" TEXT,
    "db_role_name" TEXT,
    "last_migration" TEXT,
    "migrated_at" TIMESTAMP(3),
    "migration_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "user_type" "PlatformUserType" NOT NULL DEFAULT 'PLATFORM_USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "sessions_valid_after" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "UserTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_activities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_registries" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_registries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "application_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_applications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ENABLED',
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "parent_id" TEXT,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "icon" TEXT,
    "permission" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_custom_domain_key" ON "tenants"("custom_domain");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenants_provisioning_status_idx" ON "tenants"("provisioning_status");

-- CreateIndex
CREATE UNIQUE INDEX "database_configs_tenant_id_key" ON "database_configs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "database_configs_db_role_name_key" ON "database_configs"("db_role_name");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_users_user_type_idx" ON "platform_users"("user_type");

-- CreateIndex
CREATE UNIQUE INDEX "platform_refresh_tokens_token_key" ON "platform_refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "platform_refresh_tokens_user_id_idx" ON "platform_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "platform_refresh_tokens_family_id_idx" ON "platform_refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "platform_refresh_tokens_expires_at_idx" ON "platform_refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_tokens_token_hash_key" ON "platform_user_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "platform_user_tokens_user_id_type_idx" ON "platform_user_tokens"("user_id", "type");

-- CreateIndex
CREATE INDEX "platform_activities_tenant_id_idx" ON "platform_activities"("tenant_id");

-- CreateIndex
CREATE INDEX "platform_activities_created_at_idx" ON "platform_activities"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_registries_key_key" ON "application_registries"("key");

-- CreateIndex
CREATE INDEX "application_registries_status_idx" ON "application_registries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");

-- CreateIndex
CREATE INDEX "permissions_application_id_idx" ON "permissions"("application_id");

-- CreateIndex
CREATE INDEX "permissions_resource_action_idx" ON "permissions"("resource", "action");

-- CreateIndex
CREATE INDEX "tenant_applications_application_id_idx" ON "tenant_applications"("application_id");

-- CreateIndex
CREATE INDEX "tenant_applications_state_idx" ON "tenant_applications"("state");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_applications_tenant_id_application_id_key" ON "tenant_applications"("tenant_id", "application_id");

-- CreateIndex
CREATE INDEX "support_sessions_tenant_id_status_idx" ON "support_sessions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "support_sessions_platform_user_id_idx" ON "support_sessions"("platform_user_id");

-- CreateIndex
CREATE INDEX "support_sessions_valid_from_valid_to_idx" ON "support_sessions"("valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "menu_items_portal_is_active_order_idx" ON "menu_items"("portal", "is_active", "order");

-- CreateIndex
CREATE INDEX "menu_items_parent_id_idx" ON "menu_items"("parent_id");

-- AddForeignKey
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_configs" ADD CONSTRAINT "database_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_user_tokens" ADD CONSTRAINT "platform_user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_applications" ADD CONSTRAINT "tenant_applications_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
