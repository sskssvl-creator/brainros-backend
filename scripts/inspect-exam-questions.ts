import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.production' });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: '.env' });
}


const connectionString = "postgresql://brainros:ezGiFsS3ZVaswPzhWCAobvGdp9lisiE7@dpg-dan18dp42hec73cr26d0-a.oregon-postgres.render.com/brainros";
process.env.DATABASE_URL = connectionString;
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);


async function main() {
  const examId = 'd500b151-d82f-45d0-b672-0b55e2d9c1cc';

  console.log(`Checking questions for exam: ${examId}`);

  const questions = await prisma.question.findMany({
    where: { examQuestions: { some: { examId } } },
    include: {
      options: true,
      translations: true,
    },
  });

  console.log(`Found ${questions.length} master questions.`);
  for (const q of questions) {
    console.log(`\n=== Master Q ${q.id} ===`);
    console.log('questionContent:', JSON.stringify((q as any).questionContent, null, 2));
    console.log('questionText (from translations):', q.translations.map((t) => ({ lang: t.languageId, text: t.questionText, content: (t as any).questionContent })));
    console.log('options:');
    for (const opt of q.options) {
      console.log(`  [${opt.optionKey}] text: "${opt.optionText}" | optionContent:`, JSON.stringify((opt as any).optionContent));
    }
  }

  const evQuestions = await prisma.examVersionQuestion.findMany({
    where: { examVersion: { examId } },
    include: {
      options: true,
      translations: true,
    },
  });

  console.log(`\nFound ${evQuestions.length} ExamVersionQuestions.`);
  for (const eq of evQuestions) {
    console.log(`\n=== EVQ ${eq.id} (seq: ${eq.sequenceNumber}) ===`);
    console.log('questionText:', eq.questionText);
    console.log('questionContent:', JSON.stringify((eq as any).questionContent, null, 2));
    console.log('options:');
    for (const opt of eq.options) {
      console.log(`  [${opt.optionKey}] text: "${opt.optionText}" | optionContent:`, JSON.stringify((opt as any).optionContent));
    }
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
