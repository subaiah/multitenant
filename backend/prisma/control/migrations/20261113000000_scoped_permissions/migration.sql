-- Scoped permissions and units for applications (docs/hub/HUB_GAPS.md G7)
ALTER TABLE "product_member_states"
  ADD COLUMN "scoped_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "units" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "units_recorded" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tenant_applications" ADD COLUMN "units_state_hash" TEXT;
