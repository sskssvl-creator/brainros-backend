import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { buildTranslatedRichDoc } from '../src/common/utils/rich-content-validator';

const connectionString = "postgresql://brainros:ezGiFsS3ZVaswPzhWCAobvGdp9lisiE7@dpg-dan18dp42hec73cr26d0-a.oregon-postgres.render.com/brainros";
process.env.DATABASE_URL = connectionString;
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

async function test() {
  const examId = 'd500b151-d82f-45d0-b672-0b55e2d9c4cc';
  
  const job = await prisma.aiTranslationJob.findFirst({
    where: { examId },
    orderBy: { createdAt: 'desc' },
  });

  if (!job) {
    console.log('No AI translation job found for exam.');
    return;
  }

  console.log(`Found AI Translation Job: ${job.id}`);

  // Fetch using the exact logic in AiTranslationService.getJobQuestions
  const evQuestions = await prisma.examVersionQuestion.findMany({
    where: { examVersionId: job.examVersionId },
    include: {
      options: {
        include: {
          translations: true,
        },
        orderBy: { displayOrder: 'asc' },
      },
      translations: true,
    },
    orderBy: { sequenceNumber: 'asc' },
  });

  console.log(`Fetched ${evQuestions.length} questions.`);
  for (const q of evQuestions) {
    console.log(`\n================ Question ${q.sequenceNumber} ================`);
    console.log(`questionText: "${q.questionText}"`);
    console.log(`questionContent:`, JSON.stringify((q as any).questionContent, null, 2));
    console.log('Options:');
    for (const opt of q.options) {
      console.log(`  [${opt.optionKey}]: text="${opt.optionText}" | optionContent:`, JSON.stringify((opt as any).optionContent, null, 2));
    }
  }

  await prisma.$disconnect();
  await pool.end();
}

test().catch(console.error);
