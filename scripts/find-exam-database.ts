import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

async function checkDb(name: string, url: string) {
  console.log(`\n=================== Checking ${name} ===================`);
  try {
    const pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter } as any);

    const exams = await prisma.exam.findMany({
      select: { id: true, title: true },
    });

    console.log(`Total exams found: ${exams.length}`);
    for (const e of exams) {
      console.log(`Exam: ${e.id} | ${e.title}`);
    }

    const examId = 'd500b151-d82f-45d0-b672-0b55e2d9c4cc';

    const targetExam = exams.find((e) => e.id === examId);
    if (targetExam) {
      console.log(`>>> Found target exam ${examId} in ${name}!`);
      const questions = await prisma.question.findMany({
        where: { examQuestions: { some: { examId } } },
        include: { options: true, translations: true },
      });
      console.log(`Found ${questions.length} master questions:`);
      for (const q of questions) {
        console.log(`- Q ID: ${q.id} | type: ${q.type}`);
        console.log(`  questionContent:`, JSON.stringify((q as any).questionContent));
        for (const opt of q.options) {
          console.log(`  Opt [${opt.optionKey}]: "${opt.optionText}" | optionContent:`, JSON.stringify((opt as any).optionContent));
        }
      }

      const evQuestions = await prisma.examVersionQuestion.findMany({
        where: { examVersion: { examId } },
        include: { options: true, translations: true },
      });
      console.log(`Found ${evQuestions.length} ExamVersionQuestions:`);
      for (const eq of evQuestions) {
        console.log(`- EVQ ID: ${eq.id} | seq: ${eq.sequenceNumber} | text: "${eq.questionText}"`);
        console.log(`  questionContent:`, JSON.stringify((eq as any).questionContent));
        for (const opt of eq.options) {
          console.log(`  Opt [${opt.optionKey}]: "${opt.optionText}" | optionContent:`, JSON.stringify((opt as any).optionContent));
        }
      }
    }

    await prisma.$disconnect();
    await pool.end();
  } catch (err: any) {
    console.error(`Error in ${name}:`, err.message);
  }
}

async function main() {
  await checkDb('Render Postgres (.env.production)', 'postgresql://brainros:ezGiFsS3ZVaswPzhWCAobvGdp9lisiE7@dpg-dan18dp42hec73cr26d0-a.oregon-postgres.render.com/brainros');
  await checkDb('Local Postgres', 'postgresql://postgres:root@localhost:5432/exam_management?schema=public');
  await checkDb('Aiven Cloud Postgres (.env)', 'postgres://avnadmin:AVNS_8h7hzF5RtkY24dbwhp8@exam-mangment-platform-exam-management-platform.f.aivencloud.com:20139/defaultdb?sslmode=require');
}

main().catch(console.error);
