import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ExamLifecycleService } from './services/exam-lifecycle.service';
import { ExamScheduleService } from './services/exam-schedule.service';
import { ExamAccessService } from './services/exam-access.service';
import { NotificationQueueService } from '../notification/queues/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { getQueueToken } from '@nestjs/bullmq';
import { EXAM_WINDOW_END_QUEUE_NAME } from '../result/interfaces/result-lifecycle.interface';
import { EXAM_CACHE_PREPARATION_QUEUE_NAME } from '../exam-cache/interfaces/exam-cache.interface';
import { ExamCacheService } from '../exam-cache/services/exam-cache.service';
import { ScheduleReminderService } from './services/schedule-reminder.service';

describe('Exam Scheduling & Activation Engine', () => {
  let lifecycleService: ExamLifecycleService;
  let scheduleService: ExamScheduleService;
  let accessService: ExamAccessService;

  const mockPrismaService = {
    examStatus: {
      findUnique: jest.fn(),
      create: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: `status-${data.name}`, name: data.name }),
        ),
    },
    exam: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    examSchedule: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    examLifecycleHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    approvalRequest: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    student: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamLifecycleService,
        ExamScheduleService,
        ExamAccessService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: NotificationQueueService,
          useValue: {
            queueExamPublishedNotification: jest.fn().mockResolvedValue(true),
            dispatchExamNotificationJob: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: ExamCacheService,
          useValue: {
            cachePublishedExamData: jest.fn().mockResolvedValue(undefined),
            getExamSnapshot: jest.fn().mockResolvedValue(null),
            invalidateStudentDashboards: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ScheduleReminderService,
          useValue: {
            scheduleExamWhatsAppReminders: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getQueueToken(EXAM_WINDOW_END_QUEUE_NAME),
          useValue: {
            add: jest.fn().mockResolvedValue({ id: 'window-job-1' }),
            getJob: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getQueueToken(EXAM_CACHE_PREPARATION_QUEUE_NAME),
          useValue: {
            add: jest.fn().mockResolvedValue({ id: 'cache-prep-1' }),
          },
        },
      ],
    }).compile();

    lifecycleService = module.get<ExamLifecycleService>(ExamLifecycleService);
    scheduleService = module.get<ExamScheduleService>(ExamScheduleService);
    accessService = module.get<ExamAccessService>(ExamAccessService);

    jest.clearAllMocks();
  });

  describe('1. Exam Lifecycle State Machine Transitions', () => {
    it('should allow valid transition sequence: DRAFT -> SUBMITTED -> APPROVED -> SCHEDULED -> ACTIVE -> ENDED -> EVALUATING -> COMPLETED', () => {
      expect(() =>
        lifecycleService.validateTransition('DRAFT', 'SUBMITTED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('SUBMITTED', 'APPROVED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('APPROVED', 'SCHEDULED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('SCHEDULED', 'ACTIVE'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('ACTIVE', 'ENDED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('ENDED', 'EVALUATING'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('EVALUATING', 'COMPLETED'),
      ).not.toThrow();
    });

    it('should reject invalid arbitrary status jumps (e.g. DRAFT -> ACTIVE, APPROVED -> ACTIVE, COMPLETED -> CANCELLED)', () => {
      expect(() =>
        lifecycleService.validateTransition('DRAFT', 'ACTIVE'),
      ).toThrow(BadRequestException);
      expect(() =>
        lifecycleService.validateTransition('APPROVED', 'ACTIVE'),
      ).toThrow(BadRequestException);
      expect(() =>
        lifecycleService.validateTransition('COMPLETED', 'CANCELLED'),
      ).toThrow(BadRequestException);
      expect(() =>
        lifecycleService.validateTransition('ENDED', 'ACTIVE'),
      ).toThrow(BadRequestException);
    });

    it('should allow cancellation from pre-live states (DRAFT, SUBMITTED, APPROVED, SCHEDULED, ACTIVE)', () => {
      expect(() =>
        lifecycleService.validateTransition('DRAFT', 'CANCELLED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('SUBMITTED', 'CANCELLED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('APPROVED', 'CANCELLED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('SCHEDULED', 'CANCELLED'),
      ).not.toThrow();
      expect(() =>
        lifecycleService.validateTransition('ACTIVE', 'CANCELLED'),
      ).not.toThrow();
    });
  });

  describe('2. Exam Scheduling Workflow', () => {
    it('should schedule an APPROVED exam and transition status to SCHEDULED', async () => {
      const mockExam = {
        id: 'exam-1',
        title: 'NEET Practice',
        status: { name: 'APPROVED' },
        versions: [{ id: 'ver-1', versionNumber: 1 }],
      };

      mockPrismaService.exam.findUnique.mockResolvedValue(mockExam);
      mockPrismaService.examSchedule.create.mockResolvedValue({
        id: 'sch-1',
        examId: 'exam-1',
        examVersionId: 'ver-1',
        status: 'SCHEDULED',
      });

      const startTime = new Date(Date.now() + 3600000).toISOString();
      const endTime = new Date(Date.now() + 7200000).toISOString();

      const result = await scheduleService.scheduleExam(
        'exam-1',
        {
          examVersionId: 'ver-1',
          startTime,
          endTime,
          timezone: 'Asia/Kolkata',
        },
        'user-admin',
      );

      expect(result).toBeDefined();
      expect(mockPrismaService.examSchedule.create).toHaveBeenCalled();
      expect(
        mockPrismaService.examLifecycleHistory.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'SCHEDULE',
            fromStatus: 'APPROVED',
            toStatus: 'SCHEDULED',
          }),
        }),
      );
    });

    it('should reject scheduling if startTime >= endTime', async () => {
      const mockExam = {
        id: 'exam-1',
        status: { name: 'APPROVED' },
        versions: [{ id: 'ver-1' }],
      };

      mockPrismaService.exam.findUnique.mockResolvedValue(mockExam);

      const startTime = '2026-09-01T13:00:00Z';
      const endTime = '2026-09-01T10:00:00Z'; // Invalid: after start

      await expect(
        scheduleService.scheduleExam(
          'exam-1',
          { examVersionId: 'ver-1', startTime, endTime },
          'user-admin',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject scheduling if exam is not APPROVED (e.g. DRAFT or SUBMITTED)', async () => {
      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        status: { name: 'DRAFT' },
        versions: [{ id: 'ver-1' }],
      });

      await expect(
        scheduleService.scheduleExam(
          'exam-1',
          {
            examVersionId: 'ver-1',
            startTime: '2026-09-01T10:00:00Z',
            endTime: '2026-09-01T13:00:00Z',
          },
          'user-admin',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('3. Super Admin Activation (SCHEDULED -> ACTIVE)', () => {
    it('should activate a SCHEDULED exam and update status to ACTIVE', async () => {
      const mockSchedule = {
        id: 'sch-1',
        examId: 'exam-1',
        examVersionId: 'ver-1',
        status: 'SCHEDULED',
        startTime: new Date('2026-09-01T10:00:00Z'),
        endTime: new Date('2026-09-01T13:00:00Z'),
        exam: { id: 'exam-1', status: { name: 'SCHEDULED' } },
        examVersion: { id: 'ver-1' },
      };

      mockPrismaService.examSchedule.findUnique.mockResolvedValue(mockSchedule);
      mockPrismaService.examSchedule.update.mockResolvedValue({
        ...mockSchedule,
        status: 'ACTIVE',
      });

      const res = await scheduleService.activateExam('sch-1', 'super-admin-1');

      expect(res.message).toContain('activated');
      expect(mockPrismaService.examSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    });

    it('should handle activation idempotency cleanly if already ACTIVE', async () => {
      const mockActiveSchedule = {
        id: 'sch-1',
        examId: 'exam-1',
        status: 'ACTIVE',
      };

      mockPrismaService.examSchedule.findUnique.mockResolvedValue(
        mockActiveSchedule,
      );

      const res = await scheduleService.activateExam('sch-1', 'super-admin-1');
      expect(res.message).toContain('already activated');
    });
  });

  describe('4. Server-Authoritative Student Access Policy (APPROVED ≠ ACTIVE)', () => {
    it('Scenario 2: APPROVED inside time window -> Student Access DENIED', async () => {
      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        status: { name: 'APPROVED' },
        schedules: [],
      });

      await expect(
        accessService.validateStudentAccess('exam-1', 'student-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Scenario 3: SCHEDULED inside time window -> Student Access DENIED (Super Admin has not activated yet)', async () => {
      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        status: { name: 'SCHEDULED' },
        schedules: [
          {
            id: 'sch-1',
            status: 'SCHEDULED',
            startTime: new Date(Date.now() - 60000),
            endTime: new Date(Date.now() + 3600000),
          },
        ],
      });

      await expect(
        accessService.validateStudentAccess('exam-1', 'student-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Scenario 4: ACTIVE but before startTime -> Student Access DENIED (EXAM_NOT_YET_STARTED)', async () => {
      const futureStart = new Date(Date.now() + 1800000); // 30 mins in future
      const futureEnd = new Date(Date.now() + 5400000);

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        status: { name: 'ACTIVE' },
        schedules: [
          {
            id: 'sch-1',
            examVersionId: 'ver-1',
            status: 'ACTIVE',
            startTime: futureStart,
            endTime: futureEnd,
          },
        ],
      });

      await expect(
        accessService.validateStudentAccess('exam-1', 'student-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Scenario 5: ACTIVE and within live window (startTime <= now < endTime) -> Student Access ALLOWED', async () => {
      const pastStart = new Date(Date.now() - 1800000); // 30 mins ago
      const futureEnd = new Date(Date.now() + 3600000); // 1 hr in future

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        examTargetId: 'target-neet',
        status: { name: 'ACTIVE' },
        schedules: [
          {
            id: 'sch-1',
            examVersionId: 'ver-1',
            status: 'ACTIVE',
            startTime: pastStart,
            endTime: futureEnd,
          },
        ],
      });

      mockPrismaService.student.findUnique.mockResolvedValue({
        id: 'student-1',
        examTargetId: 'target-neet',
      });

      const access = await accessService.validateStudentAccess(
        'exam-1',
        'student-1',
      );
      expect(access.isAllowed).toBe(true);
      expect(access.examVersionId).toBe('ver-1');
      expect(access.timeRemainingSeconds).toBeGreaterThan(0);
    });

    it('Scenario 6: ACTIVE but after endTime -> Student Access DENIED (EXAM_ENDED)', async () => {
      const pastStart = new Date(Date.now() - 7200000); // 2 hrs ago
      const pastEnd = new Date(Date.now() - 1000); // 1 sec ago

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        status: { name: 'ACTIVE' },
        schedules: [
          {
            id: 'sch-1',
            examVersionId: 'ver-1',
            status: 'ACTIVE',
            startTime: pastStart,
            endTime: pastEnd,
          },
        ],
      });

      await expect(
        accessService.validateStudentAccess('exam-1', 'student-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('5. Schedule Admin Exam Validation (Global Subjects & Target Mapping)', () => {
    it('should reject JEE exam when Biology is selected', async () => {
      mockPrismaService.examTarget = {
        findUnique: jest.fn().mockResolvedValue({ id: 'target-jee', name: 'JEE' }),
      };
      mockPrismaService.examTargetSubject = {
        findUnique: jest.fn().mockResolvedValue(null), // Disallowed
      };
      mockPrismaService.subject = {
        findUnique: jest.fn().mockResolvedValue({ id: 'subj-bio', name: 'Biology' }),
      };

      await expect(
        scheduleService.scheduleAdminExam(
          {
            examType: 'SPECIFIC_SUBJECT',
            examTargetId: 'target-jee',
            subjectId: 'subj-bio',
            title: 'JEE Biology Test',
            totalQuestions: 30,
            durationMinutes: 60,
            startTime: new Date(Date.now() + 3600000).toISOString(),
          },
          'admin-user',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject NEET exam when Mathematics is selected', async () => {
      mockPrismaService.examTarget = {
        findUnique: jest.fn().mockResolvedValue({ id: 'target-neet', name: 'NEET' }),
      };
      mockPrismaService.examTargetSubject = {
        findUnique: jest.fn().mockResolvedValue(null), // Disallowed
      };
      mockPrismaService.subject = {
        findUnique: jest.fn().mockResolvedValue({ id: 'subj-math', name: 'Mathematics' }),
      };

      await expect(
        scheduleService.scheduleAdminExam(
          {
            examType: 'SPECIFIC_SUBJECT',
            examTargetId: 'target-neet',
            subjectId: 'subj-math',
            title: 'NEET Math Test',
            totalQuestions: 30,
            durationMinutes: 60,
            startTime: new Date(Date.now() + 3600000).toISOString(),
          },
          'admin-user',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject Specific Chapter exam when chapter does not belong to the selected subject', async () => {
      mockPrismaService.examTarget = {
        findUnique: jest.fn().mockResolvedValue({ id: 'target-jee', name: 'JEE' }),
      };
      mockPrismaService.examTargetSubject = {
        findUnique: jest.fn().mockResolvedValue({ examTargetId: 'target-jee', subjectId: 'subj-phy' }),
      };
      mockPrismaService.subject = {
        findUnique: jest.fn().mockResolvedValue({ id: 'subj-phy', name: 'Physics' }),
      };
      mockPrismaService.chapter = {
        findUnique: jest.fn().mockResolvedValue({ id: 'chap-chem', subjectId: 'subj-chem', name: 'Thermodynamics' }), // Mismatch!
      };

      await expect(
        scheduleService.scheduleAdminExam(
          {
            examType: 'SPECIFIC_CHAPTER',
            examTargetId: 'target-jee',
            subjectId: 'subj-phy',
            chapterId: 'chap-chem',
            title: 'JEE Physics Invalid Chapter Test',
            totalQuestions: 30,
            durationMinutes: 60,
            startTime: new Date(Date.now() + 3600000).toISOString(),
          },
          'admin-user',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
