import { prisma } from '../src/lib/prisma.js';

async function migrateToPhase2() {
  console.log('🚀 Starting Phase 2 migration...\n');

  try {
    // 1. Create default applications if none exist
    console.log('📦 Checking for default applications...');
    const appCount = await prisma.applicationRegistry.count();
    
    if (appCount === 0) {
      console.log('   Creating default applications...');
      
      const defaultApps = [
        {
          key: 'admin-portal',
          name: 'Admin Portal',
          description: 'Platform administration and management interface',
          version: '1.0.0',
          status: 'ACTIVE',
        },
        {
          key: 'tenant-dashboard',
          name: 'Tenant Dashboard',
          description: 'Tenant-specific dashboard and management tools',
          version: '1.0.0',
          status: 'ACTIVE',
        },
        {
          key: 'api-gateway',
          name: 'API Gateway',
          description: 'Centralized API management and routing',
          version: '1.0.0',
          status: 'ACTIVE',
        },
      ];

      for (const app of defaultApps) {
        await prisma.applicationRegistry.create({
          data: app,
        });
      }
      
      console.log(`   ✅ Created ${defaultApps.length} default applications\n`);
    } else {
      console.log(`   ✓ Found ${appCount} existing applications\n`);
    }

    // 2. Create default permissions for applications
    console.log('🔐 Creating default permissions...');
    const permissionCount = await prisma.permission.count();
    
    if (permissionCount === 0) {
      const applications = await prisma.applicationRegistry.findMany();
      
      for (const app of applications) {
        const defaultPermissions = [
          { name: `${app.key}.read`, description: `Read ${app.name} data`, resource: app.key, action: 'read' },
          { name: `${app.key}.write`, description: `Write ${app.name} data`, resource: app.key, action: 'write' },
          { name: `${app.key}.admin`, description: `Administer ${app.name}`, resource: app.key, action: 'admin' },
        ];

        for (const perm of defaultPermissions) {
          await prisma.permission.create({
            data: {
              applicationId: app.id,
              ...perm,
            },
          });
        }
      }
      
      const totalPerms = applications.length * 3;
      console.log(`   ✅ Created ${totalPerms} default permissions\n`);
    } else {
      console.log(`   ✓ Found ${permissionCount} existing permissions\n`);
    }

    // 3. Create default organizations for tenants
    console.log('🏢 Creating default organizations for tenants...');
    const tenants = await prisma.tenant.findMany();
    let orgsCreated = 0;

    for (const tenant of tenants) {
      const orgCount = await prisma.organization.count({
        where: { tenantId: tenant.id },
      });

      if (orgCount === 0) {
        // Create main organization for tenant
        const org = await prisma.organization.create({
          data: {
            tenantId: tenant.id,
            name: `${tenant.name} Organization`,
            description: `Main organization for ${tenant.name}`,
            status: 'ACTIVE',
          },
        });

        // Create default org units
        const defaultUnits = [
          { name: 'Executive', unitType: 'DIVISION', description: 'Executive leadership' },
          { name: 'Engineering', unitType: 'DEPARTMENT', description: 'Engineering team' },
          { name: 'Sales', unitType: 'DEPARTMENT', description: 'Sales team' },
          { name: 'Marketing', unitType: 'DEPARTMENT', description: 'Marketing team' },
        ];

        for (const unit of defaultUnits) {
          await prisma.orgUnit.create({
            data: {
              tenantId: tenant.id,
              organizationId: org.id,
              ...unit,
            },
          });
        }

        orgsCreated++;
      }
    }

    if (orgsCreated > 0) {
      console.log(`   ✅ Created ${orgsCreated} organizations with default units\n`);
    } else {
      console.log(`   ✓ All tenants already have organizations\n`);
    }

    // 4. Enable default applications for all tenants
    console.log('📱 Enabling default applications for tenants...');
    const applications = await prisma.applicationRegistry.findMany();
    let entitlementsCreated = 0;

    for (const tenant of tenants) {
      for (const app of applications) {
        const existing = await prisma.tenantApplication.findFirst({
          where: {
            tenantId: tenant.id,
            applicationId: app.id,
          },
        });

        if (!existing) {
          await prisma.tenantApplication.create({
            data: {
              tenantId: tenant.id,
              applicationId: app.id,
              state: 'ENABLED',
              validFrom: new Date(),
            },
          });
          entitlementsCreated++;
        }
      }
    }

    if (entitlementsCreated > 0) {
      console.log(`   ✅ Created ${entitlementsCreated} tenant application entitlements\n`);
    } else {
      console.log(`   ✓ All tenants already have application entitlements\n`);
    }

    // 5. Summary
    console.log('📊 Migration Summary:');
    console.log(`   • Applications: ${await prisma.applicationRegistry.count()}`);
    console.log(`   • Permissions: ${await prisma.permission.count()}`);
    console.log(`   • Organizations: ${await prisma.organization.count()}`);
    console.log(`   • Org Units: ${await prisma.orgUnit.count()}`);
    console.log(`   • Org Memberships: ${await prisma.orgMembership.count()}`);
    console.log(`   • Tenant Applications: ${await prisma.tenantApplication.count()}`);
    
    console.log('\n✅ Phase 2 migration completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  }
}

// Run migration
migrateToPhase2()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
