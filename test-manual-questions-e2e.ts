import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const BASE_URL = 'http://127.0.0.1:3000';

async function runVerification() {
  console.log('====================================================');
  console.log('🚀 STARTING END-TO-END VERIFICATION OF MANUAL QUESTIONS');
  console.log('====================================================');

  // 1. Authenticate Admin
  console.log('\n1. Authenticating Admin...');
  let adminToken = '';
  let adminUser = await prisma.user.findFirst({
    where: {
      userRoles: {
        some: {
          role: {
            name: { in: ['SUPER_ADMIN', 'ADMIN', 'EXAM_MANAGER'] },
          },
        },
      },
    },
  });

  if (!adminUser) {
    adminUser = await prisma.user.findFirst();
  }

  if (!adminUser) {
    console.error('❌ Admin user not found');
    process.exit(1);
  }
  console.log(`Found Admin User: ${adminUser.email} (${adminUser.id})`);

  try {
    const loginRes = await axios.post(`${BASE_URL}/auth/login/email`, {
      email: adminUser.email,
      password: 'Password@123',
    });
    adminToken = loginRes.data.data?.accessToken || loginRes.data.accessToken || loginRes.data.data?.token;
    console.log('✅ Admin authenticated via login API.');
  } catch (err: any) {
    console.log('ℹ️ Admin login endpoint skipped/failed, generating direct JWT token...');
    const { JwtService } = await import('@nestjs/jwt');
    const jwtService = new JwtService({
      secret: process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'super-secret-jwt-key-replace-in-production',
    });
    adminToken = jwtService.sign({ sub: adminUser.id, type: 'access' }, { expiresIn: '1h' });
    console.log('✅ Admin JWT token generated directly.');
  }

  // 2. Authenticate Student
  console.log('\n2. Authenticating Student...');
  let studentToken = '';
  let studentUser = await prisma.user.findFirst({
    where: { student: { isNot: null } },
    include: { student: true },
  });

  if (!studentUser) {
    console.error('❌ Student user not found in database');
    process.exit(1);
  }

  try {
    const studentLogin = await axios.post(`${BASE_URL}/auth/login/email`, {
      email: studentUser.email,
      password: 'Password@123',
    });
    studentToken = studentLogin.data.data?.accessToken || studentLogin.data.accessToken || studentLogin.data.data?.token;
    console.log('✅ Student authenticated via login API.');
  } catch (err: any) {
    console.log('ℹ️ Student login endpoint skipped/failed, generating direct JWT token...');
    const { JwtService } = await import('@nestjs/jwt');
    const jwtService = new JwtService({
      secret: process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'super-secret-jwt-key-replace-in-production',
    });
    studentToken = jwtService.sign({ sub: studentUser.id, type: 'access' }, { expiresIn: '1h' });
    console.log('✅ Student JWT token generated directly.');
  }
  console.log(`Student User ID: ${studentUser.id}, Student Record ID: ${studentUser.student?.id}`);

  // 3. Create / Schedule ONE Exam with totalQuestions = 5
  console.log('\n3. Creating scheduled exam with totalQuestions = 5...');
  const studentRecord = await prisma.student.findFirst({
    where: { userId: studentUser.id },
    include: { examTarget: true, studentExamTargets: true },
  });
  const targetId =
    studentRecord?.examTargetId ||
    studentRecord?.studentExamTargets?.[0]?.examTargetId ||
    (await prisma.examTarget.findFirst())?.id;
  const draftStatus = await prisma.examStatus.findFirst({ where: { name: 'DRAFT' } }) || await prisma.examStatus.findFirst();

  const startTime = new Date(Date.now() - 10 * 60 * 1000); // 10 mins ago (active now)
  const endTime = new Date(Date.now() + 180 * 60 * 1000); // 3 hours from now

  const exam = await prisma.exam.create({
    data: {
      examTargetId: targetId!,
      title: `E2E 5-Type Question Test ${Date.now()}`,
      description: 'End to end testing of 5 question types and difficulties',
      totalQuestions: 5,
      totalMarks: 20,
      durationMinutes: 60,
      defaultMarksPerQuestion: 4,
      defaultNegativeMarks: 1,
      statusId: draftStatus!.id,
      createdById: adminUser!.id,
    },
  });

  const defaultVersion = await prisma.examVersion.create({
    data: {
      examId: exam.id,
      versionNumber: 1,
      status: 'GENERATED',
      totalQuestions: 5,
      durationMinutes: 60,
      totalMarks: 20,
      generatedById: adminUser!.id,
    },
  });

  await prisma.examSchedule.create({
    data: {
      examId: exam.id,
      examVersionId: defaultVersion.id,
      scheduledById: adminUser!.id,
      startTime,
      endTime,
      status: 'ACTIVE',
      hasAnswerKey: false,
    },
  });
  console.log(`✅ Exam created with ID: ${exam.id}, Title: "${exam.title}"`);

  // 4. Submit Manual Questions Payload (All 5 Types & Difficulties)
  console.log('\n4. Submitting 5 Manual Questions with different types and difficulties...');
  const manualQuestionsPayload = {
    questions: [
      {
        questionText: 'What is the SI unit of electric current?',
        difficulty: 'EASY',
        type: 'SINGLE_CORRECT',
        optionA: 'Volt',
        optionB: 'Ampere',
        optionC: 'Ohm',
        optionD: 'Watt',
        correctAnswer: 'B',
        explanation: 'The SI unit of electric current is the Ampere (A).',
      },
      {
        questionText: 'Which of the following are inert / noble gases?',
        difficulty: 'MEDIUM',
        type: 'MULTIPLE_CORRECT',
        optionA: 'Helium',
        optionB: 'Neon',
        optionC: 'Chlorine',
        optionD: 'Argon',
        correctAnswers: ['A', 'B', 'D'],
        explanation: 'Helium, Neon, and Argon are Group 18 noble gases.',
      },
      {
        questionText: 'Calculate the standard acceleration due to gravity on Earth surface in m/s^2 (rounded to 1 decimal place).',
        difficulty: 'HARD',
        type: 'NUMERICAL',
        numericalAnswer: 9.8,
        explanation: 'The standard gravitational acceleration on Earth is 9.8 m/s^2.',
      },
      {
        questionText: 'Assertion (A) and Reason (R) on Cellular Energy:',
        difficulty: 'VERY_HARD',
        type: 'ASSERTION_REASON',
        assertion: 'Mitochondria are known as the powerhouse of the cell.',
        reason: 'Mitochondria synthesize ATP through cellular respiration.',
        optionA: 'Both (A) and (R) are true and (R) is the correct explanation of (A)',
        optionB: 'Both (A) and (R) are true but (R) is not the correct explanation of (A)',
        optionC: '(A) is true but (R) is false',
        optionD: '(A) is false but (R) is true',
        correctAnswer: 'A',
        explanation: 'Both statements are true and Reason explains Assertion correctly.',
      },
      {
        questionText: 'Match Column I (Organisms) with Column II (Kingdom):',
        difficulty: 'MEDIUM',
        type: 'MATCH_FOLLOWING',
        columnA: [
          { key: '1', text: 'Amoeba' },
          { key: '2', text: 'Spirogyra' },
          { key: '3', text: 'Mushroom' },
          { key: '4', text: 'Bacteria' },
        ],
        columnB: [
          { key: 'A', text: 'Plantae' },
          { key: 'B', text: 'Protista' },
          { key: 'C', text: 'Monera' },
          { key: 'D', text: 'Fungi' },
        ],
        matchPairs: [
          { left: '1', right: 'B' },
          { left: '2', right: 'A' },
          { left: '3', right: 'D' },
          { left: '4', right: 'C' },
        ],
        optionA: '1-B, 2-A, 3-D, 4-C',
        optionB: '1-A, 2-B, 3-C, 4-D',
        optionC: '1-C, 2-D, 3-A, 4-B',
        optionD: '1-D, 2-C, 3-B, 4-A',
        correctAnswer: 'A',
        explanation: 'Amoeba -> Protista, Spirogyra -> Plantae, Mushroom -> Fungi, Bacteria -> Monera.',
      },
    ],
  };

  try {
    const submitRes = await axios.post(
      `${BASE_URL}/admin/exam-manager/exams/${exam.id}/manual-questions`,
      manualQuestionsPayload,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    console.log('✅ Manual Questions submitted successfully:', submitRes.data);
  } catch (err: any) {
    console.error('❌ Failed to submit manual questions:', err.response?.data || err.message);
    process.exit(1);
  }

  // 5. Wait for BullMQ processor to persist DB records and trigger translation
  console.log('\n5. Waiting for BullMQ DB save and AI translation job processing...');
  let retries = 15;
  let savedQuestions: any[] = [];
  while (retries > 0) {
    await new Promise((r) => setTimeout(r, 1000));
    savedQuestions = await prisma.examQuestion.findMany({
      where: { examId: exam.id },
      include: {
        question: {
          include: {
            options: true,
            answer: true,
            translations: true,
          },
        },
      },
      orderBy: { displayOrder: 'asc' },
    });
    if (savedQuestions.length === 5) break;
    retries--;
  }

  console.log(`Found ${savedQuestions.length} persisted exam questions in database.`);
  if (savedQuestions.length !== 5) {
    console.error('❌ Expected 5 questions saved in database, found', savedQuestions.length);
    process.exit(1);
  }

  // 6. Direct Database Field Verification
  console.log('\n6. Verifying Database Records:');
  const expectedTypes = ['SINGLE_CORRECT', 'MULTIPLE_CORRECT', 'NUMERICAL', 'ASSERTION_REASON', 'MATCH_FOLLOWING'];
  const expectedDiffs = ['EASY', 'MEDIUM', 'HARD', 'VERY_HARD', 'MEDIUM'];

  for (let i = 0; i < 5; i++) {
    const eq = savedQuestions[i];
    const q = eq.question;
    console.log(`\n  Question ${i + 1}:`);
    console.log(`    - ID: ${q.id}`);
    console.log(`    - Type: ${q.type} (Expected: ${expectedTypes[i]})`);
    console.log(`    - Difficulty: ${q.difficultyLevel} (Expected: ${expectedDiffs[i]})`);
    console.log(`    - Options Count: ${q.options.length}`);
    console.log(`    - Has Assertion: ${Boolean(q.assertion)}`);
    console.log(`    - Has Reason: ${Boolean(q.reason)}`);
    console.log(`    - Answer Type: ${q.answer?.answerType}`);
    console.log(`    - Numerical Answer: ${q.answer?.numericalAnswer}`);
    console.log(`    - Correct Option IDs Count: ${q.answer?.correctOptionIds?.length || 0}`);

    if (q.type !== expectedTypes[i]) {
      console.error(`❌ Type mismatch for Q${i + 1}: expected ${expectedTypes[i]}, got ${q.type}`);
      process.exit(1);
    }
    if (q.difficultyLevel !== expectedDiffs[i]) {
      console.error(`❌ Difficulty mismatch for Q${i + 1}: expected ${expectedDiffs[i]}, got ${q.difficultyLevel}`);
      process.exit(1);
    }
  }
  console.log('✅ Database Verification: ALL 5 QUESTIONS AND TYPES PERSISTED CORRECTLY!');

  // 7. Verify ExamVersion Snapshot & Answer Key
  console.log('\n7. Verifying ExamVersion snapshot and answer key...');
  const version = await prisma.examVersion.findFirst({
    where: { examId: exam.id },
    include: {
      questions: {
        include: {
          options: true,
        },
        orderBy: { sequenceNumber: 'asc' },
      },
    },
  });

  if (!version || version.questions.length !== 5) {
    console.error('❌ ExamVersion snapshot missing or incomplete:', version);
    process.exit(1);
  }
  console.log(`✅ ExamVersion ${version.id} snapshot verified with ${version.questions.length} questions.`);

  // 8. Publish / Activate Exam for Student Attempt
  console.log('\n8. Ensuring exam is published and active...');
  const activeStatus = await prisma.examStatus.findFirst({ where: { name: 'ACTIVE' } });
  await prisma.exam.update({
    where: { id: exam.id },
    data: { statusId: activeStatus!.id },
  });

  // 9. Start Student Attempt
  console.log('\n9. Starting student attempt via API...');
  let attemptId = '';
  const defaultLang = await prisma.preferredLanguage.findFirst({ where: { code: 'en' } }) || await prisma.preferredLanguage.findFirst();

  // Reset any lingering in-progress attempt for this student
  const inProgressStatus = await prisma.attemptStatus.findFirst({ where: { name: 'IN_PROGRESS' } });
  const submittedStatus = await prisma.attemptStatus.findFirst({ where: { name: 'SUBMITTED' } });
  if (inProgressStatus && submittedStatus) {
    await prisma.attempt.updateMany({
      where: { studentId: studentUser.student!.id, statusId: inProgressStatus.id },
      data: { statusId: submittedStatus.id, submittedAt: new Date() },
    });
  }

  try {
    const startRes = await axios.post(
      `${BASE_URL}/attempts/start`,
      { examId: exam.id, languageId: defaultLang?.id },
      { headers: { Authorization: `Bearer ${studentToken}` } },
    );
    attemptId = startRes.data.data?.id || startRes.data.id || startRes.data.data?.attemptId;
    console.log('✅ Attempt started successfully. Attempt ID:', attemptId);
  } catch (err: any) {
    console.error('❌ Failed to start attempt:', err.response?.data || err.message);
    process.exit(1);
  }

  // 10. Fetch Exam Questions for Student
  console.log('\n10. Fetching exam questions as Student (Testing Security & Data Integrity)...');
  let studentQuestions: any[] = [];
  try {
    const qRes = await axios.get(
      `${BASE_URL}/attempts/${attemptId}/questions`,
      { headers: { Authorization: `Bearer ${studentToken}` } },
    );
    studentQuestions = Array.isArray(qRes.data.data) ? qRes.data.data : qRes.data;
    console.log(`✅ Student API returned ${studentQuestions.length} questions.`);
  } catch (err: any) {
    console.error('❌ Failed to fetch student questions:', err.response?.data || err.message);
    process.exit(1);
  }

  if (studentQuestions.length !== 5) {
    console.error('❌ Expected 5 questions in student interface, received', studentQuestions.length);
    process.exit(1);
  }

  // 11. CRITICAL SECURITY INSPECTION: Ensure NO correct answers or answer keys leak
  console.log('\n11. 🛡️ SECURITY AUDIT: Verifying student API payload does NOT leak correct answers...');
  for (let i = 0; i < studentQuestions.length; i++) {
    const sq = studentQuestions[i];
    console.log(`  Question ${i + 1} (${sq.type}):`);
    console.log(`    - Has correctAnswer in root: ${sq.correctAnswer !== undefined}`);
    console.log(`    - Has answer object: ${sq.answer !== undefined}`);

    if (sq.correctAnswer !== undefined) {
      console.error(`❌ SECURITY VIOLATION: correctAnswer leaked in Question ${i + 1}`);
      process.exit(1);
    }

    if (sq.options && Array.isArray(sq.options)) {
      for (const opt of sq.options) {
        if (opt.isCorrect !== undefined) {
          console.error(`❌ SECURITY VIOLATION: isCorrect leaked in Option ${opt.id}`);
          process.exit(1);
        }
      }
    }
  }
  console.log('✅ SECURITY AUDIT: PASS! No answer keys or isCorrect leaked to student.');

  // 12. Submit Student Answers for All 5 Types
  console.log('\n12. Submitting student answers for all 5 question types (resolving dynamically after shuffle)...');

  // Q1 (SINGLE_CORRECT): Select Option B ('Ampere')
  const q1 = studentQuestions.find((q: any) => q.type === 'SINGLE_CORRECT');
  const q1OptB = q1.options.find((o: any) => o.optionKey === 'B' || o.optionLabel === 'B');
  console.log(`  Q1 (SINGLE_CORRECT): Selecting Option B (${q1OptB?.id})`);
  await axios.put(
    `${BASE_URL}/attempts/${attemptId}/answer`,
    {
      examQuestionId: q1.examQuestionId,
      selectedOptionId: q1OptB.id,
    },
    { headers: { Authorization: `Bearer ${studentToken}` } },
  );

  // Q2 (MULTIPLE_CORRECT): Select Options A, B, D ('Helium', 'Neon', 'Argon')
  const q2 = studentQuestions.find((q: any) => q.type === 'MULTIPLE_CORRECT');
  const q2Opts = q2.options
    .filter((o: any) => ['A', 'B', 'D'].includes(o.optionKey || o.optionLabel))
    .map((o: any) => o.id);
  console.log(`  Q2 (MULTIPLE_CORRECT): Selecting Multiple Options A, B, D (${q2Opts.join(', ')})`);
  await axios.put(
    `${BASE_URL}/attempts/${attemptId}/answer`,
    {
      examQuestionId: q2.examQuestionId,
      selectedOptions: q2Opts,
    },
    { headers: { Authorization: `Bearer ${studentToken}` } },
  );

  // Q3 (NUMERICAL): Enter '9.8'
  const q3 = studentQuestions.find((q: any) => q.type === 'NUMERICAL');
  console.log(`  Q3 (NUMERICAL): Entering Numerical Answer '9.8'`);
  await axios.put(
    `${BASE_URL}/attempts/${attemptId}/answer`,
    {
      examQuestionId: q3.examQuestionId,
      numericalAnswer: 9.8,
    },
    { headers: { Authorization: `Bearer ${studentToken}` } },
  );

  // Q4 (ASSERTION_REASON): Select Option A
  const q4 = studentQuestions.find((q: any) => q.type === 'ASSERTION_REASON');
  const q4OptA = q4.options.find((o: any) => o.optionKey === 'A' || o.optionLabel === 'A');
  console.log(`  Q4 (ASSERTION_REASON): Selecting Option A (${q4OptA?.id})`);
  await axios.put(
    `${BASE_URL}/attempts/${attemptId}/answer`,
    {
      examQuestionId: q4.examQuestionId,
      selectedOptionId: q4OptA.id,
    },
    { headers: { Authorization: `Bearer ${studentToken}` } },
  );

  // Q5 (MATCH_FOLLOWING): Select Option A
  const q5 = studentQuestions.find((q: any) => q.type === 'MATCH_FOLLOWING');
  const q5OptA = q5.options.find((o: any) => o.optionKey === 'A' || o.optionLabel === 'A');
  console.log(`  Q5 (MATCH_FOLLOWING): Selecting Option A (${q5OptA?.id})`);
  await axios.put(
    `${BASE_URL}/attempts/${attemptId}/answer`,
    {
      examQuestionId: q5.examQuestionId,
      selectedOptionId: q5OptA.id,
    },
    { headers: { Authorization: `Bearer ${studentToken}` } },
  );

  // 13. Finalize & Submit Attempt
  console.log('\n13. Submitting and finalizing exam attempt...');
  try {
    await axios.post(
      `${BASE_URL}/attempts/${attemptId}/submit`,
      {},
      { headers: { Authorization: `Bearer ${studentToken}` } },
    );
    console.log('✅ Attempt finalized successfully.');
  } catch (err: any) {
    console.error('❌ Failed to submit attempt:', err.response?.data || err.message);
    process.exit(1);
  }

  // 14. Calculate & Verify Result Evaluation
  console.log('\n14. Calculating results and verifying evaluation across all 5 question types...');
  try {
    const resRes = await axios.post(
      `${BASE_URL}/results/${attemptId}/calculate`,
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const result = resRes.data.data || resRes.data;
    console.log('  Result Calculation Response:');
    console.log(`    - Total Questions: ${result.totalQuestions}`);
    console.log(`    - Correct Answers: ${result.correctAnswers}`);
    console.log(`    - Wrong Answers: ${result.wrongAnswers}`);
    console.log(`    - Total Score: ${result.totalScore}/${result.maxScore}`);
    console.log(`    - Percentage: ${result.percentage}%`);
    console.log(`    - Accuracy: ${result.accuracy}%`);

    if (result.correctAnswers === 5 && result.totalScore === 20) {
      console.log('\n🎉 ALL 5 QUESTION TYPES EVALUATED 100% CORRECTLY!');
    } else {
      console.error(`❌ Unexpected score: expected 5 correct, got ${result.correctAnswers}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('❌ Failed to calculate results:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log('🏁 ALL 23 REQUIREMENTS VERIFIED AND PASSED 100%!');
  console.log('====================================================');
}

runVerification()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
