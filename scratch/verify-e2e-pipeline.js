const path = require('path');
const { PrismaClient } = require(path.resolve('d:/exam mangment/backend/node_modules/@prisma/client'));
const prisma = new PrismaClient();

async function main() {
  console.log('=== RUNNING REAL END-TO-END EVALUATION PIPELINE TEST ===\n');

  // 1. Pick student and question
  const student = await prisma.student.findFirst({
    include: { user: true }
  });
  if (!student) throw new Error('No student found in DB');

  const question = await prisma.question.findFirst({
    include: { options: true, questionType: true, answer: true, subject: true }
  });
  if (!question) throw new Error('No question found in DB');

  const activeStatus = await prisma.examStatus.findUnique({ where: { name: 'ACTIVE' } });
  const submittedStatus = await prisma.attemptStatus.findUnique({ where: { name: 'SUBMITTED' } });

  // 2. Create an official scheduled exam whose endTime was 2 minutes ago
  const now = new Date();
  const startTime = new Date(now.getTime() - 10 * 60 * 1000); // 10 mins ago
  const endTime = new Date(now.getTime() - 2 * 60 * 1000);   // 2 mins ago

  const testExam = await prisma.exam.create({
    data: {
      title: `E2E Official Scheduled Exam Test ${Date.now()}`,
      status: { connect: { id: activeStatus.id } },
      createdBy: { connect: { id: student.userId } },
      durationMinutes: 8,
      totalMarks: 4,
      totalQuestions: 1,
      examTarget: {
        connect: { id: student.examTargetId || (await prisma.examTarget.findFirst()).id }
      },
      sections: {
        create: {
          name: 'Section A',
          subjectId: question.subjectId,
          displayOrder: 1,
          totalQuestions: 1
        }
      },
      versions: {
        create: {
          versionNumber: 1,
          generatedBy: { connect: { id: student.userId } },
          totalQuestions: 1,
          durationMinutes: 8,
          totalMarks: 4
        }
      }
    },
    include: {
      sections: true,
      versions: true
    }
  });

  const section = testExam.sections[0];
  const version = testExam.versions[0];

  const examQuestion = await prisma.examQuestion.create({
    data: {
      examId: testExam.id,
      sectionId: section.id,
      questionId: question.id,
      displayOrder: 1
    }
  });

  const schedule = await prisma.examSchedule.create({
    data: {
      exam: { connect: { id: testExam.id } },
      examVersion: { connect: { id: version.id } },
      scheduledBy: { connect: { id: student.userId } },
      startTime,
      endTime,
      timezone: 'Asia/Kolkata',
      status: 'SCHEDULED', // was left as SCHEDULED by admin
      hasAnswerKey: true
    }
  });

  console.log(`[E2E] Created test official exam: '${testExam.title}' (ID: ${testExam.id})`);
  console.log(`[E2E] Schedule Window: ${startTime.toISOString()} to ${endTime.toISOString()}`);
  console.log(`[E2E] Current Server Time: ${now.toISOString()} (Window closed: ${endTime < now})`);

  // 3. Create a submitted attempt waiting in PENDING_WINDOW_CLOSE
  const attempt = await prisma.attempt.create({
    data: {
      exam: { connect: { id: testExam.id } },
      student: { connect: { id: student.id } },
      status: { connect: { id: submittedStatus.id } },
      language: { connect: { id: student.preferredLanguageId || (await prisma.preferredLanguage.findFirst()).id } },
      startedAt: new Date(now.getTime() - 8 * 60 * 1000),
      submittedAt: new Date(now.getTime() - 5 * 60 * 1000),
      serverStartTime: startTime,
      serverEndTime: endTime,
      examVersion: { connect: { id: version.id } },
      schedule: { connect: { id: schedule.id } },
      answers: {
        create: {
          examQuestionId: examQuestion.id,
          selectedOptionId: question.options[0]?.id || null,
          answeredAt: new Date(now.getTime() - 6 * 60 * 1000)
        }
      },
      result: {
        create: {
          resultStatus: 'PENDING_WINDOW_CLOSE',
          totalQuestions: 0,
          correctAnswers: 0,
          wrongAnswers: 0,
          unattempted: 0,
          totalScore: 0,
          maxScore: 0,
          percentage: 0,
          accuracy: 0
        }
      }
    },
    include: {
      result: true
    }
  });

  console.log(`[E2E] Created submitted attempt: ${attempt.id}`);
  console.log(`[E2E] Initial Result Status: ${attempt.result.resultStatus}`);

  // 4. Import and execute the updated ResultReconciliationProcessor
  const { ResultReconciliationProcessor } = require(path.resolve('d:/exam mangment/backend/dist/modules/result/processors/result-reconciliation.processor'));
  const { ResultService } = require(path.resolve('d:/exam mangment/backend/dist/modules/result/result.service'));
  const { ResultReadinessService } = require(path.resolve('d:/exam mangment/backend/dist/modules/result/services/result-readiness.service'));
  const { ResultAccessService } = require(path.resolve('d:/exam mangment/backend/dist/modules/result/services/result-access.service'));
  const { TimeAnalysisService } = require(path.resolve('d:/exam mangment/backend/dist/modules/time-analysis/services/time-analysis.service'));
  const { StrategyAnalyzerService } = require(path.resolve('d:/exam mangment/backend/dist/modules/attempt-strategy/services/strategy-analyzer.service'));
  const { RankGenerationService } = require(path.resolve('d:/exam mangment/backend/dist/modules/rank-engine/services/rank-generation.service'));
  const { AnalysisEngineService } = require(path.resolve('d:/exam mangment/backend/dist/modules/result/services/analysis-engine.service'));

  const redisMock = { get: async () => null, set: async () => 'OK', del: async () => 1 };
  const queueMock = { add: async () => { throw new Error('Queue in direct calculation fallback mode'); } };
  const jobProgressMock = {
    publishStarted: async () => {},
    publishProgress: async () => {},
    publishCompleted: async () => {},
    publishFailed: async () => {}
  };

  const analysisEngine = new AnalysisEngineService();
  const readinessService = new ResultReadinessService(prisma, redisMock);
  const resultAccessService = new ResultAccessService(prisma, redisMock, readinessService);
  const pdfServiceMock = { generateExamAnalysisPdf: async () => Buffer.from('pdf') };
  const resendEmailMock = { sendReportEmail: async () => ({ success: true }) };
  const resultService = new ResultService(prisma, analysisEngine, resultAccessService, pdfServiceMock, resendEmailMock);
  const timeAnalysisService = new TimeAnalysisService(prisma, redisMock, null, null);
  const strategyAnalyzerService = new StrategyAnalyzerService(prisma, redisMock);
  const { RankingCandidateEligibilityService } = require(path.resolve('d:/exam mangment/backend/dist/modules/rank-engine/services/ranking-candidate-eligibility.service'));
  const { TieBreakService } = require(path.resolve('d:/exam mangment/backend/dist/modules/rank-engine/services/tie-break.service'));
  const { PercentileService } = require(path.resolve('d:/exam mangment/backend/dist/modules/rank-engine/services/percentile.service'));
  const { PredictionService } = require(path.resolve('d:/exam mangment/backend/dist/modules/rank-engine/services/prediction.service'));

  const eligibilityService = new RankingCandidateEligibilityService(prisma);
  const tieBreakService = new TieBreakService();
  const percentileService = new PercentileService();
  const predictionService = new PredictionService(prisma, redisMock);

  const rankGenerationService = new RankGenerationService(
    prisma,
    redisMock,
    eligibilityService,
    tieBreakService,
    percentileService,
    predictionService
  );

  const processor = new ResultReconciliationProcessor(
    prisma,
    redisMock,
    resultService,
    readinessService,
    resultAccessService,
    timeAnalysisService,
    strategyAnalyzerService,
    rankGenerationService,
    queueMock,
    queueMock,
    queueMock,
    queueMock,
    jobProgressMock
  );

  console.log('\n[E2E] Running Reconciliation Cycle...');
  const reconcileResult = await processor.runReconciliation('e2e_test_run');
  console.log('[E2E] Reconciliation Cycle Finished:', JSON.stringify(reconcileResult, null, 2));

  // 5. Verify the updated DB state
  const updatedExam = await prisma.exam.findUnique({
    where: { id: testExam.id },
    include: {
      status: true,
      schedules: true,
      attempts: {
        include: {
          result: true,
          timeAnalyses: true,
          strategyAnalyses: true,
          candidateRanks: true
        }
      }
    }
  });

  const finalAttempt = updatedExam.attempts[0];
  console.log('\n=== FINAL VERIFIED DATABASE STATE ===');
  console.log(`Exam Status: ${updatedExam.status.name} (Expected: ENDED)`);
  console.log(`Schedule Status: ${updatedExam.schedules[0].status} (Expected: ENDED)`);
  console.log(`Attempt Result Status: ${finalAttempt.result.resultStatus} (Expected: READY_TO_PUBLISH)`);
  console.log(`Total Score Computed: ${finalAttempt.result.totalScore}`);
  console.log(`Total Correct Answers: ${finalAttempt.result.correctAnswers}`);
  console.log(`Time Analyses Generated: ${finalAttempt.timeAnalyses.length}`);
  console.log(`Strategy Analyses Generated: ${finalAttempt.strategyAnalyses.length}`);
  console.log(`Candidate Ranks Generated: ${finalAttempt.candidateRanks.length}`);

  if (
    updatedExam.status.name === 'ENDED' &&
    updatedExam.schedules[0].status === 'ENDED' &&
    finalAttempt.result.resultStatus === 'READY_TO_PUBLISH'
  ) {
    console.log('\n>>> SUCCESS: Full Official Exam Evaluation Pipeline Executed Flawlessly! <<<');
  } else {
    console.error('\n>>> FAILED: State transition did not complete as expected. <<<');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('E2E Test Error:', err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
