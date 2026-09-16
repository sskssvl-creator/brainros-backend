import { Test, TestingModule } from '@nestjs/testing';
import { StudentService } from './student.service';
import { ExamAccessService } from '../exam-scheduling/services/exam-access.service';
import { ExamLifecycleService } from '../exam-scheduling/services/exam-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityEventService } from '../auth/services/security-event.service';
import { OtpService } from '../auth/services/otp.service';
import { RedisService } from '../redis/redis.service';
import { ForbiddenException } from '@nestjs/common';
import {
  CANONICAL_TARGET_EXAMS,
  resolveEligibleExamTypes,
  normalizeTargetExamInput,
} from '../../common/constants/target-exam.constant';

describe('Student Target Exam & Actual Exam Eligibility (All 7 Combinations)', () => {
  let studentService: StudentService;
  let examAccessService: ExamAccessService;
  let prismaMock: any;

  const targetIdsMap: Record<string, string> = {
    JEE: 'jee-target-id',
    CET: 'cet-target-id',
    NEET: 'neet-target-id',
    'NEET + JEE': 'neet-jee-target-id',
    'NEET + State CET': 'neet-state-cet-target-id',
    'JEE + State CET': 'jee-state-cet-target-id',
    'JEE + NEET + State CET': 'jee-neet-state-cet-target-id',
  };

  const allExamTargetRecords = [
    { id: targetIdsMap['JEE'], name: 'JEE' },
    { id: targetIdsMap['CET'], name: 'CET' },
    { id: targetIdsMap['NEET'], name: 'NEET' },
    { id: targetIdsMap['NEET + JEE'], name: 'NEET + JEE' },
    { id: targetIdsMap['NEET + State CET'], name: 'NEET + State CET' },
    { id: targetIdsMap['JEE + State CET'], name: 'JEE + State CET' },
    { id: targetIdsMap['JEE + NEET + State CET'], name: 'JEE + NEET + State CET' },
  ];

  beforeEach(async () => {
    prismaMock = {
      student: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      exam: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      examTarget: {
        findMany: jest.fn().mockImplementation((args?: any) => {
          if (args?.where?.OR) {
            const names = args.where.OR.find((o: any) => o.name)?.name?.in || [];
            const ids = args.where.OR.find((o: any) => o.id)?.id?.in || [];
            return allExamTargetRecords.filter(
              (r) => names.includes(r.name) || ids.includes(r.id),
            );
          }
          return allExamTargetRecords;
        }),
      },
      studentExamTarget: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentService,
        ExamAccessService,
        {
          provide: ExamLifecycleService,
          useValue: {
            endExam: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: PrismaService, useValue: prismaMock },
        { provide: SecurityEventService, useValue: { log: jest.fn() } },
        { provide: OtpService, useValue: {} },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue('OK'),
            del: jest.fn().mockResolvedValue(1),
          },
        },
      ],
    }).compile();

    studentService = module.get<StudentService>(StudentService);
    examAccessService = module.get<ExamAccessService>(ExamAccessService);
  });

  describe('1. Canonical Target Normalization & Validation', () => {
    it('accepts exact 7 canonical combinations', () => {
      for (const target of CANONICAL_TARGET_EXAMS) {
        expect(normalizeTargetExamInput(target)).toBe(target);
      }
    });

    it('normalizes valid combinations and alias variations', () => {
      expect(normalizeTargetExamInput('JEE + NEET')).toBe('NEET + JEE');
      expect(normalizeTargetExamInput('NEET and JEE')).toBe('NEET + JEE');
      expect(normalizeTargetExamInput('NEET and State CET')).toBe('NEET + State CET');
      expect(normalizeTargetExamInput('State CET + NEET')).toBe('NEET + State CET');
      expect(normalizeTargetExamInput('JEE and State CET')).toBe('JEE + State CET');
      expect(normalizeTargetExamInput('State CET + JEE')).toBe('JEE + State CET');
      expect(normalizeTargetExamInput('JEE, NEET and State CET')).toBe('JEE + NEET + State CET');
      expect(normalizeTargetExamInput('NEET + JEE + State CET')).toBe('JEE + NEET + State CET');
    });

    it('rejects invalid combinations and values', () => {
      expect(normalizeTargetExamInput('JEE + CET')).toBeNull(); // Must be 'JEE + State CET'
      expect(normalizeTargetExamInput('State CET')).toBeNull(); // Standalone State CET invalid
      expect(normalizeTargetExamInput('JEE + State NEET')).toBeNull();
      expect(normalizeTargetExamInput('Physics')).toBeNull();
      expect(normalizeTargetExamInput('')).toBeNull();
      expect(normalizeTargetExamInput('   ')).toBeNull();
      expect(normalizeTargetExamInput('Random Target')).toBeNull();
    });
  });

  describe('2. Target Resolution to Actual Exam Types', () => {
    it('resolves JEE -> [JEE]', () => {
      expect(resolveEligibleExamTypes('JEE')).toEqual(['JEE']);
    });

    it('resolves CET -> [CET]', () => {
      expect(resolveEligibleExamTypes('CET')).toEqual(['CET']);
    });

    it('resolves NEET -> [NEET]', () => {
      expect(resolveEligibleExamTypes('NEET')).toEqual(['NEET']);
    });

    it('resolves NEET + JEE -> [NEET, JEE]', () => {
      expect(resolveEligibleExamTypes('NEET + JEE')).toEqual(['NEET', 'JEE']);
    });

    it('resolves NEET + State CET -> [NEET, CET]', () => {
      expect(resolveEligibleExamTypes('NEET + State CET')).toEqual(['NEET', 'CET']);
    });

    it('resolves JEE + State CET -> [JEE, CET]', () => {
      expect(resolveEligibleExamTypes('JEE + State CET')).toEqual(['JEE', 'CET']);
    });

    it('resolves JEE + NEET + State CET -> [JEE, NEET, CET]', () => {
      expect(resolveEligibleExamTypes('JEE + NEET + State CET')).toEqual([
        'JEE',
        'NEET',
        'CET',
      ]);
    });
  });

  describe('3. Student Dashboard Exam Listing Visibility (All 7 Targets)', () => {
    const testCases: Array<{
      target: string;
      expectedEligibleTargetIds: string[];
    }> = [
      {
        target: 'JEE',
        expectedEligibleTargetIds: [targetIdsMap['JEE']],
      },
      {
        target: 'CET',
        expectedEligibleTargetIds: [targetIdsMap['CET']],
      },
      {
        target: 'NEET',
        expectedEligibleTargetIds: [targetIdsMap['NEET']],
      },
      {
        target: 'NEET + JEE',
        expectedEligibleTargetIds: [
          targetIdsMap['NEET'],
          targetIdsMap['JEE'],
          targetIdsMap['NEET + JEE'],
        ],
      },
      {
        target: 'NEET + State CET',
        expectedEligibleTargetIds: [
          targetIdsMap['NEET'],
          targetIdsMap['CET'],
          targetIdsMap['NEET + State CET'],
        ],
      },
      {
        target: 'JEE + State CET',
        expectedEligibleTargetIds: [
          targetIdsMap['JEE'],
          targetIdsMap['CET'],
          targetIdsMap['JEE + State CET'],
        ],
      },
      {
        target: 'JEE + NEET + State CET',
        expectedEligibleTargetIds: [
          targetIdsMap['JEE'],
          targetIdsMap['NEET'],
          targetIdsMap['CET'],
          targetIdsMap['JEE + NEET + State CET'],
        ],
      },
    ];

    testCases.forEach(({ target, expectedEligibleTargetIds }) => {
      it(`enforces correct exam target filtering for student target: ${target}`, async () => {
        const studentId = 'student-test-id';
        const targetId = targetIdsMap[target];

        prismaMock.student.findFirst.mockResolvedValue({
          id: studentId,
          userId: 'user-test-id',
          examTargetId: targetId,
          examTarget: { id: targetId, name: target },
          studentExamTargets: [],
        });

        prismaMock.exam.findMany.mockResolvedValue([]);

        await studentService.getStudentExams('user-test-id', {});

        expect(prismaMock.exam.findMany).toHaveBeenCalled();
        const callArg = prismaMock.exam.findMany.mock.calls[0][0];
        const whereClause = callArg.where;

        // Verify the target filter in where clause
        const targetFilter = whereClause.AND.find((c: any) => c.OR && c.OR.some((o: any) => o.examTargetId));
        expect(targetFilter).toBeDefined();

        const filteredIds = targetFilter.OR.find((o: any) => o.examTargetId).examTargetId.in;
        for (const expId of expectedEligibleTargetIds) {
          expect(filteredIds).toContain(expId);
        }
      });
    });
  });

  describe('4. Direct API Security Enforcement (validateStudentAccess)', () => {
    const createMockExam = (examTargetName: string, examTargetId: string) => ({
      id: 'exam-123',
      examTargetId,
      examTarget: { id: examTargetId, name: examTargetName },
      durationMinutes: 60,
      status: { name: 'ACTIVE' },
      schedules: [
        {
          id: 'sched-123',
          status: 'ACTIVE',
          startTime: new Date(Date.now() - 1000 * 60 * 10), // Started 10m ago
          endTime: new Date(Date.now() + 1000 * 60 * 50), // Ends in 50m
          examVersionId: 'ver-123',
        },
      ],
    });

    it('NEET student accessing JEE exam -> REJECTED with EXAM_NOT_ELIGIBLE', async () => {
      const neetStudent = {
        id: 'student-neet',
        userId: 'user-neet',
        examTargetId: targetIdsMap['NEET'],
        examTarget: { id: targetIdsMap['NEET'], name: 'NEET' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(neetStudent);

      const jeeExam = createMockExam('JEE', targetIdsMap['JEE']);
      prismaMock.exam.findUnique.mockResolvedValue(jeeExam);

      await expect(
        examAccessService.validateStudentAccess('exam-123', 'student-neet'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('JEE student accessing NEET exam -> REJECTED with EXAM_NOT_ELIGIBLE', async () => {
      const jeeStudent = {
        id: 'student-jee',
        userId: 'user-jee',
        examTargetId: targetIdsMap['JEE'],
        examTarget: { id: targetIdsMap['JEE'], name: 'JEE' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(jeeStudent);

      const neetExam = createMockExam('NEET', targetIdsMap['NEET']);
      prismaMock.exam.findUnique.mockResolvedValue(neetExam);

      await expect(
        examAccessService.validateStudentAccess('exam-123', 'student-jee'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('CET student accessing JEE exam -> REJECTED with EXAM_NOT_ELIGIBLE', async () => {
      const cetStudent = {
        id: 'student-cet',
        userId: 'user-cet',
        examTargetId: targetIdsMap['CET'],
        examTarget: { id: targetIdsMap['CET'], name: 'CET' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(cetStudent);

      const jeeExam = createMockExam('JEE', targetIdsMap['JEE']);
      prismaMock.exam.findUnique.mockResolvedValue(jeeExam);

      await expect(
        examAccessService.validateStudentAccess('exam-123', 'student-cet'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('NEET + JEE student accessing NEET exam -> ALLOWED', async () => {
      const comboStudent = {
        id: 'student-combo',
        userId: 'user-combo',
        examTargetId: targetIdsMap['NEET + JEE'],
        examTarget: { id: targetIdsMap['NEET + JEE'], name: 'NEET + JEE' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(comboStudent);

      const neetExam = createMockExam('NEET', targetIdsMap['NEET']);
      prismaMock.exam.findUnique.mockResolvedValue(neetExam);

      const res = await examAccessService.validateStudentAccess('exam-123', 'student-combo');
      expect(res.isAllowed).toBe(true);
    });

    it('NEET + JEE student accessing JEE exam -> ALLOWED', async () => {
      const comboStudent = {
        id: 'student-combo',
        userId: 'user-combo',
        examTargetId: targetIdsMap['NEET + JEE'],
        examTarget: { id: targetIdsMap['NEET + JEE'], name: 'NEET + JEE' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(comboStudent);

      const jeeExam = createMockExam('JEE', targetIdsMap['JEE']);
      prismaMock.exam.findUnique.mockResolvedValue(jeeExam);

      const res = await examAccessService.validateStudentAccess('exam-123', 'student-combo');
      expect(res.isAllowed).toBe(true);
    });

    it('NEET + JEE student accessing CET exam -> REJECTED with EXAM_NOT_ELIGIBLE', async () => {
      const comboStudent = {
        id: 'student-combo',
        userId: 'user-combo',
        examTargetId: targetIdsMap['NEET + JEE'],
        examTarget: { id: targetIdsMap['NEET + JEE'], name: 'NEET + JEE' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(comboStudent);

      const cetExam = createMockExam('CET', targetIdsMap['CET']);
      prismaMock.exam.findUnique.mockResolvedValue(cetExam);

      await expect(
        examAccessService.validateStudentAccess('exam-123', 'student-combo'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('JEE + State CET student accessing CET exam -> ALLOWED', async () => {
      const comboStudent = {
        id: 'student-combo-2',
        userId: 'user-combo-2',
        examTargetId: targetIdsMap['JEE + State CET'],
        examTarget: { id: targetIdsMap['JEE + State CET'], name: 'JEE + State CET' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(comboStudent);

      const cetExam = createMockExam('CET', targetIdsMap['CET']);
      prismaMock.exam.findUnique.mockResolvedValue(cetExam);

      const res = await examAccessService.validateStudentAccess('exam-123', 'student-combo-2');
      expect(res.isAllowed).toBe(true);
    });

    it('JEE + State CET student accessing NEET exam -> REJECTED with EXAM_NOT_ELIGIBLE', async () => {
      const comboStudent = {
        id: 'student-combo-2',
        userId: 'user-combo-2',
        examTargetId: targetIdsMap['JEE + State CET'],
        examTarget: { id: targetIdsMap['JEE + State CET'], name: 'JEE + State CET' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(comboStudent);

      const neetExam = createMockExam('NEET', targetIdsMap['NEET']);
      prismaMock.exam.findUnique.mockResolvedValue(neetExam);

      await expect(
        examAccessService.validateStudentAccess('exam-123', 'student-combo-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('JEE + NEET + State CET student accessing any of the 3 exams -> ALLOWED', async () => {
      const allInOneStudent = {
        id: 'student-all',
        userId: 'user-all',
        examTargetId: targetIdsMap['JEE + NEET + State CET'],
        examTarget: { id: targetIdsMap['JEE + NEET + State CET'], name: 'JEE + NEET + State CET' },
        studentExamTargets: [],
      };
      prismaMock.student.findFirst.mockResolvedValue(allInOneStudent);

      for (const examName of ['JEE', 'NEET', 'CET']) {
        const exam = createMockExam(examName, targetIdsMap[examName]);
        prismaMock.exam.findUnique.mockResolvedValue(exam);

        const res = await examAccessService.validateStudentAccess('exam-123', 'student-all');
        expect(res.isAllowed).toBe(true);
      }
    });
  });
});
