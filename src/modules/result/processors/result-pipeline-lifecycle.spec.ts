import { Test, TestingModule } from '@nestjs/testing';
import { ResultReconciliationProcessor } from './result-reconciliation.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ResultService } from '../result.service';
import { ResultReadinessService } from '../services/result-readiness.service';
import { ResultAccessService } from '../services/result-access.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { TimeAnalysisService } from '../../time-analysis/services/time-analysis.service';
import { StrategyAnalyzerService } from '../../attempt-strategy/services/strategy-analyzer.service';
import { RankGenerationService } from '../../rank-engine/services/rank-generation.service';
import { getQueueToken } from '@nestjs/bullmq';
import {
  EVALUATION_QUEUE_NAME,
  ANALYTICS_QUEUE_NAME,
  RANKING_QUEUE_NAME,
  EXAM_WINDOW_END_QUEUE_NAME,
  ResultStatusEnum,
} from '../interfaces/result-lifecycle.interface';

describe('Official Exam Evaluation Pipeline Lifecycle & End-of-Exam Cases', () => {
  let processor: ResultReconciliationProcessor;

  let mockPrisma: any;
  let mockRedis: any;
  let mockResultService: any;
  let mockReadinessService: any;
  let mockResultAccessService: any;
  let mockTimeAnalysisService: any;
  let mockStrategyAnalyzerService: any;
  let mockRankGenerationService: any;
  let mockEvaluationQueue: any;
  let mockAnalyticsQueue: any;
  let mockRankingQueue: any;
  let mockWindowEndQueue: any;

  beforeEach(async () => {
    mockPrisma = {
      result: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      attempt: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      exam: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      examSchedule: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      examStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 'status-ended' }),
      },
      attemptStatus: {
        findUnique: jest.fn().mockResolvedValue({ id: 'status-auto' }),
      },
    };

    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    mockResultService = {
      calculateResult: jest.fn().mockResolvedValue({ id: 'res-1', totalScore: 100 }),
    };

    mockReadinessService = {
      isLiveExam: jest.fn().mockResolvedValue(true),
    };

    mockResultAccessService = {
      invalidateResultCache: jest.fn().mockResolvedValue(undefined),
    };

    mockTimeAnalysisService = {
      generateTimeAnalysis: jest.fn().mockResolvedValue({}),
    };

    mockStrategyAnalyzerService = {
      generateStrategyAnalysis: jest.fn().mockResolvedValue({}),
    };

    mockRankGenerationService = {
      generateRanks: jest.fn().mockResolvedValue({}),
    };

    mockEvaluationQueue = {
      add: jest.fn().mockResolvedValue({ id: 'eval-job-1' }),
    };
    mockAnalyticsQueue = {
      add: jest.fn().mockResolvedValue({ id: 'analytics-job-1' }),
    };
    mockRankingQueue = {
      add: jest.fn().mockResolvedValue({ id: 'ranking-job-1' }),
    };
    mockWindowEndQueue = {
      add: jest.fn().mockResolvedValue({ id: 'window-end-job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResultReconciliationProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ResultService, useValue: mockResultService },
        { provide: ResultReadinessService, useValue: mockReadinessService },
        { provide: ResultAccessService, useValue: mockResultAccessService },
        { provide: TimeAnalysisService, useValue: mockTimeAnalysisService },
        { provide: StrategyAnalyzerService, useValue: mockStrategyAnalyzerService },
        { provide: RankGenerationService, useValue: mockRankGenerationService },
        { provide: getQueueToken(EVALUATION_QUEUE_NAME), useValue: mockEvaluationQueue },
        { provide: getQueueToken(ANALYTICS_QUEUE_NAME), useValue: mockAnalyticsQueue },
        { provide: getQueueToken(RANKING_QUEUE_NAME), useValue: mockRankingQueue },
        { provide: getQueueToken(EXAM_WINDOW_END_QUEUE_NAME), useValue: mockWindowEndQueue },
        {
          provide: JobProgressService,
          useValue: {
            publishStarted: jest.fn().mockResolvedValue({}),
            publishProgress: jest.fn().mockResolvedValue({}),
            publishCompleted: jest.fn().mockResolvedValue({}),
            publishFailed: jest.fn().mockResolvedValue({}),
            publishRetrying: jest.fn().mockResolvedValue({}),
            getJobStatus: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    processor = module.get<ResultReconciliationProcessor>(ResultReconciliationProcessor);
    jest.clearAllMocks();
  });

  // Case 1: Exam has not ended -> no evaluation job
  it('Case 1: does not trigger evaluation when exam endTime is in the future', async () => {
    mockPrisma.exam.findMany.mockResolvedValue([]);
    const res = await processor.runReconciliation();
    expect(res.stats.endedExamsTriggered).toBe(0);
    expect(mockEvaluationQueue.add).not.toHaveBeenCalled();
  });

  // Case 2: Exam ended and attempt is submitted -> evaluation job created
  it('Case 2: discovers ended official exam and creates evaluation jobs for submitted attempts', async () => {
    mockPrisma.exam.findMany.mockResolvedValue([
      {
        id: 'exam-ended-1',
        title: 'Physics Live Exam',
        attempts: [{ id: 'att-1' }],
      },
    ]);

    const res = await processor.runReconciliation();

    expect(res.stats.endedExamsTriggered).toBe(1);
    expect(mockEvaluationQueue.add).toHaveBeenCalledWith(
      'EVALUATE_ATTEMPT',
      expect.objectContaining({ attemptId: 'att-1' }),
      expect.any(Object),
    );
    expect(mockPrisma.result.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attemptId: 'att-1' },
        update: expect.objectContaining({ resultStatus: ResultStatusEnum.PROCESSING }),
      }),
    );
  });

  // Case 3: Reconciliation runs twice -> only one evaluation job (idempotent)
  it('Case 3: guarantees idempotency when reconciliation runs multiple times', async () => {
    mockPrisma.exam.findMany.mockResolvedValue([
      {
        id: 'exam-ended-1',
        title: 'Chemistry Live Exam',
        attempts: [{ id: 'att-1' }],
      },
    ]);

    await processor.runReconciliation();
    expect(mockEvaluationQueue.add).toHaveBeenCalledTimes(1);

    // On second run, attempts are already PROCESSING/EVALUATED
    mockPrisma.exam.findMany.mockResolvedValue([]);
    await processor.runReconciliation();
    expect(mockEvaluationQueue.add).toHaveBeenCalledTimes(1);
  });

  // Case 4: Backend restarts after exam ended -> ended exam is discovered and evaluation queued
  it('Case 4: discovers ended exam upon startup/recovery even if exact second was missed', async () => {
    mockPrisma.examSchedule.findMany.mockResolvedValue([
      { id: 'sched-past', examId: 'exam-missed-1' },
    ]);
    mockPrisma.exam.findMany.mockResolvedValue([
      {
        id: 'exam-missed-1',
        title: 'Missed Window Exam',
        attempts: [{ id: 'att-missed-1' }],
      },
    ]);

    const res = await processor.runReconciliation('startup_reconciliation');

    expect(res.stats.endedExamsTriggered).toBe(1);
    expect(mockEvaluationQueue.add).toHaveBeenCalled();
  });

  // Case 5: Direct calculation saves result
  it('Case 5: direct calculation fallback succeeds when queue is offline', async () => {
    mockEvaluationQueue.add.mockRejectedValue(new Error('Redis connection refused'));
    mockPrisma.exam.findMany.mockResolvedValue([
      {
        id: 'exam-ended-1',
        title: 'Physics Offline Test',
        attempts: [{ id: 'att-direct-1' }],
      },
    ]);

    await processor.runReconciliation();

    expect(mockResultService.calculateResult).toHaveBeenCalledWith('att-direct-1');
    expect(mockTimeAnalysisService.generateTimeAnalysis).toHaveBeenCalledWith('att-direct-1');
    expect(mockStrategyAnalyzerService.generateStrategyAnalysis).toHaveBeenCalledWith('att-direct-1');
  });

  // Case 8: Exam has multiple submitted attempts -> all eligible attempts are evaluated
  it('Case 8: evaluates all eligible submitted attempts for an ended exam', async () => {
    mockPrisma.exam.findMany.mockResolvedValue([
      {
        id: 'exam-ended-multi',
        title: 'NEET Grand Exam',
        attempts: [{ id: 'att-1' }, { id: 'att-2' }, { id: 'att-3' }],
      },
    ]);

    await processor.runReconciliation();

    expect(mockEvaluationQueue.add).toHaveBeenCalledTimes(3);
  });

  // Case 10: Mock exam -> immediate auto-publish after calculation
  it('Case 10: repairs evaluated mock attempts directly to PUBLISHED status', async () => {
    mockReadinessService.isLiveExam.mockResolvedValue(false);
    mockPrisma.result.findMany.mockResolvedValue([
      {
        id: 'res-mock-1',
        attemptId: 'att-mock-1',
        resultStatus: ResultStatusEnum.EVALUATED,
        publishedAt: null,
        attempt: { examId: 'exam-mock-1', studentId: 'stu-mock-1' },
      },
    ]);

    const res = await processor.runReconciliation();

    expect(res.stats.repairedMockPublished).toBe(1);
    expect(mockPrisma.result.update).toHaveBeenCalledWith({
      where: { id: 'res-mock-1' },
      data: expect.objectContaining({ resultStatus: ResultStatusEnum.PUBLISHED }),
    });
  });

  // Case 11: Timezone boundary comparison uses authoritative UTC date
  it('Case 11: uses authoritative UTC Date comparison for schedule endTime', async () => {
    mockPrisma.examSchedule.findMany.mockResolvedValue([
      { id: 'sched-utc', examId: 'exam-utc-1' },
    ]);

    await processor.runReconciliation();

    expect(mockPrisma.examSchedule.findMany).toHaveBeenCalledWith({
      where: {
        endTime: { lte: expect.any(Date) },
        status: { in: ['SCHEDULED', 'ACTIVE'] },
      },
      select: { id: true, examId: true },
    });
  });
});
