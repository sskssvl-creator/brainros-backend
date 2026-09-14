/**
 * DEPRECATED: This script was used before the 4-global-subjects migration.
 * It referenced Subject.examTargetId which no longer exists in the schema.
 * The Subject master now uses ExamTargetSubject join table.
 * DO NOT RUN this script. It will fail at runtime.
 * See: backend/prisma/migrations/migrate-to-4-global-subjects.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  throw new Error(
    '[DEPRECATED] sync-3-exams.ts is no longer valid. The project uses 4 global subjects (Physics, Chemistry, Mathematics, Biology) via ExamTargetSubject mapping.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
