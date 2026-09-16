import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TARGETS = [
  { name: 'JEE', description: 'Joint Entrance Examination (Engineering)' },
  { name: 'CET', description: 'Common Entrance Test (State Level)' },
  { name: 'NEET', description: 'National Eligibility cum Entrance Test (Medical)' },
  { name: 'NEET + JEE', description: 'NEET and JEE Combo' },
  { name: 'NEET + State CET', description: 'NEET and State CET Combo' },
  { name: 'JEE + State CET', description: 'JEE and State CET Combo' },
  { name: 'JEE + NEET + State CET', description: 'JEE, NEET and State CET All-in-One Combo' },
];

// Mapping of legacy names to canonical names
const LEGACY_MAPPING: Record<string, string> = {
  'NEET and JEE': 'NEET + JEE',
  'NEET and State CET': 'NEET + State CET',
  'JEE and State CET': 'JEE + State CET',
  'JEE, NEET and State CET': 'JEE + NEET + State CET',
};

async function main() {
  console.log('🔄 Syncing Canonical Target Exams in database...');

  // 1. Rename any legacy combo targets if present
  for (const [legacyName, canonicalName] of Object.entries(LEGACY_MAPPING)) {
    const legacy = await prisma.examTarget.findUnique({ where: { name: legacyName } });
    if (legacy) {
      const canonicalExisting = await prisma.examTarget.findUnique({ where: { name: canonicalName } });
      if (canonicalExisting) {
        // Migrate students/exams from legacy to canonical
        await prisma.student.updateMany({
          where: { examTargetId: legacy.id },
          data: { examTargetId: canonicalExisting.id },
        });
        await prisma.studentExamTarget.deleteMany({
          where: { examTargetId: legacy.id },
        });
        await prisma.exam.updateMany({
          where: { examTargetId: legacy.id },
          data: { examTargetId: canonicalExisting.id },
        });
        await prisma.examTarget.delete({ where: { id: legacy.id } });
        console.log(`  ✓ Merged legacy target '${legacyName}' into '${canonicalName}'`);
      } else {
        await prisma.examTarget.update({
          where: { id: legacy.id },
          data: { name: canonicalName },
        });
        console.log(`  ✓ Renamed legacy target '${legacyName}' to '${canonicalName}'`);
      }
    }
  }

  // 2. Upsert all 7 canonical targets
  for (const target of TARGETS) {
    const upserted = await prisma.examTarget.upsert({
      where: { name: target.name },
      update: { description: target.description },
      create: { name: target.name, description: target.description },
    });
    console.log(`- [${upserted.id}] ${upserted.name}`);
  }

  // 3. Clean up obsolete CAT target if 0 students/exams attached
  const cat = await prisma.examTarget.findUnique({ where: { name: 'CAT' } });
  if (cat) {
    const studentCount = await prisma.student.count({ where: { examTargetId: cat.id } });
    const examCount = await prisma.exam.count({ where: { examTargetId: cat.id } });
    if (studentCount === 0 && examCount === 0) {
      await prisma.examTargetSubject.deleteMany({ where: { examTargetId: cat.id } });
      await prisma.examTarget.delete({ where: { id: cat.id } });
      console.log(`  ✓ Removed obsolete unused target 'CAT'`);
    }
  }

  const allTargets = await prisma.examTarget.findMany({ orderBy: { name: 'asc' } });
  console.log('\nTotal Exam Targets in DB:', allTargets.length);
  for (const t of allTargets) {
    console.log(`- ${t.name} (${t.id})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
