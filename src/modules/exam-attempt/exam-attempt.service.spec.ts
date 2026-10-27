import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ExamAttemptService } from './exam-attempt.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExamService } from '../exam/exam.service';
import { ExamAccessService } from '../exam-scheduling/services/exam-access.service';
import { QuestionTimingService } from '../time-analysis/services/question-timing.service';
import { ResultReadinessService } from '../result/services/result-readiness.service';
import { QuestionShuffleService } from './services/question-shuffle.service';
import { RedisService } from '../redis/redis.service';
import { getQueueToken } from '@nestjs/bullmq';
import { EVALUATION_QUEUE_NAME } from '../result/interfaces/result-lifecycle.interface';
import { ExamCacheService } from '../exam-cache/services/exam-cache.service';

// ─── Minimal Prisma Mock ──────────────────────────────────────────────────────
// ─── Minimal Prisma Mock ──────────────────────────────────────────────────────
const prismaMock = {
  exam: { findUnique: jest.fn() },
  attempt: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn(),
  },
  examQuestion: {
    findMany: jest.fn().mockResolvedValue([
      { id: 'eq-1', sectionId: 'sec-1', displayOrder: 1, question: { options: [] } },
    ]),
  },
  attemptQuestion: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(1),
  },
  attemptQuestionOption: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  answer: {
    upsert: jest.fn(),
    findMany: jest.fn(),
  },
  questionTimeLog: { create: jest.fn() },
  attemptStatus: { findUnique: jest.fn() },
  preferredLanguage: {
    findUnique: jest.fn().mockImplementation(({ where }) =>
      Promise.resolve({
        id: where?.id || 'lang-uuid',
        code: where?.id === 'hi' ? 'hi' : 'en',
        name: where?.id === 'hi' ? 'Hindi' : 'English',
        isActive: true,
      }),
    ),
    findFirst: jest.fn().mockImplementation(({ where }) =>
      Promise.resolve({
        id: 'lang-uuid',
        code: 'hi',
        name: 'Hindi',
        isActive: true,
      }),
    ),
  },
  examSecurityProfile: { findUnique: jest.fn().mockResolvedValue(null) },
  examLanguage: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
  $transaction: jest.fn((cb) => cb(prismaMock)),
};

import { ResultService } from '../result/result.service';

// ─── Mock Services ────────────────────────────────────────────────────────────
const examServiceMock = {
  getExamQuestionsForAttempt: jest.fn(),
};

const examAccessServiceMock = {
  validateStudentAccess: jest.fn(),
};

const questionTimingServiceMock = {
  finalizeActiveTiming: jest.fn().mockResolvedValue({}),
};

const resultServiceMock = {
  calculateResult: jest.fn(),
  getResult: jest.fn(),
  getFullAnalysis: jest.fn(),
};

