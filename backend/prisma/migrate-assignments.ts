import { prisma } from '../src/lib/prisma.js';

async function migrateExistingAssignments() {
  console.log('Starting migration of existing role assignments...');
  
  // Get all existing UserRole records
  const existingAssignments = await prisma.userRole.findMany({
    include: {
      user: true,
      role: true,
    },
  });
  
  console.log(`Found ${existingAssignments.length} existing assignments to migrate`);
  
  let migratedCount = 0;
  let skippedCount = 0;
  
  for (const assignment of existingAssignments) {
    // Check if this assignment already exists in RoleAssignment
    const existing = await prisma.roleAssignment.findFirst({
      where: {
        tenantId: assignment.user.tenantId || '',
        roleId: assignment.roleId,
        principalType: 'USER',
        userId: assignment.userId,
        scopeType: 'TENANT',
        scopeId: assignment.user.tenantId || '',
      },
    });
    
    if (existing) {
      console.log(`Skipping duplicate assignment for user ${assignment.userId}, role ${assignment.roleId}`);
      skippedCount++;
      continue;
    }
    
    // Create new RoleAssignment with TENANT scope
    await prisma.roleAssignment.create({
      data: {
        tenantId: assignment.user.tenantId || '',
        roleId: assignment.roleId,
        principalType: 'USER',
        userId: assignment.userId,
        groupId: null,
        scopeType: 'TENANT',
        scopeId: assignment.user.tenantId || '',
        validFrom: assignment.createdAt,
        validTo: null,
        status: 'ACTIVE',
      },
    });
    
    migratedCount++;
  }
  
  console.log(`Migration completed:`);
  console.log(`  - Migrated: ${migratedCount}`);
  console.log(`  - Skipped (duplicates): ${skippedCount}`);
  console.log(`  - Total processed: ${existingAssignments.length}`);
  
  // Optional: Delete old UserRole records after verification
  // Uncomment the following lines after verifying the migration
  /*
  console.log('\nDeleting old UserRole records...');
  const deleteResult = await prisma.userRole.deleteMany({});
  console.log(`Deleted ${deleteResult.count} old UserRole records`);
  */
}

migrateExistingAssignments()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
