-- Access rules that apply to every organization (Global policies → Access
-- rules, lib/access-rules.ts). An organization's own rules live in its
-- access_policies table; the platform's are checked first.
CREATE TABLE "platform_access_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effect" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_access_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_access_rules_enabled_priority_idx" ON "platform_access_rules"("enabled", "priority");
