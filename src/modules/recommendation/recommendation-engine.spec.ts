import { Test, TestingModule } from '@nestjs/testing';
import { RecommendationEngineService } from './services/recommendation-engine.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RecommendationEngineService', () => {
  let service: RecommendationEngineService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      student: {
        findUnique: jest.fn(),
      },
      attempt: {
        findMany: jest.fn(),
      },
      exam: {
        findFirst: jest.fn(),
      },
      examTarget: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationEngineService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<RecommendationEngineService>(
      RecommendationEngineService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return empty recommendations when student has no completed attempts', async () => {
    prismaMock.student.findUnique.mockResolvedValue({
      id: 'student-1',
      examTargetId: 'target-neet',
      studentExamTargets: [],
    });
    prismaMock.attempt.findMany.mockResolvedValue([]);

    const recs = await service.generateStudentRecommendations('student-1');
    expect(recs).toEqual([]);
  });

  it('should flag a weak chapter with high confidence when sample size is sufficient', async () => {
    prismaMock.student.findUnique.mockResolvedValue({
      id: 'student-1',
      examTargetId: 'target-neet',
      studentExamTargets: [],
    });

    // Mock attempt with 25 questions in Thermodynamics (11 correct, 14 wrong -> 44% accuracy)
    prismaMock.attempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        submittedAt: new Date(),
        exam: {
          id: 'exam-1',
          title: 'NEET Mock 1',
          defaultNegativeMarks: 1,
          sections: [{ subject: { id: 'subj-phy', name: 'Physics' } }],
        },
        result: {
          totalScore: 400,
          wrongAnswers: 14,
          subjectResults: [
            {
              subject: { id: 'subj-phy', name: 'Physics' },
              totalQuestions: 45,
              correctAnswers: 20,
              wrongAnswers: 25,
              accuracy: 44.4,
            },
          ],
          chapterResults: [
            {
              chapter: {
                id: 'chap-thermo',
                name: 'Thermodynamics',
                subjectId: 'subj-phy',
                subject: { id: 'subj-phy', name: 'Physics' },
              },
              totalQuestions: 25,
              correctAnswers: 11,
              wrongAnswers: 14,
              unattempted: 0,
            },
          ],
        },
        answers: [],
        timeLogs: [],
      },
    ]);

    prismaMock.exam.findFirst.mockResolvedValue({
      id: 'mock-phy-1',
      title: 'Physics Chapter Mock: Thermodynamics',
      totalQuestions: 30,
      durationMinutes: 45,
    });

    const recs = await service.generateStudentRecommendations('student-1');

    expect(recs.length).toBeGreaterThan(0);
    const thermoRec = recs.find((r) => r.chapterName === 'Thermodynamics');
    expect(thermoRec).toBeDefined();
    expect(thermoRec?.type).toBe('WEAK_CHAPTER');
    expect(thermoRec?.confidence).toBe('HIGH');
    expect(thermoRec?.metrics?.sampleSize).toBe(25);
    expect(thermoRec?.metrics?.wrongCount).toBe(14);
    expect(thermoRec?.action.targetUrl).toContain('mock-phy-1');
  });

  it('should ignore weak chapters with insufficient sample size (1 question)', async () => {
    prismaMock.student.findUnique.mockResolvedValue({
      id: 'student-1',
      examTargetId: 'target-neet',
      studentExamTargets: [],
    });

    // Mock attempt with only 1 question in Optics (0 correct, 1 wrong -> 0% accuracy)
    prismaMock.attempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        submittedAt: new Date(),
        exam: {
          id: 'exam-1',
          title: 'NEET Mock 1',
          defaultNegativeMarks: 1,
          sections: [],
        },
        result: {
          totalScore: 500,
          wrongAnswers: 1,
          subjectResults: [],
          chapterResults: [
            {
              chapter: {
                id: 'chap-optics',
                name: 'Optics',
                subjectId: 'subj-phy',
                subject: { id: 'subj-phy', name: 'Physics' },
              },
              totalQuestions: 1, // Insufficient sample size
              correctAnswers: 0,
              wrongAnswers: 1,
              unattempted: 0,
            },
          ],
        },
        answers: [],
        timeLogs: [],
      },
    ]);

    const recs = await service.generateStudentRecommendations('student-1', {
      minChapterQuestionsForAnalysis: 2,
    });

    const opticsRec = recs.find((r) => r.chapterName === 'Optics');
    expect(opticsRec).toBeUndefined();
  });

  it('should detect declining trend across multiple attempts in a subject', async () => {
    prismaMock.student.findUnique.mockResolvedValue({
      id: 'student-1',
      examTargetId: 'target-neet',
      studentExamTargets: [],
    });

    // 3 attempts: latest accuracy 48%, middle 58%, oldest 68% -> drop of 20%
    prismaMock.attempt.findMany.mockResolvedValue([
      {
        id: 'att-3',
        submittedAt: new Date('2026-09-08'),
        exam: { id: 'e-3', sections: [] },
        result: {
          wrongAnswers: 5,
          subjectResults: [
            {
              subject: { id: 'subj-chem', name: 'Chemistry' },
              totalQuestions: 20,
              correctAnswers: 9,
              wrongAnswers: 11,
              accuracy: 45.0,
            },
          ],
          chapterResults: [],
        },
        answers: [],
        timeLogs: [],
      },
      {
        id: 'att-2',
        submittedAt: new Date('2026-09-05'),
        exam: { id: 'e-2', sections: [] },
        result: {
          wrongAnswers: 5,
          subjectResults: [
            {
              subject: { id: 'subj-chem', name: 'Chemistry' },
              totalQuestions: 20,
              correctAnswers: 11,
              wrongAnswers: 9,
              accuracy: 55.0,
            },
          ],
          chapterResults: [],
        },
        answers: [],
        timeLogs: [],
      },
      {
        id: 'att-1',
        submittedAt: new Date('2026-09-01'),
        exam: { id: 'e-1', sections: [] },
        result: {
          wrongAnswers: 5,
          subjectResults: [
            {
              subject: { id: 'subj-chem', name: 'Chemistry' },
              totalQuestions: 20,
              correctAnswers: 14,
              wrongAnswers: 6,
              accuracy: 70.0,
            },
          ],
          chapterResults: [],
        },
        answers: [],
        timeLogs: [],
      },
    ]);

    const recs = await service.generateStudentRecommendations('student-1');

    const declineRec = recs.find((r) => r.type === 'DECLINING_SUBJECT');
    expect(declineRec).toBeDefined();
    expect(declineRec?.subjectName).toBe('Chemistry');
    expect(declineRec?.metrics?.trendDelta).toBeLessThanOrEqual(-15);
  });

  it('should flag excessive negative penalty when avoidable marks lost >= 12', async () => {
    prismaMock.student.findUnique.mockResolvedValue({
      id: 'student-1',
      examTargetId: 'target-neet',
      studentExamTargets: [],
    });

    prismaMock.attempt.findMany.mockResolvedValue([
      {
        id: 'att-1',
        submittedAt: new Date(),
        exam: {
          id: 'exam-1',
          title: 'NEET Full Mock',
          defaultNegativeMarks: 1,
          sections: [],
        },
        result: {
          totalScore: 350,
          wrongAnswers: 18, // 18 negative marks lost
          subjectResults: [],
          chapterResults: [],
        },
        answers: [],
        timeLogs: [],
      },
    ]);

    const recs = await service.generateStudentRecommendations('student-1');

    const negRec = recs.find((r) => r.type === 'NEGATIVE_MARKING');
    expect(negRec).toBeDefined();
    expect(negRec?.metrics?.negativeMarksLost).toBe(18);
    expect(negRec?.title).toContain('Curtail Avoidable Negative Marking');
  });
});
