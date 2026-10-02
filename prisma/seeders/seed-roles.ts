import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

// Load .env.production if present, otherwise fallback to .env
const prodEnvPath = path.resolve(__dirname, '../../.env.production');
const devEnvPath = path.resolve(__dirname, '../../.env');

if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else if (fs.existsSync(prodEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
}

const prisma = new PrismaClient();

const ROLES = [
  {
    name: 'SUPER_ADMIN',
    description: 'Full system access and platform administration',
    isActive: true,
  },
  {
    name: 'ADMIN',
    description: 'Academic and operations administrator',
    isActive: true,
  },
  {
    name: 'STUDENT',
    description: 'Candidate taking tests and practice exams',
    isActive: true,
  },
  {
    name: 'INSTITUTION_ADMIN',
    description: 'Manager and administrator for partner institutions',
    isActive: true,
  },
  {
    name: 'OPERATOR',
    description: 'Content and question bank operator',
    isActive: true,
  },
  {
    name: 'ACCOUNTANT',
    description: 'Finance, billing, and transactions manager',
    isActive: true,
  },
  {
    name: 'MANAGER',
    description: 'Operational and management tasks',
    isActive: true,
  },
  {
    name: 'GENERAL_MANAGER',
    description: 'General management and operational oversight',
    isActive: true,
  },
];

const ROLES_TO_REMOVE = ['SALES_AGENT', 'PARENT'];

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🌱 SEEDING & CLEANING ROLES');
  console.log('════════════════════════════════════════════════════════════════\n');

  // 1. Remove unwanted roles
  for (const roleName of ROLES_TO_REMOVE) {
    const existing = await prisma.role.findUnique({ where: { name: roleName } });
    if (existing) {
      await prisma.userRole.deleteMany({ where: { roleId: existing.id } });
      await prisma.rolePermission.deleteMany({ where: { roleId: existing.id } });
      await prisma.role.delete({ where: { id: existing.id } });
      console.log(`  🗑️ Removed role: ${roleName}`);
    }
  }

  // 2. Upsert valid roles
  for (const role of ROLES) {
    const seededRole = await prisma.role.upsert({
      where: { name: role.name },
      update: {
        description: role.description,
        isActive: role.isActive,
      },
      create: {
        name: role.name,
        description: role.description,
        isActive: role.isActive,
      },
    });

    console.log(`  ✓ Role ready: ${seededRole.name} (ID: ${seededRole.id})`);
  }

  const allRoles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
  console.log(`\n✨ Active Roles in Database: ${allRoles.length}`);
  allRoles.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name}`);
  });
  console.log('\n✨ Roles updated successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Error updating roles:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
