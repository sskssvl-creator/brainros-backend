import { Test, TestingModule } from '@nestjs/testing';
import { AnalysisEngineService } from './services/analysis-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PERFORMANCE_THRESHOLDS } from './interfaces/analysis.interface';

const prismaMock = {
  attempt: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  examQuestion: {
    findMany: jest.fn(),
  },
};

describe('AnalysisEngineService', () => {
  let service: AnalysisEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalysisEngineService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<AnalysisEngineService>(AnalysisEngineService);
    jest.clearAllMocks();
  });

  describe('evaluateStatus with configurable thresholds', () => {
    it('returns NOT_ATTEMPTED when 0 questions attempted', () => {
      expect(service.evaluateStatus(0, 0, DEFAULT_PERFORMANCE_THRESHOLDS)).toBe(
        'NOT_ATTEMPTED',
      );
    });

    it('returns EXCELLENT when accuracy >= 90', () => {
      expect(
        service.evaluateStatus(91, 10, DEFAULT_PERFORMANCE_THRESHOLDS),
      ).toBe('EXCELLENT');
    });

    it('returns STRONG when accuracy is between 75 and 89', () => {
      expect(
        service.evaluateStatus(79.5, 10, DEFAULT_PERFORMANCE_THRESHOLDS),
      ).toBe('STRONG');
    });

    it('returns GOOD when accuracy is between 60 and 74', () => {
      expect(
        service.evaluateStatus(65, 10, DEFAULT_PERFORMANCE_THRESHOLDS),
      ).toBe('GOOD');
    });

    it('returns WEAK when accuracy is between 40 and 59', () => {
      expect(
        service.evaluateStatus(48, 10, DEFAULT_PERFORMANCE_THRESHOLDS),
      ).toBe('WEAK');
    });

    it('returns CRITICAL when accuracy < 40', () => {
      expect(
        service.evaluateStatus(35, 10, DEFAULT_PERFORMANCE_THRESHOLDS),
      ).toBe('CRITICAL');
    });

    it('honors custom per-exam thresholds', () => {
      const customThresholds = {
        excellent: 95,
        strong: 85,
        good: 70,
        weak: 50,
      };
      expect(service.evaluateStatus(91, 10, customThresholds)).toBe('STRONG');
      expect(service.evaluateStatus(48, 10, customThresholds)).toBe('CRITICAL');
    });
  });

  describe('generateFullAnalysis', () => {
    it('generates a complete analysis report with subject, chapter, time, and recommendations', async () => {
      const mockAttempt = {
        id: 'attempt-uuid',
        startedAt: new Date(Date.now() - 3600000), // 1 hour ago
        submittedAt: new Date(),
        exam: {
          id: 'exam-uuid',
          title: 'JEE Advanced Mock 1',
          durationMinutes: 60,
          totalQuestions: 10,
          defaultMarksPerQuestion: 4,
          defaultNegativeMarks: 1,
          performanceThresholds: null,
          examTarget: { name: 'JEE Advanced' },
        },
        result: {
          totalQuestions: 10,
          correctAnswers: 7,
          wrongAnswers: 2,
          unattempted: 1,
          totalScore: 26,
          maxScore: 40,
          percentage: 65,
          accuracy: 77.78,
          calculatedAt: new Date(),
          subjectResults: [
            {
              subjectId: 'phys-id',
              subject: { name: 'Physics' },
              totalQuestions: 5,
              correctAnswers: 4,
              wrongAnswers: 1,
              unattempted: 0,
              score: 15,
              maxScore: 20,
              accuracy: 80,
            },
            {
              subjectId: 'chem-id',
              subject: { name: 'Chemistry' },
              totalQuestions: 5,
              correctAnswers: 3,
              wrongAnswers: 1,
              unattempted: 1,
              score: 11,
              maxScore: 20,
              accuracy: 75,
            },
          ],
          chapterResults: [
            {
              chapterId: 'optics-id',
              chapter: {
                name: 'Optics',
                subjectId: 'phys-id',
                subject: { name: 'Physics' },
              },
              totalQuestions: 3,
              correctAnswers: 3,
              wrongAnswers: 0,
              unattempted: 0,
              score: 12,
              maxScore: 12,
              accuracy: 100,
            },
            {
              chapterId: 'thermo-id',
              chapter: {
                name: 'Thermodynamics',
                subjectId: 'chem-id',
                subject: { name: 'Chemistry' },
              },
              totalQuestions: 3,
              correctAnswers: 1,
              wrongAnswers: 1,
              unattempted: 1,
              score: 3,
              maxScore: 12,
              accuracy: 50,
            },
          ],
        },
        answers: [
          {
            examQuestionId: 'eq-1',
            selectedOptionId: 'opt-1',
            isMarkedForReview: false,
            examQuestion: {
              id: 'eq-1',
              marks: 4,
              negativeMarks: 1,
              question: {
                chapterId: 'optics-id',
                questionType: { code: 'SCQ' },
                options: [{ id: 'opt-1', isCorrect: true }],
              },
            },
          },
        ],
        timeLogs: [{ examQuestionId: 'eq-1', timeSpentSeconds: 45 }],
      };

      prismaMock.attempt.findUnique.mockResolvedValue(mockAttempt);
      prismaMock.attempt.findMany.mockResolvedValue([
        {
          id: 'prev-attempt-1',
          submittedAt: new Date(Date.now() - 86400000),
          exam: { title: 'Test 01' },
          result: { totalScore: 20, maxScore: 40, percentage: 50 },
          candidateRanks: [{ rankType: 'OVERALL', percentile: 75.5 }],
        },
      ]);
      prismaMock.examQuestion.findMany.mockResolvedValue([
        {
          id: 'eq-1',
          marks: 4,
          negativeMarks: 1,
          section: { name: 'Physics' },
          question: {
            chapterId: 'optics-id',
            questionType: { code: 'SCQ' },
            chapter: { subject: { name: 'Physics' } },
            options: [{ id: 'opt-1', isCorrect: true }],
          },
        },
      ]);

      const report = await service.generateFullAnalysis('attempt-uuid');

      expect(report).toBeDefined();
      expect(report.overall.totalMarks).toBe(40);
      expect(report.overall.obtainedMarks).toBe(26);
      expect(report.overall.accuracy).toBe(77.78);
      expect(report.subjects.items).toHaveLength(2);
      expect(report.subjects.strongestSubject?.subjectName).toBe('Physics');
      expect(report.chapters.items).toHaveLength(2);
      expect(report.timeAnalysis).toBeDefined();
      expect(report.attemptStrategy).toBeDefined();
      expect(report.recommendations.length).toBeGreaterThan(0);

      // Verify All 14 Canonical Sections
      expect(report.studentDetails).toBeDefined();
      expect(report.studentDetails.totalQuestions).toBe(10);
      expect(report.overallPerformance).toBeDefined();
      expect(report.overallPerformance.totalMarks).toBe(26);
      expect(report.overallPerformance.maximumMarks).toBe(40);
      expect(report.subjectWiseAnalysis).toBeDefined();
      expect(report.subjectWiseAnalysis.rows).toHaveLength(2);
      expect(report.subjectWiseAnalysis.total.score).toBe(26);
      expect(report.subjectPerformance).toBeDefined();
      expect(report.subjectPerformance.length).toBe(2);
      expect(report.topicWisePerformance).toBeDefined();
      expect(report.strengthWeaknessAnalysis).toBeDefined();
      expect(report.strengthWeaknessAnalysis.topStrengths.length).toBeGreaterThan(0);
      expect(report.errorAnalysis).toBeDefined();
      expect(report.errorAnalysis.totalWrong).toBe(2);
      expect(report.timeManagement).toBeDefined();
      expect(report.performanceTrend).toBeDefined();
      expect(report.performanceTrend.history.length).toBeGreaterThan(0);
      expect(report.expectedPerformance).toBeDefined();
      expect(report.expectedPerformance.currentScore).toBe(26);
      expect(report.improvementPlan).toBeDefined();
      expect(report.improvementPlan.blocks.length).toBeGreaterThan(0);
      expect(report.actionChecklist).toBeDefined();
      expect(report.actionChecklist.items.length).toBeGreaterThan(0);
      expect(report.parentSummary).toBeDefined();
      expect(report.parentSummary.summaryParagraph.length).toBeGreaterThan(0);
      expect(report.performanceIndex).toBeDefined();
      expect(report.performanceIndex.metrics.length).toBe(6);
    });
  });
});
