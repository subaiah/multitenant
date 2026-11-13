-- CreateTable
CREATE TABLE "access_versions" (
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_versions_pkey" PRIMARY KEY ("tenant_id")
);

-- Added by hand (Prisma doesn't model triggers). Any change to who may do
-- what (roles, their permissions, assignments, groups, memberships,
-- delegations) moves the tenant's version on, whoever makes it and however:
-- the server keeps each person's permissions only for as long as the version
-- stands (middleware/authorize.ts).
--
-- The table is named through TG_TABLE_SCHEMA because the writer's search_path
-- need not include the tenant's schema. A writer with no tenant of its own
-- that is still subject to row-level security (the owner, in a migration) is
-- refused by the policy on access_versions: that is let go, and the time
-- limit on kept permissions covers it.
CREATE FUNCTION "bump_access_version"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  tid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    tid := OLD.tenant_id;
  ELSE
    tid := NEW.tenant_id;
  END IF;
  BEGIN
    EXECUTE format(
      'INSERT INTO %I.access_versions AS v (tenant_id, version, updated_at) VALUES ($1, 1, now())
         ON CONFLICT (tenant_id) DO UPDATE SET version = v.version + 1, updated_at = now()',
      TG_TABLE_SCHEMA
    ) USING tid;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER access_version_bump AFTER INSERT OR UPDATE OR DELETE ON "roles" FOR EACH ROW EXECUTE FUNCTION "bump_access_version"();
CREATE TRIGGER access_version_bump AFTER INSERT OR UPDATE OR DELETE ON "role_permissions" FOR EACH ROW EXECUTE FUNCTION "bump_access_version"();
CREATE TRIGGER access_version_bump AFTER INSERT OR UPDATE OR DELETE ON "role_assignments" FOR EACH ROW EXECUTE FUNCTION "bump_access_version"();
CREATE TRIGGER access_version_bump AFTER INSERT OR UPDATE OR DELETE ON "groups" FOR EACH ROW EXECUTE FUNCTION "bump_access_version"();
CREATE TRIGGER access_version_bump AFTER INSERT OR UPDATE OR DELETE ON "group_memberships" FOR EACH ROW EXECUTE FUNCTION "bump_access_version"();
CREATE TRIGGER access_version_bump AFTER INSERT OR UPDATE OR DELETE ON "delegations" FOR EACH ROW EXECUTE FUNCTION "bump_access_version"();
