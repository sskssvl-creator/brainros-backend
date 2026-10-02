import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { extractPlainText } from '../src/common/utils/rich-content-text-extractor';
import { buildTranslatedRichDoc } from '../src/common/utils/rich-content-validator';

const connectionString = "postgresql://brainros:ezGiFsS3ZVaswPzhWCAobvGdp9lisiE7@dpg-dan18dp42hec73cr26d0-a.oregon-postgres.render.com/brainros";
process.env.DATABASE_URL = connectionString;
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

async function test() {
  const examId = 'd500b151-d82f-45d0-b672-0b55e2d9c4cc';
  console.log(`Testing rich question update for exam: ${examId}`);

  // Sample rich content with Cloudinary diagram images
  const sampleQ1RichContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'In the circuit shown in the figure, the current through the circuit branch is:' }
        ]
      },
      {
        type: 'image',
        attrs: {
          src: 'https://res.cloudinary.com/brainros/image/upload/v1727800000/sample_circuit.png',
          alt: 'Circuit Diagram'
        }
      }
    ]
  };

  const sampleQ2OptARichContent = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'https://res.cloudinary.com/brainros/image/upload/v1727800000/graph_a.png',
          alt: 'Graph A'
        }
      }
    ]
  };

  const sampleQ2OptBRichContent = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'https://res.cloudinary.com/brainros/image/upload/v1727800000/graph_b.png',
          alt: 'Graph B'
        }
      }
    ]
  };

  const sampleQ2OptCRichContent = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'https://res.cloudinary.com/brainros/image/upload/v1727800000/graph_c.png',
          alt: 'Graph C'
        }
      }
    ]
  };

  const sampleQ2OptDRichContent = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'https://res.cloudinary.com/brainros/image/upload/v1727800000/graph_d.png',
          alt: 'Graph D'
        }
      }
    ]
  };

  // Find ExamVersionQuestions for this exam
  const evQuestions = await prisma.examVersionQuestion.findMany({
    where: { examVersion: { examId } },
    include: { options: true, translations: true },
    orderBy: { sequenceNumber: 'asc' },
  });

  if (evQuestions.length >= 2) {
    console.log('Updating Question 1 with circuit diagram image...');
    await prisma.examVersionQuestion.update({
      where: { id: evQuestions[0].id },
      data: { questionContent: sampleQ1RichContent as any },
    });
    if (evQuestions[0].sourceQuestionId) {
      await prisma.question.update({
        where: { id: evQuestions[0].sourceQuestionId },
        data: { questionContent: sampleQ1RichContent as any },
      });
    }

    console.log('Updating Question 2 options with graph images...');
    const q2Options = evQuestions[1].options;
    const optRich = {
      A: sampleQ2OptARichContent,
      B: sampleQ2OptBRichContent,
      C: sampleQ2OptCRichContent,
      D: sampleQ2OptDRichContent,
    };

    for (const opt of q2Options) {
      const rich = (optRich as any)[opt.optionKey];
      if (rich) {
        await prisma.examVersionOption.update({
          where: { id: opt.id },
          data: { optionContent: rich as any },
        });
        if (opt.sourceOptionId) {
          await prisma.questionOption.update({
            where: { id: opt.sourceOptionId },
            data: { optionContent: rich as any },
          });
        }
      }
    }

    console.log('SUCCESS! Updated exam questions with rich diagrams.');
  }

  await prisma.$disconnect();
  await pool.end();
}

test().catch(console.error);
