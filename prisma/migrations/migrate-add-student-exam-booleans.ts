import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prodEnvPath = path.resolve(__dirname, '../../.env.production');
const devEnvPath = path.resolve(__dirname, '../../.env');

if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'production' && fs.existsSync(prodEnvPath)) {
    const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
    for (const k in envConfig) {
      process.env[k] = envConfig[k];
    }
  } else if (fs.existsSync(devEnvPath)) {
    dotenv.config({ path: devEnvPath });
  }
}

const prisma = new PrismaClient();

async function migrate() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🔄 MIGRATING STUDENTS TO INDEPENDENT JEE / CET / NEET BOOLEANS');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Step 1: Ensure columns exist on students table
  console.log('1. Adding jee, cet, neet boolean columns to students table if not exists...');
  await prisma.$executeRawUnsafe(`
    ALTER TABLE students 
    ADD COLUMN IF NOT EXISTS jee BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS cet BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS neet BOOLEAN NOT NULL DEFAULT false;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_students_jee ON students(jee);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_students_cet ON students(cet);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_students_neet ON students(neet);
  `);
  console.log('   ✓ Columns and indexes created successfully.');

  // Step 2: Ensure base target exam records exist
  console.log('2. Ensuring base ExamTarget records exist (JEE, CET, NEET)...');
  const baseTargets = [
    { name: 'JEE', description: 'Joint Entrance Examination (Engineering)' },
    { name: 'CET', description: 'Common Entrance Test (State Level)' },
    { name: 'NEET', description: 'National Eligibility cum Entrance Test (Medical)' },
  ];

  const targetMap = new Map<string, string>(); // 'JEE' -> UUID
  for (const bt of baseTargets) {
    const record = await prisma.examTarget.upsert({
      where: { name: bt.name },
      update: {},
      create: { name: bt.name, description: bt.description },
    });
    targetMap.set(bt.name, record.id);
  }

  // Step 3: Backfill existing students based on their current examTarget and studentExamTargets
  console.log('3. Backfilling existing students...');
  const students = await prisma.student.findMany({
    include: {
      examTarget: true,
      studentExamTargets: { include: { examTarget: true } },
    },
  });

  console.log(`   Found ${students.length} existing students to inspect.`);
  let updatedCount = 0;

  for (const student of students) {
    const targetNames: string[] = [];
    if (student.examTarget?.name) targetNames.push(student.examTarget.name);
    student.studentExamTargets.forEach((st) => {
      if (st.examTarget?.name) targetNames.push(st.examTarget.name);
    });

    const combined = targetNames.join(' ').toUpperCase();
    const hasJee = combined.includes('JEE');
    const hasNeet = combined.includes('NEET');
    const hasCet = combined.includes('CET');

    // If flags differ from current student record, update them
    if (student.jee !== hasJee || student.cet !== hasCet || student.neet !== hasNeet) {
      await prisma.student.update({
        where: { id: student.id },
        data: {
          jee: hasJee,
          cet: hasCet,
          neet: hasNeet,
        },
      });
      updatedCount++;
    }

    // Ensure StudentExamTarget rows exist for active flags
    if (hasJee && targetMap.get('JEE')) {
      await prisma.studentExamTarget.upsert({
        where: {
          studentId_examTargetId: {
            studentId: student.id,
            examTargetId: targetMap.get('JEE')!,
          },
        },
        update: {},
        create: {
          studentId: student.id,
          examTargetId: targetMap.get('JEE')!,
        },
      });
    }

    if (hasCet && targetMap.get('CET')) {
      await prisma.studentExamTarget.upsert({
        where: {
          studentId_examTargetId: {
            studentId: student.id,
            examTargetId: targetMap.get('CET')!,
          },
        },
        update: {},
        create: {
          studentId: student.id,
          examTargetId: targetMap.get('CET')!,
        },
      });
    }

    if (hasNeet && targetMap.get('NEET')) {
      await prisma.studentExamTarget.upsert({
        where: {
          studentId_examTargetId: {
            studentId: student.id,
            examTargetId: targetMap.get('NEET')!,
          },
        },
        update: {},
        create: {
          studentId: student.id,
          examTargetId: targetMap.get('NEET')!,
        },
      });
    }
  }

  console.log(`   ✓ Backfilled ${updatedCount} student records with canonical boolean flags.`);
  console.log('\n✅ Database migration completed successfully!\n');
}

migrate()
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