// ─── Test Suite ───────────────────────────────────────────────────────────────
describe('ExamAttemptService', () => {
  let service: ExamAttemptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamAttemptService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ExamService, useValue: examServiceMock },
        { provide: ExamAccessService, useValue: examAccessServiceMock },
        { provide: QuestionTimingService, useValue: questionTimingServiceMock },
        { provide: ResultService, useValue: resultServiceMock },
        {
          provide: ResultReadinessService,
          useValue: { isLiveExam: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: QuestionShuffleService,
          useValue: {
            generateAttemptSeed: jest.fn().mockReturnValue('seed-123'),
            generateDeterministicSeed: jest
              .fn()
              .mockReturnValue('deterministic-seed-hash-123'),
            normalizeSeedToPostgresRange: jest.fn().mockReturnValue(0.5),
            shuffleQuestions: jest.fn().mockImplementation((q) => q),
            shuffleOptions: jest.fn().mockImplementation((opts) => opts),
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue('OK'),
            del: jest.fn().mockResolvedValue(1),
          },
        },
        {
          provide: ExamCacheService,
          useValue: {
            cachePublishedExamData: jest.fn().mockResolvedValue(undefined),
            getExamSnapshot: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getQueueToken(EVALUATION_QUEUE_NAME),
          useValue: {
            add: jest.fn().mockResolvedValue({ id: 'job-1' }),
          },
        },
      ],
    }).compile();

    service = module.get<ExamAttemptService>(ExamAttemptService);
    jest.clearAllMocks();
  });

  // ── startAttempt ─────────────────────────────────────────────────────────
  describe('startAttempt', () => {
    const studentId = 'student-uuid';
    const dto = { examId: 'exam-uuid', languageId: 'lang-uuid' };
    const accessResult = {
      isAllowed: true,
      examId: 'exam-uuid',
      examVersionId: 'version-uuid',
      scheduleId: 'schedule-uuid',
      serverTime: new Date(),
      startTime: new Date(),
      endTime: new Date(Date.now() + 7200000), // 2 hours
      timeRemainingSeconds: 7200,
    };
    const inProgressStatus = { id: 'status-uuid', name: 'IN_PROGRESS' };
    const exam = {
      id: 'exam-uuid',
      durationMinutes: 60,
      status: { name: 'ACTIVE' },
    };

    it('creates a new attempt when all checks pass', async () => {
      examAccessServiceMock.validateStudentAccess.mockResolvedValue(
        accessResult,
      );
      prismaMock.exam.findUnique.mockResolvedValue(exam);
      prismaMock.attempt.findFirst.mockResolvedValue(null); // no active in-progress
      prismaMock.attemptStatus.findUnique.mockResolvedValue(inProgressStatus);
      prismaMock.attempt.create.mockResolvedValue({ id: 'attempt-uuid' });
      prismaMock.attempt.findUnique.mockResolvedValue({
        id: 'attempt-uuid',
        exam: {},
        status: inProgressStatus,
        language: {},
        _count: { answers: 0 },
      });

      await service.startAttempt(dto, studentId, '127.0.0.1');

      expect(examAccessServiceMock.validateStudentAccess).toHaveBeenCalledWith(
        dto.examId,
        studentId,
      );
      expect(prismaMock.attempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            studentId,
            examId: dto.examId,
            scheduleId: accessResult.scheduleId,
            examVersionId: accessResult.examVersionId,
          }),
        }),
      );
    });

    it('throws ForbiddenException when ExamAccessService denies access', async () => {
      examAccessServiceMock.validateStudentAccess.mockRejectedValue(
        new ForbiddenException({
          code: 'EXAM_NOT_ACTIVE',
          message: 'Not active',
        }),
      );

      await expect(service.startAttempt(dto, studentId)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prismaMock.attempt.create).not.toHaveBeenCalled();
    });

    it('creates a brand new attempt even if user previously took the exam (multiple attempts allowed)', async () => {
      examAccessServiceMock.validateStudentAccess.mockResolvedValue(
        accessResult,
      );
      prismaMock.exam.findUnique.mockResolvedValue(exam);
      prismaMock.attempt.findFirst.mockResolvedValue(null); // no active in-progress attempt
      prismaMock.attemptStatus.findUnique.mockResolvedValue(inProgressStatus);
      prismaMock.attempt.create.mockResolvedValue({ id: 'new-attempt-uuid' });
      prismaMock.attempt.findUnique.mockResolvedValue({
        id: 'new-attempt-uuid',
        exam: {},
        status: inProgressStatus,
        language: {},
        _count: { answers: 0 },
      });

      await service.startAttempt(dto, studentId);
      expect(prismaMock.attempt.create).toHaveBeenCalled();
    });

    it('recovers an INTERRUPTED attempt and updates scheduleId', async () => {
      examAccessServiceMock.validateStudentAccess.mockResolvedValue(
        accessResult,
      );
      prismaMock.exam.findUnique.mockResolvedValue(exam);
      const interruptedAttempt = {
        id: 'old-attempt',
        status: { name: 'INTERRUPTED' },
        scheduleId: null,
        examVersionId: null,
      };
      prismaMock.attempt.findFirst.mockImplementation(({ where }: any) => {
        if (where?.examId?.not) return Promise.resolve(null);
        return Promise.resolve(interruptedAttempt);
      });
      prismaMock.attempt.findUnique.mockResolvedValue({
        id: 'old-attempt',
        exam: {},
        status: inProgressStatus,
        language: {},
        _count: { answers: 0 },
      });
      prismaMock.attemptStatus.findUnique.mockResolvedValue(inProgressStatus);
      prismaMock.attempt.update.mockResolvedValue({});

      await service.startAttempt(dto, studentId);

      expect(prismaMock.attempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'old-attempt' },
          data: expect.objectContaining({
            scheduleId: accessResult.scheduleId,
            examVersionId: accessResult.examVersionId,
          }),
        }),
      );
      expect(prismaMock.attempt.create).not.toHaveBeenCalled();
    });

    it('clamps serverEndTime to window endTime when exam duration exceeds window', async () => {
      // Exam is 180 mins but window ends in 60 mins → clamp to 60 mins
      const shortWindowEnd = new Date(Date.now() + 3600000); // 1 hour
      examAccessServiceMock.validateStudentAccess.mockResolvedValue({
        ...accessResult,
        endTime: shortWindowEnd,
        timeRemainingSeconds: 3600,
      });
      prismaMock.exam.findUnique.mockResolvedValue({
        ...exam,
        durationMinutes: 180,
      });
      prismaMock.attempt.findFirst.mockResolvedValue(null);
      prismaMock.attemptStatus.findUnique.mockResolvedValue(inProgressStatus);
      prismaMock.attempt.create.mockResolvedValue({ id: 'attempt-uuid' });
      prismaMock.attempt.findUnique.mockResolvedValue({
        id: 'attempt-uuid',
        exam: {},
        status: inProgressStatus,
        language: {},
        _count: { answers: 0 },
      });

      await service.startAttempt(dto, studentId);

      const createCall = prismaMock.attempt.create.mock.calls[0][0];
      const serverEndTime: Date = createCall.data.serverEndTime;

      // serverEndTime should be <= window end (within 1 second tolerance)
      expect(serverEndTime.getTime()).toBeLessThanOrEqual(
        shortWindowEnd.getTime() + 1000,
      );
    });
  });

  // ── saveAnswer ───────────────────────────────────────────────────────────
  describe('saveAnswer', () => {
    const studentId = 'student-uuid';
    const attemptId = 'attempt-uuid';
    const inProgressAttempt = {
      id: attemptId,
      studentId,
      status: { name: 'IN_PROGRESS' },
      serverEndTime: new Date(Date.now() + 3600000),
    };

    it('upserts an answer when attempt is in progress', async () => {
      prismaMock.attempt.findUnique.mockResolvedValue(inProgressAttempt);
      prismaMock.answer.upsert.mockResolvedValue({});

      const dto = { examQuestionId: 'q-uuid', selectedOptionId: 'opt-uuid' };
      const result = await service.saveAnswer(attemptId, dto, studentId);

      expect(prismaMock.answer.upsert).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Answer saved' });
    });

    it('throws ForbiddenException when student does not own attempt', async () => {
      prismaMock.attempt.findUnique.mockResolvedValue({
        ...inProgressAttempt,
        studentId: 'other-student',
      });

      await expect(
        service.saveAnswer(attemptId, { examQuestionId: 'q-uuid' }, studentId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when time has expired', async () => {
      prismaMock.attempt.findUnique.mockResolvedValue({
        ...inProgressAttempt,
        serverEndTime: new Date(Date.now() - 1000), // expired
      });
      prismaMock.attempt.update.mockResolvedValue({});
      prismaMock.attemptStatus.findUnique.mockResolvedValue({
        id: 'x',
        name: 'AUTO_SUBMITTED',
      });

      await expect(
        service.saveAnswer(attemptId, { examQuestionId: 'q-uuid' }, studentId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── submitAttempt ────────────────────────────────────────────────────────
  describe('submitAttempt', () => {
    const studentId = 'student-uuid';
    const attemptId = 'attempt-uuid';
    const inProgressAttempt = {
      id: attemptId,
      studentId,
      status: { name: 'IN_PROGRESS' },
    };

    it('submits and returns the updated attempt', async () => {
      prismaMock.attempt.findUnique
        .mockResolvedValueOnce(inProgressAttempt)
        .mockResolvedValueOnce({
          ...inProgressAttempt,
          status: { name: 'SUBMITTED' },
          exam: {},
          language: {},
          _count: { answers: 0 },
        });
      prismaMock.attemptStatus.findUnique.mockResolvedValue({
        id: 's-uuid',
        name: 'SUBMITTED',
      });
      prismaMock.attempt.update.mockResolvedValue({});

      const result = await service.submitAttempt(attemptId, studentId);
      expect(prismaMock.attempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ submittedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws BadRequestException when attempt is already submitted', async () => {
      prismaMock.attempt.findUnique.mockResolvedValue({
        ...inProgressAttempt,
        status: { name: 'SUBMITTED' },
      });

      await expect(service.submitAttempt(attemptId, studentId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── switchAttemptLanguage ────────────────────────────────────────────────
  describe('switchAttemptLanguage', () => {
    const studentId = 'student-uuid';
    const attemptId = 'attempt-uuid';
    const languageId = 'lang-uuid';

    const inProgressAttempt = {
      id: attemptId,
      studentId,
      examId: 'exam-uuid',
      status: { name: 'IN_PROGRESS' },
      serverEndTime: new Date(Date.now() + 3600000),
    };

    it('switches language atomically with no state loss', async () => {
      prismaMock.attempt.findUnique.mockResolvedValue(inProgressAttempt);
      prismaMock.preferredLanguage.findUnique.mockResolvedValue({
        id: languageId,
        code: 'hi',
        name: 'Hindi',
        nativeName: 'हिन्दी',
        isActive: true,
      });
      prismaMock.examLanguage.count.mockResolvedValue(0); // no restrictions
      prismaMock.attempt.update.mockResolvedValue({});

      const result = await service.switchAttemptLanguage(
        attemptId,
        languageId,
        studentId,
      );

      expect(prismaMock.attempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: attemptId },
          data: expect.objectContaining({ languageId }),
        }),
      );
      expect(result.language.code).toBe('hi');
    });

    it('throws BadRequestException for inactive language', async () => {
      prismaMock.attempt.findUnique.mockResolvedValue(inProgressAttempt);
      prismaMock.preferredLanguage.findUnique.mockResolvedValue(null);
      prismaMock.preferredLanguage.findFirst.mockResolvedValue({
        id: languageId,
        isActive: false,
      });

      await expect(
        service.switchAttemptLanguage(attemptId, languageId, studentId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getAttemptStatus ───────────────────────────────────────────────────
  describe('getAttemptStatus', () => {
    it('returns languageId, displayLanguageId, and language metadata along with attempt status and answers', async () => {
      const mockAttempt = {
        id: 'att-123',
        examId: 'exam-123',
        studentId: 'stud-123',
        languageId: 'lang-hi-uuid',
        displayLanguageId: 'lang-hi-uuid',
        language: {
          id: 'lang-hi-uuid',
          code: 'hi',
          name: 'Hindi',
          nativeName: 'हिन्दी',
        },
        startedAt: new Date(),
        serverEndTime: new Date(Date.now() + 3600000),
        scheduleId: 'sch-123',
        examVersionId: 'ver-123',
        status: { id: 'status-1', name: 'IN_PROGRESS' },
        student: { id: 'stud-123', userId: 'user-123' },
      };

      prismaMock.attempt.findUnique.mockResolvedValue(mockAttempt);
      prismaMock.answer.findMany.mockResolvedValue([
        {
          examQuestionId: 'eq-1',
          selectedOptionId: 'opt-1',
          numericalAnswer: null,
          selectedOptions: null,
          isMarkedForReview: false,
          answeredAt: new Date(),
        },
      ]);

      const res = await service.getAttemptStatus('att-123', 'stud-123');

      expect(res.attemptId).toBe('att-123');
      expect(res.status).toBe('IN_PROGRESS');
      expect(res.languageId).toBe('lang-hi-uuid');
      expect(res.displayLanguageId).toBe('lang-hi-uuid');
      expect(res.language?.code).toBe('hi');
      expect(res.language?.name).toBe('Hindi');
      expect(res.answers).toHaveLength(1);
    });
  });
});

