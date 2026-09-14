import { AiTranslationParentProcessor } from '../processors/ai-translation-parent.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { GeminiTranslationService } from '../services/gemini-translation.service';

describe('AiTranslation State Integrity & Idempotency', () => {
  let processor: AiTranslationParentProcessor;
  let mockPrisma: any;
  let mockJobProgress: any;
  let mockGeminiService: any;

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
    };

    processor = new AiTranslationParentProcessor(
      mockPrisma as PrismaService,
      mockJobProgress as JobProgressService,
      mockGeminiService as GeminiTranslationService,
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
    mockGeminiService.translateBatch
      .mockResolvedValueOnce([
        { questionNumber: 1, question: 'Q1 Tamil', optionA: '', optionB: '', optionC: '', optionD: '' },
        { questionNumber: 2, question: 'Q2 Tamil', optionA: '', optionB: '', optionC: '', optionD: '' },
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

    mockGeminiService.translateBatch.mockResolvedValueOnce([
      { questionNumber: 1, question: 'Q1 Hindi', optionA: '', optionB: '', optionC: '', optionD: '' },
      { questionNumber: 2, question: 'Q2 Hindi', optionA: '', optionB: '', optionC: '', optionD: '' },
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

    // Gemini translateBatch should NEVER have been called
    expect(mockGeminiService.translateBatch).not.toHaveBeenCalled();

    const updateCalls = mockPrisma.aiTranslationJob.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    const finalLangStatus = finalUpdate.data.languageStatuses[0];

    expect(finalLangStatus.status).toBe('COMPLETED');
    expect(finalLangStatus.completedQuestions).toBe(2);
  });
});
