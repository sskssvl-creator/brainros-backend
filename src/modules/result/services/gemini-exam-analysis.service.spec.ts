import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  GeminiExamAnalysisService,
  StudentExamAiContext,
} from './gemini-exam-analysis.service';

describe('GeminiExamAnalysisService', () => {
  let service: GeminiExamAnalysisService;

  const sampleContext: StudentExamAiContext = {
    student: {
      id: 'stu-1',
      name: 'Rohan Sharma',
      studentCode: 'BR26-STU-001',
      className: 'Class 12',
      targetExam: 'NEET Mock Test',
    },
    exam: {
      id: 'exam-1',
      title: 'NEET Grand Mock Test',
      durationMinutes: 180,
      totalQuestions: 180,
      maxScore: 720,
      defaultMarksPerQuestion: 4,
      negativeMarksPerQuestion: 1,
    },
    overall: {
      score: 540,
      maxScore: 720,
      percentage: 75,
      accuracy: 82,
      correctCount: 140,
      wrongCount: 30,
      unattemptedCount: 10,
      negativeMarksLost: 30,
      totalTimeUsedSeconds: 9800,
      averageTimePerQuestionSeconds: 57.6,
    },
    subjects: [
      {
        subjectName: 'Physics',
        score: 140,
        maxScore: 180,
        accuracy: 80,
        percentage: 77.8,
        correct: 36,
        wrong: 9,
        unattempted: 0,
        timeSpentSeconds: 3200,
      },
      {
        subjectName: 'Chemistry',
        score: 150,
        maxScore: 180,
        accuracy: 85,
        percentage: 83.3,
        correct: 38,
        wrong: 7,
        unattempted: 0,
        timeSpentSeconds: 3100,
      },
      {
        subjectName: 'Biology',
        score: 250,
        maxScore: 360,
        accuracy: 81,
        percentage: 69.4,
        correct: 66,
        wrong: 14,
        unattempted: 10,
        timeSpentSeconds: 3500,
      },
    ],
    chapters: [
      {
        chapterName: 'Optics',
        subjectName: 'Physics',
        totalQuestions: 10,
        correct: 8,
        wrong: 2,
        unattempted: 0,
        accuracy: 80,
        status: 'STRONG',
      },
      {
        chapterName: 'Electrochemistry',
        subjectName: 'Chemistry',
        totalQuestions: 10,
        correct: 5,
        wrong: 5,
        unattempted: 0,
        accuracy: 50,
        status: 'CRITICAL',
      },
    ],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeminiExamAnalysisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'GEMINI_API_KEY') return '';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<GeminiExamAnalysisService>(GeminiExamAnalysisService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Heuristic Fallback and Predict Flow', () => {
    it('returns valid prediction structure when API key is missing (fallback path)', async () => {
      const result = await service.predictExamInsights(sampleContext);

      expect(result).toBeDefined();
      expect(result.metadata.isAiGenerated).toBe(false);
      expect(result.metadata.provider).toBe('heuristic_fallback');

      // 1. Error Analysis verification
      expect(result.errorAnalysis).toBeDefined();
      expect(result.errorAnalysis.totalWrong).toBe(30);
      expect(result.errorAnalysis.categories.length).toBe(5);
      expect(result.errorAnalysis.potentialRecoverableMarks).toBeGreaterThan(0);

      // 2. 14-Day Plan verification
      expect(result.fourteenDayPlan.blocks.length).toBe(7);
      expect(result.fourteenDayPlan.blocks[0].period).toBe('Days 1–3');

      // 3. Action Checklist verification
      expect(result.actionChecklist.items.length).toBe(8);
      expect(result.actionChecklist.items[0].isKeyAction).toBe(true);

      // 4. Parent Summary verification
      expect(result.parentSummary.summaryParagraph).toContain('Rohan Sharma');
      expect(result.parentSummary.keyHighlights.length).toBe(3);

      // 5. Performance Index verification
      expect(result.performanceIndex.metrics.length).toBe(6);
      expect(result.performanceIndex.overallRating).toBeDefined();

      // 6. Expected targets verification
      expect(result.expectedPerformance.currentScore).toBe(540);
      expect(result.expectedPerformance.shortTermTarget).toBeGreaterThanOrEqual(540);
    });
  });
});
