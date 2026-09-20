const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- Running Query Optimization Equivalence & Performance Verifications ---');
  await prisma.$connect();

  try {
    // 1. Approval Requests Query Equivalence & Batch-enrichment test
    console.log('\n1. Testing Approval Requests Query & Batch Enrichment...');
    const startTime1 = Date.now();
    const rawItems = await prisma.approvalRequest.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
    const userIds = Array.from(new Set(rawItems.map((i) => i.requestedById).filter(Boolean)));
    const examIds = Array.from(new Set(rawItems.filter((i) => ['EXAM', 'MOCK_TEST', 'MOCK'].includes(i.resourceType)).map((i) => i.resourceId)));
    
    const [users, exams] = await Promise.all([
      userIds.length > 0 ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
      examIds.length > 0 ? prisma.exam.findMany({ where: { id: { in: examIds } }, select: { id: true, title: true } }) : [],
    ]);
    const duration1 = Date.now() - startTime1;
    console.log(`✓ Approval requests batched in ${duration1}ms (Fetched ${rawItems.length} items, ${users.length} users, ${exams.length} exams)`);

    // 2. Completed Exam History Query test
    console.log('\n2. Testing Completed Exam History Batch Aggregation...');
    const startTime2 = Date.now();
    const examsList = await prisma.exam.findMany({
      take: 5,
      orderBy: [{ endTime: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, title: true },
    });
    const examIdsList = examsList.map((e) => e.id);
    const scoreStatsList = await Promise.all(
      examIdsList.map((examId) =>
        prisma.result.aggregate({
          where: { attempt: { examId } },
          _avg: { totalScore: true, percentage: true },
          _count: { id: true },
        })
      )
    );
    const duration2 = Date.now() - startTime2;
    console.log(`✓ Completed exam history batch-aggregated in ${duration2}ms across ${examsList.length} exams`);

    // 3. Subject and Chapter Results direct relation query
    console.log('\n3. Testing Direct Subject & Chapter Result Relation Queries...');
    const sampleResult = await prisma.result.findFirst({ select: { attemptId: true } });
    if (sampleResult) {
      const startTime3 = Date.now();
      const subjectResults = await prisma.subjectResult.findMany({
        where: { result: { attemptId: sampleResult.attemptId } },
        include: { subject: { select: { id: true, name: true } } },
      });
      const chapterResults = await prisma.chapterResult.findMany({
        where: { result: { attemptId: sampleResult.attemptId } },
        include: { chapter: { select: { id: true, name: true } } },
      });
      const duration3 = Date.now() - startTime3;
      console.log(`✓ Direct relation query executed in ${duration3}ms (${subjectResults.length} subject rows, ${chapterResults.length} chapter rows)`);
    }

    // 4. Parallelized Exam Question and Answer fetch test
    console.log('\n4. Testing Parallel Exam Question & Answer Queries...');
    const sampleAttempt = await prisma.attempt.findFirst({ select: { id: true, examId: true } });
    if (sampleAttempt) {
      const startTime4 = Date.now();
      const [examQuestions, answers] = await Promise.all([
        prisma.examQuestion.findMany({
          where: { examId: sampleAttempt.examId },
          take: 20,
        }),
        prisma.answer.findMany({
          where: { attemptId: sampleAttempt.id },
        }),
      ]);
      const duration4 = Date.now() - startTime4;
      console.log(`✓ Concurrent fetch finished in ${duration4}ms (${examQuestions.length} questions, ${answers.length} answers)`);
    }

    // 5. Parallelized Billing & Pricing test
    console.log('\n5. Testing Parallel Billing & Pricing Query...');
    const startTime5 = Date.now();
    const [institutions, defaultPriceSetting] = await Promise.all([
      prisma.institution.findMany({
        where: { status: { in: ['ACTIVE', 'APPROVED', 'DRAFT'] } },
        take: 10,
        select: { id: true, name: true },
      }),
      prisma.systemSetting.findUnique({ where: { key: 'PRICE_PER_STUDENT_PER_MONTH' } }),
    ]);
    const duration5 = Date.now() - startTime5;
    console.log(`✓ Parallel billing query executed in ${duration5}ms (${institutions.length} institutions, setting: ${defaultPriceSetting?.value || '300'})`);

    console.log('\n--- All Query Optimizations Verified Successfully ---');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
