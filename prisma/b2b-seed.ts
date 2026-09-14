import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting B2B database initialization & backfill...');

  // 1. Ensure CET exists in exam_targets
  const cet = await prisma.examTarget.upsert({
    where: { name: 'CET' },
    update: {},
    create: {
      name: 'CET',
      description: 'Common Entrance Test (State CET)',
    },
  });
  console.log('✅ Exam Target CET ensured:', cet.id);

  // List all targets
  const targets = await prisma.examTarget.findMany();
  console.log('📋 Current Exam Targets:', targets.map((t) => `${t.name} (${t.id})`));

  // 2. Backfill existing students into student_exam_targets
  const students = await prisma.student.findMany({
    select: { id: true, examTargetId: true },
  });
  console.log(`🔍 Found ${students.length} existing students to check for exam targets.`);

  let createdCount = 0;
  for (const student of students) {
    if (student.examTargetId) {
      const existing = await prisma.studentExamTarget.findUnique({
        where: {
          studentId_examTargetId: {
            studentId: student.id,
            examTargetId: student.examTargetId,
          },
        },
      });

      if (!existing) {
        await prisma.studentExamTarget.create({
          data: {
            studentId: student.id,
            examTargetId: student.examTargetId,
            isPrimary: true,
          },
        });
        createdCount++;
      }
    }
  }
  console.log(`✅ Backfilled ${createdCount} student exam target mappings.`);

  // 3. Seed CET Subjects
  const cetSubjects = [
    { name: 'Physics (CET)', code: 'CET_PHY', displayOrder: 1 },
    { name: 'Chemistry (CET)', code: 'CET_CHEM', displayOrder: 2 },
    { name: 'Mathematics (CET)', code: 'CET_MATH', displayOrder: 3 },
    { name: 'Biology (CET)', code: 'CET_BIO', displayOrder: 4 },
  ];

  for (const s of cetSubjects) {
    const subj = await prisma.subject.upsert({
      where: {
        name: s.name,
      },
      update: {},
      create: {
        name: s.name,
        code: s.code,
        displayOrder: s.displayOrder,
        isActive: true,
      },
    });
    await prisma.examTargetSubject.upsert({
      where: { examTargetId_subjectId: { examTargetId: cet.id, subjectId: subj.id } },
      update: {},
      create: { examTargetId: cet.id, subjectId: subj.id },
    });
    console.log(`✅ CET Subject ensured: ${subj.name} (${subj.code})`);
  }

  // 4. Check existing institutions
  const schoolCount = await prisma.institution.count();
  console.log(`🏫 Current Institution / School count: ${schoolCount}`);
}

main()
  .catch((e) => {
    console.error('❌ Error during B2B seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
