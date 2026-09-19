import { Test, TestingModule } from '@nestjs/testing';
import { ResultProcessingMonitorService } from './result-processing-monitor.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ResultReadinessService } from './result-readiness.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { getQueueToken } from '@nestjs/bullmq';
import {
  EVALUATION_QUEUE_NAME,
  EXAM_WINDOW_END_QUEUE_NAME,
  ResultStatusEnum,
} from '../interfaces/result-lifecycle.interface';

describe('ResultProcessingMonitorService (Real-Time Job Monitoring & Observability)', () => {
  let service: ResultProcessingMonitorService;

  const mockPrisma = {
    exam: {
      findUnique: jest.fn(),
    },
    attempt: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    result: {
      update: jest.fn(),
    },
    rankSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const mockRedis = {
    getClient: jest.fn().mockReturnValue({}),
  };

  const mockReadinessService = {
    isLiveExam: jest.fn().mockResolvedValue(true),
    checkExamReadiness: jest.fn(),
  };

  const mockJobProgressService = {
    getJobStatus: jest.fn().mockResolvedValue(null),
    publishRetrying: jest.fn().mockResolvedValue({}),
    emitExamCompleted: jest.fn(),
  };

  const mockEvaluationQueue = {
    add: jest.fn().mockResolvedValue({ id: 'eval_att_1' }),
    getJob: jest.fn().mockResolvedValue(null),
  };

  const mockWindowEndQueue = {
    add: jest.fn().mockResolvedValue({ id: 'window_end_1' }),
    getJob: jest.fn().mockResolvedValue(null),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResultProcessingMonitorService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ResultReadinessService, useValue: mockReadinessService },
        { provide: JobProgressService, useValue: mockJobProgressService },
        { provide: getQueueToken(EVALUATION_QUEUE_NAME), useValue: mockEvaluationQueue },
        { provide: getQueueToken(EXAM_WINDOW_END_QUEUE_NAME), useValue: mockWindowEndQueue },
      ],
    }).compile();

    service = module.get<ResultProcessingMonitorService>(ResultProcessingMonitorService);
    jest.clearAllMocks();
  });

  it('calculates accurate overall progress and stage breakdown from database state', async () => {
    mockPrisma.exam.findUnique.mockResolvedValue({
      id: 'exam-1',
      title: 'NEET Mock 01',
      status: { name: 'ENDED' },
    });

    // 4 attempts:
    // 1 completed (all stages done)
    // 1 in evaluation
    // 1 in analytics
    // 1 failed
    mockPrisma.attempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        studentId: 'stud-1',
        status: { name: 'SUBMITTED' },
        result: { id: 'res-1', resultStatus: ResultStatusEnum.READY_TO_PUBLISH, totalScore: 500 },
        timeAnalyses: [{ id: 'ta-1' }],
        strategyAnalyses: [{ id: 'sa-1' }],
        candidateRanks: [{ id: 'cr-1' }],
      },
      {
        id: 'att-2',
        studentId: 'stud-2',
        status: { name: 'SUBMITTED' },
        result: { id: 'res-2', resultStatus: ResultStatusEnum.PROCESSING, totalScore: null },
        timeAnalyses: [],
        strategyAnalyses: [],
        candidateRanks: [],
      },
      {
        id: 'att-3',
        studentId: 'stud-3',
        status: { name: 'SUBMITTED' },
        result: { id: 'res-3', resultStatus: ResultStatusEnum.ANALYTICS_PROCESSING, totalScore: 400 },
        timeAnalyses: [],
        strategyAnalyses: [],
        candidateRanks: [],
      },
      {
        id: 'att-4',
        studentId: 'stud-4',
        status: { name: 'SUBMITTED' },
        result: { id: 'res-4', resultStatus: ResultStatusEnum.FAILED, totalScore: null },
        timeAnalyses: [],
        strategyAnalyses: [],
        candidateRanks: [],
      },
    ]);

    mockReadinessService.checkExamReadiness.mockResolvedValue({
      ready: false,
      publicationStatus: 'PROCESSING',
      reason: '1 attempt(s) failed or pending evaluation.',
    });

    const summary = await service.getExamProcessingSummary('exam-1');

    expect(summary.totalJobs).toBe(4);
    expect(summary.completedJobs).toBe(1);
    expect(summary.failedJobs).toBe(1);
    expect(summary.overallPercentage).toBe(25); // 1 / 4 * 100 = 25%
    expect(summary.status).toBe('FAILED');
    expect(summary.isReadyToPublish).toBe(false);
    expect(summary.canPublish).toBe(false);
    expect(summary.stages.evaluation.completed).toBe(2); // att-1 and att-3 have evaluated scores
    expect(summary.stages.evaluation.failed).toBe(1);
  });

  it('marks status READY_TO_PUBLISH when 100% jobs are completed and readiness verified', async () => {
    mockPrisma.exam.findUnique.mockResolvedValue({
      id: 'exam-1',
      title: 'NEET Mock 01',
      status: { name: 'ENDED' },
    });

    mockPrisma.attempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        studentId: 'stud-1',
        status: { name: 'SUBMITTED' },
        result: { id: 'res-1', resultStatus: ResultStatusEnum.READY_TO_PUBLISH, totalScore: 500 },
        timeAnalyses: [{ id: 'ta-1' }],
        strategyAnalyses: [{ id: 'sa-1' }],
        candidateRanks: [{ id: 'cr-1' }],
      },
    ]);

    mockReadinessService.checkExamReadiness.mockResolvedValue({
      ready: true,
      publicationStatus: 'READY_TO_PUBLISH',
      reason: null,
    });

    const summary = await service.getExamProcessingSummary('exam-1');

    expect(summary.totalJobs).toBe(1);
    expect(summary.completedJobs).toBe(1);
    expect(summary.failedJobs).toBe(0);
    expect(summary.overallPercentage).toBe(100);
    expect(summary.status).toBe('READY_TO_PUBLISH');
    expect(summary.isReadyToPublish).toBe(true);
    expect(summary.canPublish).toBe(true);
  });

  it('retries failed jobs idempotently into BullMQ evaluation queue', async () => {
    mockPrisma.attempt.findMany.mockResolvedValue([
      {
        id: 'att-failed-1',
        result: {
          id: 'res-failed-1',
          resultStatus: ResultStatusEnum.FAILED,
          metadata: { retryCount: 1 },
        },
      },
    ]);

    const res = await service.retryFailedJobs('exam-1', 'admin-user-1');

    expect(res.success).toBe(true);
    expect(res.retriedCount).toBe(1);

    // Verify result was reset to PROCESSING
    expect(mockPrisma.result.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'res-failed-1' },
        data: expect.objectContaining({
          resultStatus: ResultStatusEnum.PROCESSING,
        }),
      }),
    );

    // Verify job was re-enqueued to BullMQ
    expect(mockEvaluationQueue.add).toHaveBeenCalledWith(
      'EVALUATE_ATTEMPT',
      expect.objectContaining({
        attemptId: 'att-failed-1',
        retryCount: 2,
      }),
      expect.objectContaining({
        jobId: 'eval_att-failed-1',
      }),
    );

    expect(mockJobProgressService.publishRetrying).toHaveBeenCalled();
  });

  it('supports server-side pagination, status filtering, and search in getExamProcessingJobs', async () => {
    mockPrisma.attempt.count.mockResolvedValue(1);
    mockPrisma.attempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        studentId: 'stud-1',
        student: {
          name: 'Rahul Sharma',
          user: { email: 'rahul@gmail.com' },
        },
        status: { name: 'SUBMITTED' },
        result: { id: 'res-1', resultStatus: ResultStatusEnum.READY_TO_PUBLISH, totalScore: 500 },
        timeAnalyses: [{ id: 'ta-1' }],
        strategyAnalyses: [{ id: 'sa-1' }],
        candidateRanks: [{ id: 'cr-1' }],
        submittedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const jobsRes = await service.getExamProcessingJobs('exam-1', {
      page: 1,
      limit: 10,
      search: 'Rahul',
      status: 'COMPLETED',
    });

    expect(jobsRes.items.length).toBe(1);
    expect(jobsRes.items[0].studentName).toBe('Rahul Sharma');
    expect(jobsRes.items[0].studentEmail).toBe('r***l@gmail.com'); // Masked email
    expect(jobsRes.items[0].status).toBe('COMPLETED');
    expect(jobsRes.items[0].progress).toBe(100);
    expect(jobsRes.pagination.total).toBe(1);
  });
});
