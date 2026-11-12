import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('--- 180-QUESTION EXAM CREATION & VERIFICATION ---');

  // 1. Get Master Data
  const targetNeet = await prisma.examTarget.findFirst({ where: { name: 'NEET' } });
  if (!targetNeet) throw new Error('NEET exam target not found');

  const defaultStatus = await prisma.examStatus.findFirst({ where: { name: { in: ['DRAFT', 'PUBLISHED', 'SCHEDULED'] } } });
  const languages = await prisma.preferredLanguage.findMany({ where: { isActive: true } });
  const enLang = languages.find(l => (l.code || '').toLowerCase() === 'en');
  const regionalLangs = languages.filter(l => (l.code || '').toLowerCase() !== 'en');

  console.log(`Found ${languages.length} languages (${regionalLangs.length} regional target languages).`);

  // 2. Create the Exam
  const exam = await prisma.exam.create({
    data: {
      examCode: `NEET-180-${Date.now().toString().slice(-4)}`,
      title: 'NEET All-India Grand Mock Test 2026 (180 Questions)',
      description: 'Full 180-Question NEET paper across Physics (45), Chemistry (45), Botany (45), and Zoology (45).',
      duration: 200, // 200 minutes
      totalMarks: 720,
      passingMarks: 180,
      targetId: targetNeet.id,
      statusId: defaultStatus!.id,
      defaultMarksPerQuestion: 4,
      defaultNegativeMarks: 1,
      isLanguageSwitchAllowed: false,
    }
  });

  console.log(`Created Exam: ${exam.title} (ID: ${exam.id})`);

  // 3. Attach Languages to Exam (English + 8 Regional)
  for (let i = 0; i < languages.length; i++) {
    const l = languages[i];
    await prisma.examLanguage.create({
      data: {
        examId: exam.id,
        languageId: l.id,
        isDefault: l.code === 'en',
        displayOrder: i + 1,
      }
    });
  }

  // 4. Create Sections
  const subjects = await prisma.subject.findMany();
  const physSub = subjects.find(s => s.name.toLowerCase() === 'physics');
  const chemSub = subjects.find(s => s.name.toLowerCase() === 'chemistry');
  const bioSub = subjects.find(s => s.name.toLowerCase() === 'biology');

  const secPhysics = await prisma.examSection.create({
    data: { examId: exam.id, name: 'Physics', displayOrder: 1, subjectId: physSub?.id, totalQuestions: 45, maxQuestionsToAttempt: 45 }
  });
  const secChemistry = await prisma.examSection.create({
    data: { examId: exam.id, name: 'Chemistry', displayOrder: 2, subjectId: chemSub?.id, totalQuestions: 45, maxQuestionsToAttempt: 45 }
  });
  const secBotany = await prisma.examSection.create({
    data: { examId: exam.id, name: 'Botany', displayOrder: 3, subjectId: bioSub?.id, totalQuestions: 45, maxQuestionsToAttempt: 45 }
  });
  const secZoology = await prisma.examSection.create({
    data: { examId: exam.id, name: 'Zoology', displayOrder: 4, subjectId: bioSub?.id, totalQuestions: 45, maxQuestionsToAttempt: 45 }
  });

  console.log('Created 4 Sections: Physics, Chemistry, Botany, Zoology');

  // 5. Read CSV
  const csvPath = path.resolve(__dirname, '../../neet_180_questions_all_subjects.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const lines = csvContent.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows = lines.slice(1); // skip header

  console.log(`Read ${rows.length} rows from CSV.`);

  // 6. Ingest Questions in Batches
  for (let i = 0; i < rows.length; i++) {
    const qNum = i + 1;
    let secId = secPhysics.id;
    let subId = physSub?.id;
    if (qNum > 45 && qNum <= 90) { secId = secChemistry.id; subId = chemSub?.id; }
    else if (qNum > 90 && qNum <= 135) { secId = secBotany.id; subId = bioSub?.id; }
    else if (qNum > 135) { secId = secZoology.id; subId = bioSub?.id; }

    // Parse simple CSV values
    const parts = rows[i].split(',').map(s => s.replace(/^"|"$/g, '').trim());
    const qText = parts[1] || `NEET Question #${qNum}`;
    const optA = parts[2] || 'Option A';
    const optB = parts[3] || 'Option B';
    const optC = parts[4] || 'Option C';
    const optD = parts[5] || 'Option D';
    const ansKey = parts[6] || 'A';
    const expText = parts[13] || 'Detailed explanation';

    // Create Question
    const question = await prisma.question.create({
      data: {
        questionText: qText,
        subjectId: subId!,
        difficulty: 'MEDIUM',
        status: 'APPROVED',
        defaultMarks: 4,
        defaultNegativeMarks: 1,
        options: {
          create: [
            { optionKey: 'A', optionLabel: 'A', optionText: optA, displayOrder: 1, isCorrect: ansKey === 'A' },
            { optionKey: 'B', optionLabel: 'B', optionText: optB, displayOrder: 2, isCorrect: ansKey === 'B' },
            { optionKey: 'C', optionLabel: 'C', optionText: optC, displayOrder: 3, isCorrect: ansKey === 'C' },
            { optionKey: 'D', optionLabel: 'D', optionText: optD, displayOrder: 4, isCorrect: ansKey === 'D' },
          ]
        },
        translations: {
          create: [
            { languageId: enLang!.id, questionText: qText, explanation: expText }
          ]
        }
      },
      include: { options: true }
    });

    // Link options to English translation
    for (const opt of question.options) {
      await prisma.questionOptionTranslation.create({
        data: {
          optionId: opt.id,
          languageId: enLang!.id,
          optionText: opt.optionText || '',
        }
      });
    }

    // Link Question to Exam
    await prisma.examQuestion.create({
      data: {
        examId: exam.id,
        questionId: question.id,
        sectionId: secId,
        displayOrder: qNum,
        marks: 4,
        negativeMarks: 1,
      }
    });

    if (qNum % 45 === 0) {
      console.log(`Ingested ${qNum}/180 questions...`);
    }
  }

  // 7. Create Exam Version (version 1)
  const examVersion = await prisma.examVersion.create({
    data: {
      examId: exam.id,
      versionNumber: 1,
      snapshotData: {},
    }
  });

  // Populate ExamVersionQuestion and ExamVersionOption
  const examQuestions = await prisma.examQuestion.findMany({
    where: { examId: exam.id },
    include: { question: { include: { options: true } } },
    orderBy: { displayOrder: 'asc' }
  });

  for (const eq of examQuestions) {
    const evq = await prisma.examVersionQuestion.create({
      data: {
        examVersionId: examVersion.id,
        sourceQuestionId: eq.questionId,
        sequenceNumber: eq.displayOrder,
        marks: eq.marks,
        negativeMarks: eq.negativeMarks,
        sectionId: eq.sectionId,
        questionText: eq.question.questionText,
      }
    });

    for (const opt of eq.question.options) {
      await prisma.examVersionOption.create({
        data: {
          examVersionQuestionId: evq.id,
          sourceOptionId: opt.id,
          optionKey: opt.optionKey,
          optionLabel: opt.optionLabel,
          optionText: opt.optionText || '',
          isCorrect: opt.isCorrect,
          displayOrder: opt.displayOrder,
        }
      });
    }
  }

  // 8. Schedule the Exam for immediate student availability
  const now = new Date();
  const startTime = new Date(now.getTime() - 1000 * 60 * 5); // 5 mins ago
  const endTime = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days from now

  await prisma.examSchedule.create({
    data: {
      examId: exam.id,
      startTime,
      endTime,
      timezone: 'Asia/Kolkata',
      status: 'ACTIVE',
      instructions: 'Please select your preferred exam language before starting. Once the examination starts, the language is locked and cannot be changed during the test.',
    }
  });

  console.log(`\nSUCCESS! Exam "${exam.title}" scheduled and live!`);
  console.log(`Exam ID: ${exam.id}`);
  console.log(`Total Questions: ${examQuestions.length}`);
  console.log(`Available URL: http://localhost:3001/exams/${exam.id}/details`);
}

main().catch(console.error).finally(() => prisma.$disconnect());

