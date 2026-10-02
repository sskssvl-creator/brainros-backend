import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient, UserStatus, StudentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

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

interface TestAccount {
  phone: string;
  email: string;
  roles: string[];
  name: string;
  targetExamName?: string;
  className?: string;
  preferredLanguageCode?: string;
}

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('👤 SEEDING TEST USERS & ASSIGNING ROLES');
  console.log('════════════════════════════════════════════════════════════════\n');

  const passwordHash = await bcrypt.hash('Password@123', 10);

  // 1. Fetch existing Roles mapping
  const allRoles = await prisma.role.findMany();
  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));

  const testAccounts: TestAccount[] = [
    {
      phone: '+919000000000',
      email: 'superadmin@brainros.test',
      roles: ['SUPER_ADMIN'],
      name: 'Super Administrator',
    },
    {
      phone: '+919000000091',
      email: 'admin.neet@brainros.test',
      roles: ['ADMIN'],
      name: 'NEET Academic Admin',
    },
    {
      phone: '+918320982232',
      email: 'nilesh@brainros.test',
      roles: ['STUDENT'],
      name: 'Nilesh',
      targetExamName: 'JEE',
      className: 'Class 12',
      preferredLanguageCode: 'en',
    },
    {
      phone: '+919000000001',
      email: 'dhiraj@brainros.test',
      roles: ['STUDENT'],
      name: 'Dhiraj',
      targetExamName: 'NEET',
      className: 'Class 12',
      preferredLanguageCode: 'en',
    },
    {
      phone: '+919000000002',
      email: 'parthiv@brainros.test',
      roles: ['STUDENT'],
      name: 'Parthiv',
      targetExamName: 'CET',
      className: 'Class 12',
      preferredLanguageCode: 'en',
    },
    {
      phone: '+919000000081',
      email: 'inst.allen@brainros.test',
      roles: ['INSTITUTION_ADMIN'],
      name: 'Allen Institution Admin',
    },
    {
      phone: '+919000000098',
      email: 'operator01@brainros.test',
      roles: ['OPERATOR'],
      name: 'Test Operator',
    },
    {
      phone: '+919000000099',
      email: 'accountant01@brainros.test',
      roles: ['ACCOUNTANT'],
      name: 'Test Accountant',
    },
    {
      phone: '+919000000096',
      email: 'gm01@brainros.test',
      roles: ['GENERAL_MANAGER'],
      name: 'Test General Manager',
    },
  ];

  for (const acc of testAccounts) {
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: acc.phone },
          { mobileNumber: acc.phone },
          { email: acc.email },
        ],
      },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: acc.email,
          phone: acc.phone,
          mobileNumber: acc.phone,
          passwordHash,
          status: UserStatus.ACTIVE,
          isActive: true,
          isVerified: true,
          emailVerifiedAt: new Date(),
          mobileVerifiedAt: new Date(),
        },
      });
      console.log(`  ✓ Created user: ${acc.name} <${acc.email}> (${acc.phone})`);
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          phone: acc.phone,
          mobileNumber: acc.phone,
          isActive: true,
          status: UserStatus.ACTIVE,
          isVerified: true,
        },
      });
      console.log(`  ↻ Updated user: ${acc.name} <${acc.email}> (${acc.phone})`);
    }

    // Assign roles
    for (const rName of acc.roles) {
      const roleId = roleMap.get(rName);
      if (roleId) {
        await prisma.userRole.upsert({
          where: { userId_roleId: { userId: user.id, roleId } },
          update: {},
          create: { userId: user.id, roleId },
        });
      } else {
        console.warn(`  ⚠️ Role '${rName}' not found in database for user ${acc.email}`);
      }
    }

    // If student, ensure student profile & target exam
    if (acc.roles.includes('STUDENT')) {
      const existingStudent = await prisma.student.findUnique({
        where: { userId: user.id },
      });

      const targetName = acc.targetExamName || 'NEET';
      const className = acc.className || 'Class 12';
      const langCode = acc.preferredLanguageCode || 'en';

      const studentClass = await prisma.studentClass.findFirst({
        where: { name: className },
      }) || (await prisma.studentClass.findFirst());

      const examTarget = await prisma.examTarget.findFirst({
        where: { name: targetName },
      }) || (await prisma.examTarget.findFirst());

      const preferredLang = await prisma.preferredLanguage.findFirst({
        where: { code: langCode },
      }) || (await prisma.preferredLanguage.findFirst());

      if (studentClass && examTarget && preferredLang) {
        let student = existingStudent;

        if (!student) {
          student = await prisma.student.create({
            data: {
              userId: user.id,
              studentId: `STU${Math.floor(1000 + Math.random() * 9000)}`,
              studentCode: `BRN-2026-${Math.floor(100000 + Math.random() * 900000)}`,
              name: acc.name,
              state: 'Karnataka',
              district: 'Bengaluru Urban',
              schoolCollege: 'Delhi Public School',
              classId: studentClass.id,
              examTargetId: examTarget.id,
              preferredLanguageId: preferredLang.id,
              status: StudentStatus.ACTIVE,
            },
          });
        } else {
          student = await prisma.student.update({
            where: { id: student.id },
            data: {
              name: acc.name,
              classId: studentClass.id,
              examTargetId: examTarget.id,
              preferredLanguageId: preferredLang.id,
            },
          });
        }

        await prisma.studentExamTarget.upsert({
          where: {
            studentId_examTargetId: {
              studentId: student.id,
              examTargetId: examTarget.id,
            },
          },
          update: {
            isPrimary: true,
          },
          create: {
            studentId: student.id,
            examTargetId: examTarget.id,
            isPrimary: true,
          },
        });

        console.log(`    ↳ Student profile mapped: ${acc.name} ➔ Target: ${examTarget.name} | Class: ${studentClass.name} | Lang: ${preferredLang.name}`);
      }
    }
  }

  console.log('\n======================================================');
  console.log('TEST ACCOUNTS SUMMARY (ALL OTP: 12345 / Password@123):');
  console.log('======================================================');
  console.log('1. SUPER_ADMIN       : +919000000000 (superadmin@brainros.test)');
  console.log('2. ADMIN             : +919000000091 (admin.neet@brainros.test)');
  console.log('3. STUDENT (Nilesh)  : +918320982232 (nilesh@brainros.test) ➔ Target: JEE');
  console.log('4. STUDENT (Dhiraj)  : +919000000001 (dhiraj@brainros.test) ➔ Target: NEET');
  console.log('5. STUDENT (Parthiv) : +919000000002 (parthiv@brainros.test) ➔ Target: CET');
  console.log('6. INSTITUTION_ADMIN : +919000000081 (inst.allen@brainros.test)');
  console.log('7. OPERATOR          : +919000000098 (operator01@brainros.test)');
  console.log('8. ACCOUNTANT        : +919000000099 (accountant01@brainros.test)');
  console.log('9. GENERAL_MANAGER   : +919000000096 (gm01@brainros.test)');
  console.log('======================================================\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding users:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
