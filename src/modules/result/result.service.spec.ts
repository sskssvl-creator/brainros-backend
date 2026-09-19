import { Test, TestingModule } from '@nestjs/testing';
import { ResultService } from './result.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalysisEngineService } from './services/analysis-engine.service';
import { ResultAccessService } from './services/result-access.service';
import { ExamReportPdfService } from '../admin/services/exam-report-pdf.service';
import { ResendEmailService } from '../admin/services/resend-email.service';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ResultProcessingStatus, ResultPublicationStatus } from './interfaces/result-lifecycle.interface';

describe('ResultService (Calculation, Read-Only Reports, and Verification)', () => {
  let service: ResultService;

  const mockPrisma = {
    attempt: {
      findUnique: jest.fn(),
    },
    examQuestion: {
      findMany: jest.fn(),
    },
    answer: {
      findMany: jest.fn(),
    },
    result: {
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
    subjectResult: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    chapterResult: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    securityEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(),
  };

  const mockAnalysisEngine = {
    evaluateStatus: jest.fn().mockReturnValue('STRONG'),
    generateFullAnalysis: jest.fn(),
  };

  const mockResultAccessService = {
    verifyResultState: jest.fn(),
    canViewReport: jest.fn(),
    getResultStatus: jest.fn(),
    invalidateResultCache: jest.fn().mockResolvedValue(undefined),
  };

  const mockPdfService = {
    generateExamAnalysisPdf: jest.fn().mockResolvedValue(Buffer.from('pdf-content')),
  };

  const mockResendEmailService = {
    sendReportEmail: jest.fn().mockResolvedValue({ success: true }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResultService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AnalysisEngineService, useValue: mockAnalysisEngine },
        { provide: ResultAccessService, useValue: mockResultAccessService },
        { provide: ExamReportPdfService, useValue: mockPdfService },
        { provide: ResendEmailService, useValue: mockResendEmailService },
      ],
    }).compile();

    service = module.get<ResultService>(ResultService);
    jest.clearAllMocks();
  });

  describe('calculateResult — Idempotency and Persistence', () => {
    it('skips recalculation if result is already completely persisted', async () => {
      const existingResult = {
        id: 'res-existing',
        attemptId: 'att-1',
        totalScore: 500,
        maxScore: 720,
        totalQuestions: 180,
        subjectResults: [{ id: 'sr-1' }],
        chapterResults: [{ id: 'cr-1' }],
      };

      mockPrisma.attempt.findUnique.mockResolvedValue({
        id: 'att-1',
        status: { name: 'SUBMITTED' },
        result: existingResult,
      });

      const res = await service.calculateResult('att-1');

      expect(res).toBe(existingResult);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects calculation if attempt is not submitted', async () => {
      mockPrisma.attempt.findUnique.mockResolvedValue({
        id: 'att-in-progress',
        status: { name: 'IN_PROGRESS' },
        result: null,
      });

      await expect(service.calculateResult('att-in-progress')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('executes atomic calculation transaction and invalidates cache when no result exists', async () => {
      const attemptData = {
        id: 'att-new',
        studentId: 'stu-1',
        examId: 'exam-1',
        status: { name: 'SUBMITTED' },
        result: null,
        exam: {
          scoringRules: [],
          defaultMarksPerQuestion: 4,
          defaultNegativeMarks: 1,
        },
        timeLogs: [],
      };

      mockPrisma.attempt.findUnique.mockResolvedValue(attemptData);
      mockPrisma.examQuestion.findMany.mockResolvedValue([]);
      mockPrisma.answer.findMany.mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        const txMock = {
          result: { upsert: jest.fn().mockResolvedValue({ id: 'res-new' }) },
          subjectResult: { deleteMany: jest.fn(), createMany: jest.fn() },
          chapterResult: { deleteMany: jest.fn(), createMany: jest.fn() },
        };
        await cb(txMock);
      });
      mockPrisma.result.findUnique.mockResolvedValue({ id: 'res-new', attemptId: 'att-new', totalScore: 0 });

      const res = await service.calculateResult('att-new');

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockResultAccessService.invalidateResultCache).toHaveBeenCalledWith('att-new', 'stu-1', 'exam-1');
      expect(res).toBeDefined();
    });
  });

  describe('getResult — PURE READ-ONLY (Bug 1 & Bug 2 Verification)', () => {
    it('returns persisted result without re-triggering calculation', async () => {
      mockResultAccessService.canViewReport.mockResolvedValue(true);
      const dbResult = {
        id: 'res-db-1',
        attemptId: 'att-calc',
        totalScore: 620,
        maxScore: 720,
        percentage: 86.11,
        accuracy: 90,
        resultStatus: 'COMPLETED',
        attempt: { id: 'att-calc', exam: { title: 'NEET Practice' } },
        subjectResults: [],
        chapterResults: [],
      };

      mockPrisma.result.findUnique.mockResolvedValue(dbResult);

      const res = await service.getResult('att-calc', { userId: 'user-1' });

      expect(res).toBe(dbResult);
      // Verify calculateResult was NEVER called
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if result does not exist without calling calculateResult', async () => {
      mockResultAccessService.canViewReport.mockResolvedValue(true);
      mockPrisma.result.findUnique.mockResolvedValue(null);

      await expect(service.getResult('att-missing', { userId: 'user-1' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('getFullAnalysis — PURE READ-ONLY', () => {
    it('reads persisted result and calls analysisEngine without triggering calculation', async () => {
      mockResultAccessService.canViewReport.mockResolvedValue(true);
      mockPrisma.result.findUnique.mockResolvedValue({ id: 'res-1' });
      mockAnalysisEngine.generateFullAnalysis.mockResolvedValue({
        overall: { totalScore: 620 },
      });

      const analysis = await service.getFullAnalysis('att-1', { userId: 'user-1' });

      expect(analysis).toBeDefined();
      expect(mockAnalysisEngine.generateFullAnalysis).toHaveBeenCalledWith('att-1');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when result does not exist without triggering calculation', async () => {
      mockResultAccessService.canViewReport.mockResolvedValue(true);
      mockPrisma.result.findUnique.mockResolvedValue(null);

      await expect(service.getFullAnalysis('att-uncalc', { userId: 'user-1' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('verifyResult — Deep Persisted State Reconciliation', () => {
    it('reconciles and returns accurate verification artifact state', async () => {
      mockPrisma.attempt.findUnique.mockResolvedValue({
        id: 'att-verify-1',
        examId: 'exam-1',
        exam: { title: 'NEET Mock' },
        status: { name: 'SUBMITTED' },
        result: {
          totalScore: 650,
          maxScore: 720,
          totalQuestions: 180,
          percentage: 90.27,
          accuracy: 94.5,
          subjectResults: [{ id: 'sr-1' }],
          chapterResults: [{ id: 'cr-1' }],
        },
        answers: [{ id: 'ans-1' }],
        timeAnalyses: [{ id: 'ta-1' }],
        strategyAnalyses: [{ id: 'sa-1' }],
        candidateRanks: [{ id: 'cr-1', rank: 1 }],
      });

      mockResultAccessService.verifyResultState.mockResolvedValue({
        processingStatus: ResultProcessingStatus.COMPLETED,
        publicationStatus: ResultPublicationStatus.PUBLISHED,
        isLive: false,
        resultCalculated: true,
        reportAvailable: true,
        onlineReportAvailable: true,
      });

      const verification = await service.verifyResult('att-verify-1');

      expect(verification.resultAvailable).toBe(true);
      expect(verification.reportAvailable).toBe(true);
      expect(verification.evaluationComplete).toBe(true);
      expect(verification.analyticsComplete).toBe(true);
      expect(verification.rankingComplete).toBe(true);
      expect(verification.totalScore).toBe(650);
    });
  });

  describe('recalculateResult — Admin Protection', () => {
    it('forbids non-admin users from recalculating results', async () => {
      const studentUser = { userId: 'u-stu', role: 'STUDENT' };

      await expect(
        service.recalculateResult('att-1', studentUser, 2),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
