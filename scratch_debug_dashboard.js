const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testDashboard() {
  const user = await prisma.user.findUnique({ where: { email: 'student001@brainros.test' } });
  console.log('User found:', user?.id);
  const userId = user.id;

  try {
    const student = await prisma.student.findFirst({
      where: { OR: [{ userId }, { id: userId }] },
      include: {
        user: { select: { id: true, email: true, mobileNumber: true } },
        examTarget: { select: { id: true, name: true } },
        studentExamTargets: { include: { examTarget: true } },
        studentClass: { select: { id: true, name: true } },
        preferredLanguage: { select: { id: true, name: true } },
      },
    });
    console.log('Step 1 (student profile) OK:', student?.id);
  } catch (err) {
    console.error('Step 1 failed:', err.code, err.message);
  }

  const student = await prisma.student.findFirst({ where: { userId } });
  const studentId = student.id;
  const now = new Date();

  try {
    const activeAttemptRecord = await prisma.attempt.findFirst({
      where: {
        studentId,
        status: { name: 'IN_PROGRESS' },
      },
      include: {
        exam: { select: { id: true, title: true, durationMinutes: true, totalQuestions: true } },
        answers: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    console.log('Step 2 (active attempt) OK:', !!activeAttemptRecord);
  } catch (err) {
    console.error('Step 2 failed:', err.code, err.message);
  }

  try {
    const upcomingExamRecords = await prisma.exam.findMany({
      where: {
        status: { name: { in: ['SCHEDULED', 'ACTIVE'] } },
        AND: [
          {
            OR: [
              { endTime: { gt: now } },
              { schedules: { some: { status: { in: ['SCHEDULED', 'ACTIVE'] }, endTime: { gt: now } } } },
            ],
          },
        ],
      },
      include: {
        examTarget: { select: { id: true, name: true } },
        status: { select: { id: true, name: true } },
        schedules: {
          where: { status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED'] }, endTime: { gt: now } },
          orderBy: [{ updatedAt: 'desc' }, { startTime: 'asc' }],
          take: 1,
        },
      },
      take: 10,
    });
    console.log('Step 3 (upcoming exams) OK, count:', upcomingExamRecords.length);
  } catch (err) {
    console.error('Step 3 failed:', err.code, err.message);
  }

  try {
    const evaluatedAttempts = await prisma.attempt.findMany({
      where: {
        studentId,
        result: { isNot: null },
        status: { name: { in: ['EVALUATED', 'SUBMITTED', 'AUTO_SUBMITTED'] } },
      },
      include: {
        exam: { select: { id: true, title: true, totalMarks: true, examTarget: true } },
        result: {
          include: {
            subjectResults: {
              include: { subject: true },
            },
            chapterResults: {
              include: { chapter: { include: { subject: true } } },
            },
          },
        },
        timeAnalyses: { take: 1 },
        strategyAnalyses: { take: 1 },
        candidateRanks: true,
      },
      orderBy: { submittedAt: 'desc' },
      take: 10,
    });
    console.log('Step 4 (evaluated attempts) OK, count:', evaluatedAttempts.length);
  } catch (err) {
    console.error('Step 4 failed:', err.code, err.message);
  }
}

testDashboard().catch(console.error).finally(() => prisma.$disconnect());
