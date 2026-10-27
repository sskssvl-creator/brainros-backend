import { AiTranslationParentProcessor } from '../processors/ai-translation-parent.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { GeminiTranslationService } from '../services/gemini-translation.service';
import { ExamCacheService } from '../../exam/services/exam-cache.service';

describe('AiTranslation State Integrity & Idempotency', () => {
  let processor: AiTranslationParentProcessor;
  let mockPrisma: any;
  let mockJobProgress: any;
  let mockGeminiService: any;
  let mockExamCacheService: any;

  beforeEach(() => {
    mockPrisma = {
      aiTranslationJob: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      exam: {
        findUnique: jest.fn(),
      },
      examLanguage: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      preferredLanguage: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      examVersionQuestion: {
        findMany: jest.fn(),
      },
      examVersionTranslation: {
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
      questionTranslation: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      examVersionOptionTranslation: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      questionOptionTranslation: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((cb) => cb(mockPrisma)),
    };

    mockJobProgress = {
      publishStarted: jest.fn().mockResolvedValue(undefined),
      publishProgress: jest.fn().mockResolvedValue(undefined),
      publishCompleted: jest.fn().mockResolvedValue(undefined),
      publishFailed: jest.fn().mockResolvedValue(undefined),
    };

    mockGeminiService = {
      translateBatch: jest.fn(),
      translateRichBatch: jest.fn(),
    };

    mockExamCacheService = {
      invalidateExamCache: jest.fn().mockResolvedValue(undefined),
    };

    processor = new AiTranslationParentProcessor(
      mockPrisma as PrismaService,
      mockJobProgress as JobProgressService,
      mockGeminiService as GeminiTranslationService,
      mockExamCacheService as ExamCacheService,
    );
  });

  it('should NEVER mark language as COMPLETED if a batch fails', async () => {
    const jobId = 'job-failed-test';
    const examVersionId = 'ev-1';
    const languageId = 'lang-tamil';

    mockPrisma.aiTranslationJob.findUnique.mockResolvedValue({
      id: jobId,
      examId: 'exam-1',
      examVersionId,
      totalQuestions: 4,
      batchSize: 2,
      languageStatuses: [],
    });

    mockPrisma.examVersionQuestion.findMany.mockResolvedValue([
      { id: 'q1', sequenceNumber: 1, questionText: 'Q1', options: [], sourceQuestionId: 'sq1' },
      { id: 'q2', sequenceNumber: 2, questionText: 'Q2', options: [], sourceQuestionId: 'sq2' },
      { id: 'q3', sequenceNumber: 3, questionText: 'Q3', options: [], sourceQuestionId: 'sq3' },
      { id: 'q4', sequenceNumber: 4, questionText: 'Q4', options: [], sourceQuestionId: 'sq4' },
    ]);

    mockPrisma.examVersionTranslation.findMany.mockResolvedValue([]);

    // First batch succeeds, second batch fails with 429 rate limit
    mockGeminiService.translateRichBatch
      .mockResolvedValueOnce([
        { questionNumber: 1, questionSegments: { 'seg-1': 'Q1 Tamil' } },
        { questionNumber: 2, questionSegments: { 'seg-2': 'Q2 Tamil' } },
      ])
      .mockRejectedValueOnce(new Error('Translation temporarily rate limited'));

    await expect(
      (processor as any).processLanguageTranslation({
        jobId,
        examId: 'exam-1',
        examVersionId,
        languageId,
        languageName: 'Tamil',
        languageCode: 'ta',
        userId: 'user-1',
        totalQuestions: 4,
        batchSize: 2,
      }),
    ).rejects.toThrow();

    // Verify the status recorded in DB is FAILED and NOT COMPLETED
    const updateCalls = mockPrisma.aiTranslationJob.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    const finalLangStatus = finalUpdate.data.languageStatuses[0];

    expect(finalLangStatus.status).toBe('FAILED');
    expect(finalLangStatus.status).not.toBe('COMPLETED');
    expect(finalLangStatus.failedBatches).toBe(1);
    expect(finalLangStatus.completedQuestions).toBe(2);
  });

  it('should mark language COMPLETED when all questions and batches succeed', async () => {
    const jobId = 'job-success-test';
    const examVersionId = 'ev-2';
    const languageId = 'lang-hindi';

    mockPrisma.aiTranslationJob.findUnique.mockResolvedValue({
      id: jobId,
      examId: 'exam-1',
      examVersionId,
      totalQuestions: 2,
      batchSize: 2,
      languageStatuses: [],
    });

    mockPrisma.examVersionQuestion.findMany.mockResolvedValue([
      { id: 'q1', sequenceNumber: 1, questionText: 'Q1', options: [], sourceQuestionId: 'sq1' },
      { id: 'q2', sequenceNumber: 2, questionText: 'Q2', options: [], sourceQuestionId: 'sq2' },
    ]);

    mockPrisma.examVersionTranslation.findMany.mockResolvedValue([]);

    mockGeminiService.translateRichBatch.mockResolvedValueOnce([
      { questionNumber: 1, questionSegments: { 'seg-1': 'Q1 Hindi' } },
      { questionNumber: 2, questionSegments: { 'seg-2': 'Q2 Hindi' } },
    ]);

    await (processor as any).processLanguageTranslation({
      jobId,
      examId: 'exam-1',
      examVersionId,
      languageId,
      languageName: 'Hindi',
      languageCode: 'hi',
      userId: 'user-1',
      totalQuestions: 2,
      batchSize: 2,
    });

    const updateCalls = mockPrisma.aiTranslationJob.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    const finalLangStatus = finalUpdate.data.languageStatuses[0];

    expect(finalLangStatus.status).toBe('COMPLETED');
    expect(finalLangStatus.completedQuestions).toBe(2);
    expect(finalLangStatus.failedBatches).toBe(0);
  });

  it('should skip Gemini translation call if batch is already translated in DB (Idempotency)', async () => {
    const jobId = 'job-idempotent-test';
    const examVersionId = 'ev-3';
    const languageId = 'lang-gujarati';

    mockPrisma.aiTranslationJob.findUnique.mockResolvedValue({
      id: jobId,
      examId: 'exam-1',
      examVersionId,
      totalQuestions: 2,
      batchSize: 2,
      languageStatuses: [],
    });

    mockPrisma.examVersionQuestion.findMany.mockResolvedValue([
      { id: 'q1', sequenceNumber: 1, questionText: 'Q1', options: [], sourceQuestionId: 'sq1' },
      { id: 'q2', sequenceNumber: 2, questionText: 'Q2', options: [], sourceQuestionId: 'sq2' },
    ]);

    // Already translated in DB
    mockPrisma.examVersionTranslation.findMany.mockResolvedValue([
      { examVersionQuestionId: 'q1', languageId, questionText: 'Q1 Gujarati' },
      { examVersionQuestionId: 'q2', languageId, questionText: 'Q2 Gujarati' },
    ]);

    await (processor as any).processLanguageTranslation({
      jobId,
      examId: 'exam-1',
      examVersionId,
      languageId,
      languageName: 'Gujarati',
      languageCode: 'gu',
      userId: 'user-1',
      totalQuestions: 2,
      batchSize: 2,
    });

    // Gemini translateRichBatch should NEVER have been called
    expect(mockGeminiService.translateRichBatch).not.toHaveBeenCalled();

    const updateCalls = mockPrisma.aiTranslationJob.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    const finalLangStatus = finalUpdate.data.languageStatuses[0];

    expect(finalLangStatus.status).toBe('COMPLETED');
    expect(finalLangStatus.completedQuestions).toBe(2);
  });

  it('should invalidate Redis exam cache when evaluateJobCompletion finishes with COMPLETED or PARTIALLY_COMPLETED', async () => {
    const jobId = 'job-cache-invalidation-test';
    const examId = 'exam-cache-1';
    const examVersionId = 'ev-cache-1';
    const userId = 'user-1';

    // Mock completed job
    mockPrisma.aiTranslationJob.findUnique.mockResolvedValue({
      id: jobId,
      examId,
      examVersionId,
      languageStatuses: [
        { languageId: 'lang-1', languageName: 'Hindi', status: 'COMPLETED', completedQuestions: 10, totalQuestions: 10 },
        { languageId: 'lang-2', languageName: 'Tamil', status: 'COMPLETED', completedQuestions: 10, totalQuestions: 10 },
      ],
    });

    await (processor as any).evaluateJobCompletion(jobId, userId, examId);

    // Expect invalidateExamCache to be called with examId and examVersionId
    expect(mockExamCacheService.invalidateExamCache).toHaveBeenCalledTimes(1);
    expect(mockExamCacheService.invalidateExamCache).toHaveBeenCalledWith(examId, examVersionId);
  });
});
