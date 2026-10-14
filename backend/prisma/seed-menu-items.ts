import { prisma } from '../src/lib/prisma.js';

async function seedMenuItems() {
  console.log('🌱 Seeding menu items...\n');

  try {
    // Check if menu items already exist
    const existingCount = await prisma.menuItem.count();
    if (existingCount > 0) {
      console.log(`⚠️  Found ${existingCount} existing menu items. Skipping seed.\n`);
      console.log('To reset menu items, run:');
      console.log('  npx prisma migrate reset\n');
      return;
    }

    // Platform Portal Menu Items
    console.log('📋 Creating Platform Portal menu items...');
    
    const platformDashboard = await prisma.menuItem.create({
      data: {
        portal: 'PLATFORM',
        label: 'Dashboard',
        path: '/platform/dashboard',
        icon: 'LayoutDashboard',
        order: 0,
        isActive: true,
      },
    });

    const platformTenants = await prisma.menuItem.create({
      data: {
        portal: 'PLATFORM',
        label: 'Tenants',
        path: '/platform/tenants',
        icon: 'Building2',
        permission: 'tenants:read',
        order: 1,
        isActive: true,
      },
    });

    const platformApplications = await prisma.menuItem.create({
      data: {
        portal: 'PLATFORM',
        label: 'Applications',
        path: '/platform/applications',
        icon: 'Package',
        permission: 'applications:read',
        order: 2,
        isActive: true,
      },
    });

    const platformUsers = await prisma.menuItem.create({
      data: {
        portal: 'PLATFORM',
        label: 'Platform Users',
        path: '/platform/users',
        icon: 'Users',
        permission: 'users:read',
        order: 3,
        isActive: true,
      },
    });

    const platformPolicies = await prisma.menuItem.create({
      data: {
        portal: 'PLATFORM',
        label: 'Global Policies',
        path: '/platform/policies',
        icon: 'Shield',
        permission: 'policies:read',
        order: 4,
        isActive: true,
      },
    });

    const platformSettings = await prisma.menuItem.create({
      data: {
        portal: 'PLATFORM',
        label: 'Settings',
        path: '/platform/settings',
        icon: 'Settings',
        permission: 'settings:read',
        order: 5,
        isActive: true,
      },
    });

    console.log('✅ Created 6 Platform menu items\n');

    // Tenant Portal Menu Items
    console.log('📋 Creating Tenant Portal menu items...');
    
    const tenantDashboard = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        label: 'Dashboard',
        path: '/dashboard',
        icon: 'LayoutDashboard',
        permission: 'tenant:read',
        order: 0,
        isActive: true,
      },
    });

    const tenantApplications = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        label: 'Applications',
        path: '/applications',
        icon: 'Package',
        permission: 'applications:read',
        order: 1,
        isActive: true,
      },
    });

    // Users submenu
    const tenantUsers = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        label: 'Users',
        path: '/users',
        icon: 'Users',
        permission: 'users:read',
        order: 2,
        isActive: true,
      },
    });

    const tenantUsersAll = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        parentId: tenantUsers.id,
        label: 'All Users',
        path: '/users',
        icon: 'Users',
        permission: 'users:read',
        order: 0,
        isActive: true,
      },
    });

    const tenantGroups = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        parentId: tenantUsers.id,
        label: 'Groups',
        path: '/groups',
        icon: 'Users',
        permission: 'groups:read',
        order: 1,
        isActive: true,
      },
    });

    const tenantRoles = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        parentId: tenantUsers.id,
        label: 'Role Assignments',
        path: '/role-assignments',
        icon: 'Shield',
        permission: 'roles:read',
        order: 2,
        isActive: true,
      },
    });

    const tenantOrganizations = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        label: 'Organizations',
        path: '/organizations',
        icon: 'Building2',
        permission: 'organizations:read',
        order: 3,
        isActive: true,
      },
    });

    const tenantActivity = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        label: 'Activity Log',
        path: '/activity',
        icon: 'Activity',
        permission: 'activities:read',
        order: 4,
        isActive: true,
      },
    });

    const tenantSettings = await prisma.menuItem.create({
      data: {
        portal: 'TENANT',
        label: 'Settings',
        path: '/settings',
        icon: 'Settings',
        permission: 'settings:read',
        order: 5,
        isActive: true,
      },
    });

    console.log('✅ Created 10 Tenant menu items (including 3 sub-items)\n');

    // Summary
    const totalMenuItems = await prisma.menuItem.count();
    const platformCount = await prisma.menuItem.count({ where: { portal: 'PLATFORM' } });
    const tenantCount = await prisma.menuItem.count({ where: { portal: 'TENANT' } });

    console.log('📊 Menu Items Summary:');
    console.log(`   Total: ${totalMenuItems}`);
    console.log(`   Platform: ${platformCount}`);
    console.log(`   Tenant: ${tenantCount}`);
    
    console.log('\n✅ Menu items seeded successfully!\n');
    console.log('Next steps:');
    console.log('1. Start the backend server: npm run dev');
    console.log('2. Test the menu API: GET /menu-items/portal/PLATFORM');
    console.log('3. Test the menu API: GET /menu-items/portal/TENANT');
    console.log('4. Manage menu items via API or create admin UI\n');

  } catch (error) {
    console.error('\n❌ Error seeding menu items:', error);
    throw error;
  }
}

// Run seed
seedMenuItems()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
