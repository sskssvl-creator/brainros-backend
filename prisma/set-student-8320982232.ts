import { PrismaClient, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const phone = '+918320982232';
  const rawMobile = '8320982232';
  const email = 'student.8320982232@brainros.test';
  const password = 'Password@123';
  const passwordHash = await bcrypt.hash(password, 10);

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`🔧 SEEDING STUDENT USER: ${rawMobile} (Target: JEE)`);
  console.log(`════════════════════════════════════════════════════════════════\n`);

  // 1. Ensure STUDENT role exists
  const studentRole = await prisma.role.upsert({
    where: { name: 'STUDENT' },
    update: {},
    create: { name: 'STUDENT', description: 'Enrolled Examination Candidate' },
  });

  // 2. Find or Create User
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { phone },
        { mobileNumber: phone },
        { phone: rawMobile },
        { mobileNumber: rawMobile },
        { email },
      ],
    },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        phone,
        mobileNumber: phone,
        email,
        passwordHash,
        status: UserStatus.ACTIVE,
        isActive: true,
        isVerified: true,
        emailVerifiedAt: new Date(),
        mobileVerifiedAt: new Date(),
      },
    });
    console.log(`✓ Created User record: ${user.id} (${phone})`);
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        phone,
        mobileNumber: phone,
        passwordHash,
        status: UserStatus.ACTIVE,
        isActive: true,
        isVerified: true,
        mobileVerifiedAt: user.mobileVerifiedAt || new Date(),
      },
    });
    console.log(`✓ Updated User record: ${user.id} (${phone})`);
  }

  // 3. Assign STUDENT role
  await prisma.userRole.deleteMany({
    where: { userId: user.id },
  });

  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: studentRole.id,
    },
  });
  console.log(`✓ Assigned role 'STUDENT' to user`);

  // 4. Ensure master records for JEE Exam Target, Class, Language
  let jeeTarget = await prisma.examTarget.findFirst({
    where: {
      OR: [
        { name: 'JEE' },
        { name: 'JEE_MAIN' },
        { name: 'JEE (Main & Advanced)' },
        { name: { contains: 'JEE', mode: 'insensitive' } },
      ],
    },
  });

  if (!jeeTarget) {
    jeeTarget = await prisma.examTarget.create({
      data: {
        name: 'JEE',
        description: 'Joint Entrance Examination (Engineering)',
      },
    });
  }
  console.log(`✓ Using Target Exam: ${jeeTarget.name} (${jeeTarget.id})`);

  let targetClass = await prisma.studentClass.findFirst({
    where: {
      OR: [
        { name: 'Class 12' },
        { name: 'CLASS_12' },
        { name: { contains: '12' } },
      ],
    },
  });

  if (!targetClass) {
    targetClass = (await prisma.studentClass.findFirst()) || (await prisma.studentClass.create({
      data: { name: 'Class 12' },
    }));
  }

  let preferredLang = await prisma.preferredLanguage.findFirst({
    where: {
      OR: [{ code: 'en' }, { code: 'EN' }, { name: 'English' }],
    },
  });

  if (!preferredLang) {
    preferredLang = (await prisma.preferredLanguage.findFirst()) || (await prisma.preferredLanguage.create({
      data: { name: 'English', code: 'en' },
    }));
  }

  // 5. Ensure Student Profile exists and links to JEE
  const existingStudent = await prisma.student.findUnique({
    where: { userId: user.id },
  });

  let studentRecord;
  if (existingStudent) {
    studentRecord = await prisma.student.update({
      where: { id: existingStudent.id },
      data: {
        name: 'JEE Aspirant (8320982232)',
        status: 'ACTIVE',
        classId: targetClass.id,
        examTargetId: jeeTarget.id,
        preferredLanguageId: preferredLang.id,
        state: 'Gujarat',
        district: 'Ahmedabad',
        schoolCollege: 'Brainros JEE Academy',
      },
    });
    console.log(`✓ Updated Student Profile: Code=${studentRecord.studentCode}, ID=${studentRecord.studentId}`);
  } else {
    const studentIdStr = 'STU8320982232';
    const studentCode = 'BRN-2026-832098';

    studentRecord = await prisma.student.create({
      data: {
        userId: user.id,
        studentId: studentIdStr,
        studentCode,
        name: 'JEE Aspirant (8320982232)',
        state: 'Gujarat',
        district: 'Ahmedabad',
        schoolCollege: 'Brainros JEE Academy',
        classId: targetClass.id,
        examTargetId: jeeTarget.id,
        preferredLanguageId: preferredLang.id,
        status: 'ACTIVE',
      },
    });
    console.log(`✓ Created Student Profile: Code=${studentRecord.studentCode}, ID=${studentRecord.studentId}`);
  }

  // 6. Link in student_exam_targets table if it exists
  const existingSet = await prisma.studentExamTarget.findFirst({
    where: {
      studentId: studentRecord.id,
      examTargetId: jeeTarget.id,
    },
  });

  if (!existingSet) {
    await prisma.studentExamTarget.create({
      data: {
        studentId: studentRecord.id,
        examTargetId: jeeTarget.id,
        isPrimary: true,
      },
    });
    console.log(`✓ Linked StudentExamTarget mapping`);
  }

  // 7. Verify all details
  const verifiedUser = await prisma.user.findUnique({
    where: { id: user.id },
    include: {
      userRoles: { include: { role: true } },
      student: {
        include: {
          examTarget: true,
          studentClass: true,
          preferredLanguage: true,
        },
      },
    },
  });

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`🎉 STUDENT USER READY FOR LOGIN`);
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`- Mobile / Login Number: 8320982232 (or +918320982232)`);
  console.log(`- Email: ${verifiedUser?.email}`);
  console.log(`- Password: Password@123 (or via OTP)`);
  console.log(`- Role: ${verifiedUser?.userRoles.map((ur) => ur.role.name).join(', ')}`);
  console.log(`- Student Name: ${verifiedUser?.student?.name}`);
  console.log(`- Target Exam: ${verifiedUser?.student?.examTarget?.name}`);
  console.log(`- Class: ${verifiedUser?.student?.studentClass?.name}`);
  console.log(`- Student Code: ${verifiedUser?.student?.studentCode}`);
  console.log(`════════════════════════════════════════════════════════════════\n`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding student user:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
