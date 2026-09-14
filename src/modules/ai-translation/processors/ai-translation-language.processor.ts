import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import {
  GeminiTranslationService,
  QuestionBatchItem,
} from '../services/gemini-translation.service';
import {
  AI_TRANSLATION_DEFAULTS,
  AI_TRANSLATION_LANGUAGE_QUEUE,
  AI_TRANSLATION_QUEUE,
} from '../constants/ai-translation.constants';
import { LanguageTranslationProgress } from '../dto/ai-translation-upload.dto';

export interface AiTranslationLanguageJobData {
  jobId: string;
  examId: string;
  examVersionId: string;
  languageId: string;
  languageName: string;
  languageCode: string;
  userId: string;
}

@Processor(AI_TRANSLATION_LANGUAGE_QUEUE, {
  concurrency: 1,
})
export class AiTranslationLanguageProcessor extends WorkerHost {
  private readonly logger = new Logger(AiTranslationLanguageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geminiTranslationService: GeminiTranslationService,
    private readonly jobProgressService: JobProgressService,
  ) {
    super();
  }

  async process(job: Job<AiTranslationLanguageJobData>): Promise<void> {
    const {
      jobId,
      examId,
      examVersionId,
      languageId,
      languageName,
      languageCode,
      userId,
    } = job.data;

    this.logger.log(
      `Starting AI Translation for Job ${jobId} -> Language: ${languageName} (${languageCode})`,
    );

    // 1. Fetch Job Record & initialize language progress
    const translationJob = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });

    if (!translationJob) {
      this.logger.error(`AiTranslationJob ${jobId} not found`);
      return;
    }

    const batchSize = translationJob.batchSize || AI_TRANSLATION_DEFAULTS.BATCH_SIZE;

    // Update language status to PROCESSING in DB
    await this.updateLanguageStatus(jobId, languageId, {
      status: 'PROCESSING',
      completedQuestions: 0,
      failedBatches: 0,
    });

    // 2. Fetch Questions from DB (ExamVersionQuestion snapshot)
    const evQuestions = await this.prisma.examVersionQuestion.findMany({
      where: { examVersionId },
      include: {
        options: {
          orderBy: { displayOrder: 'asc' },
        },
      },
      orderBy: { sequenceNumber: 'asc' },
    });

    if (evQuestions.length === 0) {
      this.logger.warn(`No questions found for examVersionId: ${examVersionId}`);
      await this.updateLanguageStatus(jobId, languageId, {
        status: 'COMPLETED',
        completedQuestions: 0,
      });
      return;
    }

    const totalQuestions = evQuestions.length;
    let completedQuestions = 0;
    let failedBatches = 0;

    // 3. Process in batches
    for (let i = 0; i < evQuestions.length; i += batchSize) {
      const batchSlice = evQuestions.slice(i, i + batchSize);

      // ── IDEMPOTENCY CHECK: Check if this batch is already translated in DB ──
      const batchQIds = batchSlice.map((q) => q.id);
      const existingTranslations = await this.prisma.examVersionTranslation.findMany({
        where: {
          examVersionQuestionId: { in: batchQIds },
          languageId,
        },
      });

      const existingQIdSet = new Set(existingTranslations.map((t) => t.examVersionQuestionId));
      const untranslatedSlice = batchSlice.filter((evq) => !existingQIdSet.has(evq.id));

      if (untranslatedSlice.length === 0) {
        this.logger.log(
          `[Idempotency] Batch of ${batchSlice.length} questions for ${languageName} already translated in DB. Skipping AI call.`,
        );
        completedQuestions += batchSlice.length;
        await this.updateLanguageStatus(jobId, languageId, {
          status: 'PROCESSING',
          completedQuestions,
        });
        continue;
      }

      const batchItems: QuestionBatchItem[] = untranslatedSlice.map((evq) => {
        const optA = evq.options.find((o) => o.optionKey === 'A')?.optionText || '';
        const optB = evq.options.find((o) => o.optionKey === 'B')?.optionText || '';
        const optC = evq.options.find((o) => o.optionKey === 'C')?.optionText || '';
        const optD = evq.options.find((o) => o.optionKey === 'D')?.optionText || '';

        return {
          questionNumber: evq.sequenceNumber,
          question: evq.questionText,
          optionA: optA,
          optionB: optB,
          optionC: optC,
          optionD: optD,
        };
      });

      try {
        // Call Gemini for batch translation
        const translatedBatch = await this.geminiTranslationService.translateBatch(
          batchItems,
          languageName,
          languageCode,
        );

        // Map translated items by questionNumber
        const transMap = new Map(
          translatedBatch.map((item) => [item.questionNumber, item]),
        );

        // Upsert translations into DB transaction
        await this.prisma.$transaction(async (tx) => {
          for (const evq of untranslatedSlice) {
            const tr = transMap.get(evq.sequenceNumber);
            if (!tr) continue;

            // 1. QuestionTranslation
            if (evq.sourceQuestionId) {
              await tx.questionTranslation.upsert({
                where: {
                  questionId_languageId: {
                    questionId: evq.sourceQuestionId,
                    languageId,
                  },
                },
                create: {
                  questionId: evq.sourceQuestionId,
                  languageId,
                  questionText: tr.question,
                  explanation: evq.explanation,
                },
                update: {
                  questionText: tr.question,
                },
              });
            }

            // 2. ExamVersionTranslation
            await tx.examVersionTranslation.upsert({
              where: {
                examVersionQuestionId_languageId: {
                  examVersionQuestionId: evq.id,
                  languageId,
                },
              },
              create: {
                examVersionQuestionId: evq.id,
                languageId,
                languageCode,
                questionText: tr.question,
                explanation: evq.explanation,
              },
              update: {
                questionText: tr.question,
                languageCode,
              },
            });

            // 3. QuestionOptionTranslation & ExamVersionOptionTranslation
            const optMap: Record<string, string> = {
              A: tr.optionA,
              B: tr.optionB,
              C: tr.optionC,
              D: tr.optionD,
            };

            for (const evOpt of evq.options) {
              const optText = optMap[evOpt.optionKey] || evOpt.optionText;

              if (evOpt.sourceOptionId) {
                await tx.questionOptionTranslation.upsert({
                  where: {
                    optionId_languageId: {
                      optionId: evOpt.sourceOptionId,
                      languageId,
                    },
                  },
                  create: {
                    optionId: evOpt.sourceOptionId,
                    languageId,
                    optionText: optText,
                  },
                  update: {
                    optionText: optText,
                  },
                });
              }

              await tx.examVersionOptionTranslation.upsert({
                where: {
                  examVersionOptionId_languageId: {
                    examVersionOptionId: evOpt.id,
                    languageId,
                  },
                },
                create: {
                  examVersionOptionId: evOpt.id,
                  languageId,
                  languageCode,
                  optionText: optText,
                },
                update: {
                  optionText: optText,
                  languageCode,
                },
              });
            }
          }
        });

        completedQuestions += batchSlice.length;

        // Update DB progress & emit websocket event
        await this.updateLanguageStatus(jobId, languageId, {
          status: 'PROCESSING',
          completedQuestions,
        });

        await this.jobProgressService.publishProgress(
          AI_TRANSLATION_QUEUE,
          jobId,
          completedQuestions,
          totalQuestions,
          {
            stage: `Translating ${languageName}`,
            message: `Translated ${completedQuestions}/${totalQuestions} questions for ${languageName}`,
            userId,
            examId,
          },
        );
      } catch (batchErr: any) {
        failedBatches++;
        this.logger.error(
          `Error translating batch in ${languageName} for Job ${jobId}: ${batchErr.message}`,
        );
        break;
      }
    }

    // 4. Finalize Language Status - STRICT INTEGRITY
    const isFullyCompleted =
      completedQuestions === totalQuestions && failedBatches === 0;
    const finalStatus = isFullyCompleted ? 'COMPLETED' : 'FAILED';

    await this.updateLanguageStatus(jobId, languageId, {
      status: finalStatus,
      completedQuestions,
      failedBatches,
    });

    // 5. Evaluate Overall Job Completion
    await this.evaluateJobCompletion(jobId, userId, examId);

    if (!isFullyCompleted) {
      throw new Error(
        `Language translation incomplete for ${languageName}: ${completedQuestions}/${totalQuestions} completed, ${failedBatches} batches failed.`,
      );
    }
  }

  private async updateLanguageStatus(
    jobId: string,
    languageId: string,
    updates: Partial<LanguageTranslationProgress>,
  ) {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });
    if (!job) return;

    const list = (job.languageStatuses as any as LanguageTranslationProgress[]) || [];
    const idx = list.findIndex((l) => l.languageId === languageId);

    if (idx >= 0) {
      list[idx] = { ...list[idx], ...updates };
    } else {
      list.push({
        languageId,
        languageName: updates.languageName || 'Unknown',
        languageCode: updates.languageCode || 'en',
        status: updates.status || 'PROCESSING',
        completedQuestions: updates.completedQuestions || 0,
        totalQuestions: updates.totalQuestions || job.totalQuestions,
        failedBatches: updates.failedBatches || 0,
        errorMessage: updates.errorMessage,
      });
    }

    // Calculate overall progress across all languages
    const totalPossibleUnits = job.totalQuestions * (list.length || 1);
    const totalCompletedUnits = list.reduce(
      (acc, curr) => acc + (curr.completedQuestions || 0),
      0,
    );
    const overallProgress =
      totalPossibleUnits > 0
        ? Math.min(100, Math.round((totalCompletedUnits / totalPossibleUnits) * 100))
        : 0;

    await this.prisma.aiTranslationJob.update({
      where: { id: jobId },
      data: {
        languageStatuses: list as any,
        overallProgress,
      },
    });
  }

  private async evaluateJobCompletion(jobId: string, userId: string, examId: string) {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });
    if (!job) return;

    const list = (job.languageStatuses as any as LanguageTranslationProgress[]) || [];
    const isAnyProcessing = list.some(
      (l) => l.status === 'PROCESSING' || l.status === 'QUEUED',
    );

    if (isAnyProcessing) {
      // Still some languages in progress
      return;
    }

    const allCompleted = list.every((l) => l.status === 'COMPLETED');
    const allFailed = list.every((l) => l.status === 'FAILED');

    let finalJobStatus = 'COMPLETED';
    if (allFailed) {
      finalJobStatus = 'FAILED';
    } else if (!allCompleted) {
      finalJobStatus = 'PARTIALLY_COMPLETED';
    }

    await this.prisma.aiTranslationJob.update({
      where: { id: jobId },
      data: {
        status: finalJobStatus as any,
        completedAt: finalJobStatus !== 'FAILED' ? new Date() : null,
        failedAt: finalJobStatus === 'FAILED' ? new Date() : null,
      },
    });

    if (finalJobStatus === 'COMPLETED' || finalJobStatus === 'PARTIALLY_COMPLETED') {
      await this.jobProgressService.publishCompleted(
        AI_TRANSLATION_QUEUE,
        jobId,
        {
          message: `AI translation completed with status: ${finalJobStatus}`,
          userId,
          examId,
          resultSummary: {
            status: finalJobStatus,
            totalLanguages: list.length,
            completedLanguages: list.filter((l) => l.status === 'COMPLETED').length,
          },
        },
      );
    } else {
      await this.jobProgressService.publishFailed(
        AI_TRANSLATION_QUEUE,
        jobId,
        'AI Translation failed across all target languages.',
        'TRANSLATION_FAILED',
      );
    }
  }
}
