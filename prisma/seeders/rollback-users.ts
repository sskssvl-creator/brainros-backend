import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

// Load .env.production if present, otherwise fallback to .env
const prodEnvPath = path.resolve(__dirname, '../../.env.production');
const devEnvPath = path.resolve(__dirname, '../../.env');

if (fs.existsSync(prodEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
}

const prisma = new PrismaClient();

const testEmails = [
  'superadmin@brainros.test',
  'admin.neet@brainros.test',
  'nilesh@brainros.test',
  'dhiraj@brainros.test',
  'parthiv@brainros.test',
  'student.dev@brainros.test',
  'student001@brainros.test',
  'inst.allen@brainros.test',
  'operator01@brainros.test',
  'accountant01@brainros.test',
  'gm01@brainros.test',
];

const testPhones = [
  '+919000000000',
  '+919000000091',
  '+918320982232',
  '+919000000001',
  '+919000000002',
  '+919000000081',
  '+919000000098',
  '+919000000099',
  '+919000000096',
];

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('⏪ ROLLING BACK SEEDED USERS');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Find all test users
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { in: testEmails } },
        { phone: { in: testPhones } },
        { mobileNumber: { in: testPhones } },
      ],
    },
    include: {
      student: true,
      userRoles: true,
    },
  });

  console.log(`Found ${users.length} seeded users to rollback.\n`);

  for (const u of users) {
    // If student, remove student_exam_targets & student profile
    if (u.student) {
      await prisma.studentExamTarget.deleteMany({
        where: { studentId: u.student.id },
      });
      await prisma.student.delete({
        where: { id: u.student.id },
      });
      console.log(`  ↳ Deleted student profile: ${u.student.name} (${u.student.studentId})`);
    }

    // Delete user roles
    await prisma.userRole.deleteMany({
      where: { userId: u.id },
    });

    // Delete user
    await prisma.user.delete({
      where: { id: u.id },
    });

    console.log(`  ✓ Removed user: ${u.email || u.phone}`);
  }

  // Also check if any orphaned users remain or if table is clean
  const remainingCount = await prisma.user.count();
  console.log(`\n✨ Rollback complete. Remaining users in database: ${remainingCount}\n`);
}

main()
  .catch((e) => {
    console.error('❌ Error during user rollback:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
