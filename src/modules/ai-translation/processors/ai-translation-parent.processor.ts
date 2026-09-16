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
  AI_TRANSLATION_QUEUE,
} from '../constants/ai-translation.constants';
import { LanguageTranslationProgress } from '../dto/ai-translation-upload.dto';

export interface ManualQuestionItem {
  questionText: string;
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'VERY_HARD';
  type?:
    | 'SINGLE_CORRECT'
    | 'MULTIPLE_CORRECT'
    | 'NUMERICAL'
    | 'ASSERTION_REASON'
    | 'MATCH_FOLLOWING';
  optionA?: string;
  optionB?: string;
  optionC?: string;
  optionD?: string;
  correctAnswer?: string;
  correctAnswers?: string[];
  numericalAnswer?: number | string;
  assertion?: string;
  reason?: string;
  columnA?: Array<{ key: string; text: string }>;
  columnB?: Array<{ key: string; text: string }>;
  matchPairs?: Array<{ left: string; right: string }>;
  explanation?: string;
  subjectId?: string;
  chapterId?: string;
  marks?: number;
  negativeMarks?: number;
}

export interface AiTranslationParentJobData {
  jobId: string;
  examId: string;
  examVersionId?: string;
  userId: string;
  manualQuestionsPayload?: { questions: ManualQuestionItem[] };
  retryLanguageId?: string;
}

@Processor(AI_TRANSLATION_QUEUE, {
  concurrency: 1,
})
export class AiTranslationParentProcessor extends WorkerHost {
  private readonly logger = new Logger(AiTranslationParentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobProgressService: JobProgressService,
    private readonly geminiTranslationService: GeminiTranslationService,
  ) {
    super();
  }

  async process(job: Job<AiTranslationParentJobData>): Promise<void> {
    const { jobId, examId, userId } = job.data;
    this.logger.log(`Starting Parent AI Translation Job ${jobId} for exam ${examId}`);

    // ── Handle single-language retry ──
    if (job.data.retryLanguageId) {
      await this.handleSingleLanguageRetry(job.data);
      return;
    }

    try {
      // 1. Fetch the existing AiTranslationJob record
      const translationJob = await this.prisma.aiTranslationJob.findUnique({
        where: { id: jobId },
      });

      if (!translationJob) {
        this.logger.error(`AiTranslationJob ${jobId} not found.`);
        return;
      }

      // 2. Mark as PROCESSING
      await this.prisma.aiTranslationJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          dbSaveProgress: 0,
        } as any,
      });

      await this.jobProgressService.publishStarted(
        AI_TRANSLATION_QUEUE,
        jobId,
        'AI Translation',
        'Starting question paper processing...',
        { userId, examId, totalRecords: translationJob.totalQuestions },
      );

      // 3. CRITICAL: Save manual questions to DB if this is a manual submission
      let resolvedVersionId = job.data.examVersionId || translationJob.examVersionId || '';

      const mqPayload = job.data.manualQuestionsPayload;
      if (mqPayload && mqPayload.questions && mqPayload.questions.length > 0) {
        this.logger.log(
          `Manual questions payload detected (${mqPayload.questions.length} questions). Saving to DB...`,
        );
        resolvedVersionId = await this.saveManualQuestionsToDB(
          jobId,
          examId,
          userId,
          mqPayload.questions,
        );
        this.logger.log(`Manual questions DB save complete. ExamVersion: ${resolvedVersionId}`);
      } else {
        // CSV/upload path: DB save already done. Mark as 100%.
        await this.prisma.aiTranslationJob.update({
          where: { id: jobId },
          data: { dbSaveProgress: 100 } as any,
        });
        await this.jobProgressService.publishProgress(
          AI_TRANSLATION_QUEUE,
          jobId,
          translationJob.totalQuestions,
          translationJob.totalQuestions,
          {
            stage: 'DB_SAVE_COMPLETE',
            message: 'English question paper already saved. Starting AI translation...',
            dbSaveProgress: 100,
          },
        );
      }

      // 4. Find configured exam languages (excluding English)
      const examLanguages = await this.prisma.examLanguage.findMany({
        where: { examId },
        include: { language: true },
      });

      let targetLanguages = examLanguages
        .filter((el) => el.language && (el.language.code || '').toLowerCase() !== 'en' && el.language.isActive)
        .map((el) => ({
          id: el.language!.id,
          name: el.language!.name,
          code: el.language!.code || 'en',
        }));

      if (targetLanguages.length === 0) {
        const masterLanguages = await this.prisma.preferredLanguage.findMany({
          where: { isActive: true, code: { notIn: ['en', 'EN'] } },
          orderBy: { displayOrder: 'asc' },
        });
        targetLanguages = masterLanguages.map((ml) => ({
          id: ml.id,
          name: ml.name,
          code: ml.code || 'en',
        }));

        for (let i = 0; i < targetLanguages.length; i++) {
          const tl = targetLanguages[i];
          await this.prisma.examLanguage.upsert({
            where: { examId_languageId: { examId, languageId: tl.id } },
            create: { examId, languageId: tl.id, isDefault: false, displayOrder: i + 2 },
            update: {},
          });
        }
      }

      if (targetLanguages.length === 0) {
        this.logger.log(`No regional target languages found. Marking job complete.`);
        await this.prisma.aiTranslationJob.update({
          where: { id: jobId },
          data: { status: 'COMPLETED', overallProgress: 100, completedAt: new Date() },
        });
        await this.jobProgressService.publishCompleted(AI_TRANSLATION_QUEUE, jobId, {
          message: 'No regional languages configured. English paper saved successfully.',
          userId,
          examId,
        });
        return;
      }

      // 5. Initialize all language statuses as WAITING
      const initialLanguageStatuses: LanguageTranslationProgress[] = targetLanguages.map(
        (lang) => ({
          languageId: lang.id,
          languageName: lang.name,
          languageCode: lang.code,
          status: 'WAITING',
          completedQuestions: 0,
          totalQuestions: translationJob.totalQuestions,
          failedBatches: 0,
        }),
      );

      await this.prisma.aiTranslationJob.update({
        where: { id: jobId },
        data: {
          totalLanguages: targetLanguages.length,
          languageStatuses: initialLanguageStatuses as any,
          examVersionId: resolvedVersionId,
        },
      });

      // ═══════════════════════════════════════════════════════════════════
      // 6. SEQUENTIAL PROCESSING: Process each language ONE BY ONE
      //    This is the ONLY way to guarantee strict serial execution.
      //    We do NOT dispatch to a BullMQ queue — we process directly here.
      // ═══════════════════════════════════════════════════════════════════
      this.logger.log(
        `Starting SEQUENTIAL translation of ${targetLanguages.length} languages for job ${jobId}`,
      );

      for (let langIdx = 0; langIdx < targetLanguages.length; langIdx++) {
        const lang = targetLanguages[langIdx];
        this.logger.log(
          `[${langIdx + 1}/${targetLanguages.length}] Processing language: ${lang.name} (${lang.code}) for job ${jobId}`,
        );

        try {
          await this.processLanguageTranslation({
            jobId,
            examId,
            examVersionId: resolvedVersionId,
            languageId: lang.id,
            languageName: lang.name,
            languageCode: lang.code,
            userId,
            totalQuestions: translationJob.totalQuestions,
            batchSize: translationJob.batchSize || AI_TRANSLATION_DEFAULTS.BATCH_SIZE,
          });

          this.logger.log(
            `[${langIdx + 1}/${targetLanguages.length}] COMPLETED: ${lang.name} for job ${jobId}`,
          );
        } catch (langErr: any) {
          this.logger.error(
            `[${langIdx + 1}/${targetLanguages.length}] FAILED: ${lang.name} for job ${jobId}: ${langErr.message}`,
          );
          // Mark this language as failed, but continue with the next one
          await this.updateLanguageStatus(jobId, lang.id, {
            status: 'FAILED',
            errorMessage: langErr.message,
          });
        }

        // Brief cooldown between languages (2s) to prevent API rate issues
        if (langIdx < targetLanguages.length - 1) {
          this.logger.log(`Cooldown 2s before next language...`);
          await new Promise((res) => setTimeout(res, 2000));
        }
      }

      // 7. Evaluate overall job completion
      await this.evaluateJobCompletion(jobId, userId, examId);

      this.logger.log(`All languages processed sequentially for job ${jobId}.`);
    } catch (err: any) {
      this.logger.error(
        `Failed in Parent AI Translation processor for Job ${jobId}: ${err.message}`,
        err.stack,
      );
      await this.prisma.aiTranslationJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: err.message, failedAt: new Date() },
      });
      await this.jobProgressService.publishFailed(
        AI_TRANSLATION_QUEUE,
        jobId,
        `AI Translation orchestration failed: ${err.message}`,
        'PARENT_ORCHESTRATION_FAILED',
      );
    }
  }

  /**
   * Handles retrying a single failed language — runs inline to maintain sequential guarantee.
   */
  private async handleSingleLanguageRetry(data: AiTranslationParentJobData): Promise<void> {
    const { jobId, examId, userId, retryLanguageId } = data;
    this.logger.log(`Single-language retry for job ${jobId}, language ${retryLanguageId}`);

    const translationJob = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });
    if (!translationJob) {
      this.logger.error(`AiTranslationJob ${jobId} not found for retry.`);
      return;
    }

    const language = await this.prisma.preferredLanguage.findUnique({
      where: { id: retryLanguageId },
    });
    if (!language) {
      this.logger.error(`Language ${retryLanguageId} not found for retry.`);
      return;
    }

    const examVersionId = data.examVersionId || translationJob.examVersionId || '';
    const batchSize = translationJob.batchSize || AI_TRANSLATION_DEFAULTS.BATCH_SIZE;

    try {
      await this.processLanguageTranslation({
        jobId,
        examId,
        examVersionId,
        languageId: language.id,
        languageName: language.name,
        languageCode: language.code || 'en',
        userId,
        totalQuestions: translationJob.totalQuestions,
        batchSize,
      });
      this.logger.log(`Single-language retry COMPLETED: ${language.name} for job ${jobId}`);
    } catch (langErr: any) {
      this.logger.error(`Single-language retry FAILED: ${language.name} for job ${jobId}: ${langErr.message}`);
      await this.updateLanguageStatus(jobId, language.id, {
        status: 'FAILED',
        errorMessage: langErr.message,
      });
    }

    // Re-evaluate overall job status after retry
    await this.evaluateJobCompletion(jobId, userId, examId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INLINE LANGUAGE TRANSLATION — runs DIRECTLY inside the parent processor
  // so there is zero possibility of parallel execution.
  // ═══════════════════════════════════════════════════════════════════════════

  private async processLanguageTranslation(params: {
    jobId: string;
    examId: string;
    examVersionId: string;
    languageId: string;
    languageName: string;
    languageCode: string;
    userId: string;
    totalQuestions: number;
    batchSize: number;
  }): Promise<void> {
    const {
      jobId,
      examId,
      examVersionId,
      languageId,
      languageName,
      languageCode,
      userId,
      totalQuestions,
      batchSize,
    } = params;

    // Update language status to PROCESSING
    await this.updateLanguageStatus(jobId, languageId, {
      status: 'PROCESSING',
      completedQuestions: 0,
      failedBatches: 0,
      errorMessage: undefined,
    });

    // Fetch questions from DB
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

    let completedQuestions = 0;
    let failedBatches = 0;
    let lastErrorMessage: string | null = null;

    // Process in batches
    for (let i = 0; i < evQuestions.length; i += batchSize) {
      const batchSlice = evQuestions.slice(i, i + batchSize);
      const batchQIds = batchSlice.map((q) => q.id);

      // ── IDEMPOTENCY CHECK: Check if this batch is already translated in DB ──
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
        // Call Gemini through the Global Distributed Rate Limiter
        const translatedBatch = await this.geminiTranslationService.translateBatch(
          batchItems,
          languageName,
          languageCode,
        );

        const transMap = new Map(
          translatedBatch.map((item) => [item.questionNumber, item]),
        );

        // Upsert translations into DB atomically
        await this.prisma.$transaction(
          async (tx) => {
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
          },
          { maxWait: 15000, timeout: 60000 },
        );

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
        lastErrorMessage = batchErr?.message || 'Batch translation failed';
        this.logger.error(
          `Error translating batch in ${languageName} for Job ${jobId}: ${lastErrorMessage}`,
        );
        // Do not continue to remaining batches if rate limit/quota failure occurred
        break;
      }
    }

    // ── STRICT STATE FINALIZATION ──
    // A language is COMPLETED ONLY when all questions are successfully translated without failed batches.
    const isFullyCompleted =
      completedQuestions === totalQuestions && failedBatches === 0;
    const finalStatus = isFullyCompleted ? 'COMPLETED' : 'FAILED';

    await this.updateLanguageStatus(jobId, languageId, {
      status: finalStatus,
      completedQuestions,
      failedBatches,
      errorMessage: isFullyCompleted ? undefined : (lastErrorMessage || undefined),
    });

    if (!isFullyCompleted) {
      throw new Error(
        lastErrorMessage ||
        `Translation incomplete for ${languageName} (${completedQuestions}/${totalQuestions} questions)`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════

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
        errorMessage: updates.errorMessage || undefined,
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
    const completedCount = list.filter((l) => l.status === 'COMPLETED').length;
    const allCompleted = list.length > 0 && completedCount === list.length;
    const allFailed = list.length > 0 && list.every((l) => l.status === 'FAILED');

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
        overallProgress: allCompleted ? 100 : undefined,
        completedAt: finalJobStatus !== 'FAILED' ? new Date() : null,
        failedAt: finalJobStatus === 'FAILED' ? new Date() : null,
      },
    });

    if (finalJobStatus === 'COMPLETED' || finalJobStatus === 'PARTIALLY_COMPLETED') {
      await this.jobProgressService.publishCompleted(
        AI_TRANSLATION_QUEUE,
        jobId,
        {
          message: `AI translation finished: ${completedCount}/${list.length} languages completed.`,
          userId,
          examId,
          resultSummary: {
            status: finalJobStatus,
            totalLanguages: list.length,
            completedLanguages: completedCount,
          },
        },
      );
    } else {
      await this.jobProgressService.publishFailed(
        AI_TRANSLATION_QUEUE,
        jobId,
        'AI Translation failed across target languages.',
        'TRANSLATION_FAILED',
      );
    }
  }

  /**
   * Saves manually entered questions to the PostgreSQL database.
   * Creates: ExamVersion, Question, QuestionOption (with correct isCorrect=true),
   * ExamQuestion, ExamVersionQuestion, ExamVersionOption, ExamVersionTranslation.
   * Tracks and publishes dbSaveProgress incrementally via WebSocket.
   * Returns the created ExamVersion ID.
   */
  private async saveManualQuestionsToDB(
    jobId: string,
    examId: string,
    userId: string,
    questions: ManualQuestionItem[],
  ): Promise<string> {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        sections: { include: { subject: true }, orderBy: { displayOrder: 'asc' } },
      },
    });
    if (!exam) throw new Error(`Exam ${examId} not found during manual question DB save.`);

    // Resolve default subject for the exam's target
    let defaultSubject = await this.prisma.subject.findFirst({
      where: exam.examTargetId
        ? { examTargetSubjects: { some: { examTargetId: exam.examTargetId } } }
        : undefined,
    });
    if (!defaultSubject) defaultSubject = await this.prisma.subject.findFirst();
    if (!defaultSubject) {
      defaultSubject = await this.prisma.subject.create({
        data: { name: 'Physics', code: 'PHY' },
      });
    }

    let defaultChapter = await this.prisma.chapter.findFirst({
      where: { subjectId: defaultSubject.id },
    });
    if (!defaultChapter) {
      defaultChapter = await this.prisma.chapter.create({
        data: { subjectId: defaultSubject.id, name: 'General Chapter', code: 'GEN-01' },
      });
    }

    const defaultLanguage =
      (await this.prisma.preferredLanguage.findFirst({ where: { code: 'en' } })) ||
      (await this.prisma.preferredLanguage.findFirst());
    const defaultLangId = defaultLanguage?.id || null;

    const marksPerQ = (exam as any).defaultMarksPerQuestion || 4;
    const negMarks = (exam as any).defaultNegativeMarks || 1;

    // ── Clean up existing version questions & reuse ExamVersion safely ──
    const existingVersions = await this.prisma.examVersion.findMany({
      where: { examId: exam.id },
      orderBy: { versionNumber: 'asc' },
    });
    const versionIds = existingVersions.map((v) => v.id);

    if (versionIds.length > 0) {
      const evQIds = (
        await this.prisma.examVersionQuestion.findMany({
          where: { examVersionId: { in: versionIds } },
          select: { id: true },
        })
      ).map((q) => q.id);

      if (evQIds.length > 0) {
        await this.prisma.examVersionOptionTranslation.deleteMany({
          where: { option: { examVersionQuestionId: { in: evQIds } } },
        });
        await this.prisma.examVersionTranslation.deleteMany({
          where: { examVersionQuestionId: { in: evQIds } },
        });
        await this.prisma.examVersionOption.deleteMany({
          where: { examVersionQuestionId: { in: evQIds } },
        });
        await this.prisma.examVersionQuestion.deleteMany({
          where: { examVersionId: { in: versionIds } },
        });
      }
    }

    let examVersion: any;
    if (existingVersions.length > 0) {
      examVersion = await this.prisma.examVersion.update({
        where: { id: existingVersions[0].id },
        data: {
          status: 'GENERATED',
          totalQuestions: questions.length,
          durationMinutes: exam.durationMinutes || 60,
          totalMarks: questions.length * marksPerQ,
        },
      });

      if (existingVersions.length > 1) {
        const extraVersionIds = existingVersions.slice(1).map((v) => v.id);
        await this.prisma.examSchedule.updateMany({
          where: { examVersionId: { in: extraVersionIds } },
          data: { examVersionId: examVersion.id },
        });
        await this.prisma.examVersion.deleteMany({
          where: { id: { in: extraVersionIds } },
        });
      }
    } else {
      examVersion = await this.prisma.examVersion.create({
        data: {
          examId: exam.id,
          versionNumber: 1,
          status: 'GENERATED',
          totalQuestions: questions.length,
          durationMinutes: exam.durationMinutes || 60,
          totalMarks: questions.length * marksPerQ,
          generatedById: userId,
        },
      });
    }

    // Clean up previous master question links
    const prevExamQs = await this.prisma.examQuestion.findMany({
      where: { examId: exam.id },
      select: { questionId: true },
    });
    const prevQIds = prevExamQs.map((eq) => eq.questionId);
    if (prevQIds.length > 0) {
      await this.prisma.examQuestion.deleteMany({ where: { examId: exam.id } });
      const stillLinked = await this.prisma.examQuestion.findMany({
        where: { questionId: { in: prevQIds } },
        select: { questionId: true },
      });
      const stillLinkedSet = new Set(stillLinked.map((e) => e.questionId));
      const deletable = prevQIds.filter((id) => !stillLinkedSet.has(id));
      if (deletable.length > 0) {
        await this.prisma.questionOptionTranslation.deleteMany({
          where: { option: { questionId: { in: deletable } } },
        });
        await this.prisma.questionTranslation.deleteMany({ where: { questionId: { in: deletable } } });
        await this.prisma.questionOption.deleteMany({ where: { questionId: { in: deletable } } });
        await this.prisma.question.deleteMany({ where: { id: { in: deletable } } });
      }
    }

    // Ensure ExamSection exists
    let examSection = exam.sections[0] as any;
    if (!examSection) {
      examSection = await this.prisma.examSection.create({
        data: {
          examId: exam.id,
          subjectId: defaultSubject.id,
          name: 'Section A',
          totalQuestions: questions.length,
          displayOrder: 1,
        } as any,
      });
    }

    const totalQ = questions.length;
    const REPORT_INTERVAL = Math.max(1, Math.ceil(totalQ / 10));

    for (let idx = 0; idx < questions.length; idx++) {
      const qData = questions[idx];
      const seqNum = idx + 1;

      const qType = qData.type || 'SINGLE_CORRECT';
      const qDifficulty = qData.difficulty || 'MEDIUM';

      // Create master Question
      const masterQ = await this.prisma.question.create({
        data: {
          subjectId: defaultSubject.id,
          chapterId: defaultChapter.id,
          ...(defaultLangId ? { defaultLanguageId: defaultLangId } : {}),
          type: qType as any,
          difficultyLevel: qDifficulty as any,
          marks: marksPerQ,
          negativeMarks: negMarks,
          assertion: qType === 'ASSERTION_REASON' ? qData.assertion || null : null,
          reason: qType === 'ASSERTION_REASON' ? qData.reason || null : null,
          createdById: userId,
          isActive: true,
        } as any,
      });

      // English translation for the question text
      if (defaultLangId) {
        await this.prisma.questionTranslation.create({
          data: {
            questionId: masterQ.id,
            languageId: defaultLangId,
            questionText: qData.questionText,
            assertionText: qType === 'ASSERTION_REASON' ? qData.assertion || null : null,
            reasonText: qType === 'ASSERTION_REASON' ? qData.reason || null : null,
            explanation: qData.explanation || null,
          },
        });
      }

      // Create options if applicable (non-numerical)
      const createdOpts: any[] = [];
      if (qType !== 'NUMERICAL') {
        const optDefs = [
          { key: 'A', text: qData.optionA || '' },
          { key: 'B', text: qData.optionB || '' },
          { key: 'C', text: qData.optionC || '' },
          { key: 'D', text: qData.optionD || '' },
        ];

        const multiCorrect = Array.isArray(qData.correctAnswers)
          ? qData.correctAnswers
          : typeof qData.correctAnswer === 'string'
          ? qData.correctAnswer.split(/[\s,]+/).filter(Boolean)
          : [];

        for (let oIdx = 0; oIdx < optDefs.length; oIdx++) {
          const optDef = optDefs[oIdx];
          const isCorrect =
            qType === 'MULTIPLE_CORRECT'
              ? multiCorrect.includes(optDef.key)
              : optDef.key === qData.correctAnswer;

          const opt = await this.prisma.questionOption.create({
            data: {
              questionId: masterQ.id,
              optionKey: optDef.key,
              optionLabel: optDef.key,
              optionText: optDef.text,
              isCorrect,
              displayOrder: oIdx + 1,
            },
          });
          createdOpts.push(opt);
        }
      }

      // Create QuestionAnswer record
      const correctOptionIds = createdOpts.filter((o) => o.isCorrect).map((o) => o.id);
      await this.prisma.questionAnswer.create({
        data: {
          questionId: masterQ.id,
          answerType: qType as any,
          correctOptionIds: correctOptionIds.length > 0 ? correctOptionIds : undefined,
          numericalAnswer:
            qType === 'NUMERICAL' && qData.numericalAnswer !== undefined && qData.numericalAnswer !== null
              ? parseFloat(String(qData.numericalAnswer))
              : null,
        } as any,
      });

      // Link to exam
      await this.prisma.examQuestion.create({
        data: {
          examId: exam.id,
          sectionId: examSection.id,
          questionId: masterQ.id,
          displayOrder: seqNum,
          marks: marksPerQ,
          negativeMarks: negMarks,
        } as any,
      });

      // Prepare snapshot correctAnswer object
      let snapshotCorrectAnswer: any = null;
      if (qType === 'NUMERICAL') {
        snapshotCorrectAnswer = {
          numericalAnswer:
            qData.numericalAnswer !== undefined && qData.numericalAnswer !== null
              ? parseFloat(String(qData.numericalAnswer))
              : null,
        };
      } else if (qType === 'MULTIPLE_CORRECT') {
        const multiCorrect = Array.isArray(qData.correctAnswers)
          ? qData.correctAnswers
          : typeof qData.correctAnswer === 'string'
          ? qData.correctAnswer.split(/[\s,]+/).filter(Boolean)
          : [];
        snapshotCorrectAnswer = { keys: multiCorrect };
      } else {
        snapshotCorrectAnswer = { key: qData.correctAnswer };
      }

      // ExamVersionQuestion snapshot
      const evq = await this.prisma.examVersionQuestion.create({
        data: {
          examVersionId: examVersion.id,
          sourceQuestionId: masterQ.id,
          sequenceNumber: seqNum,
          sectionName: (examSection as any).name || 'Section A',
          subjectName: defaultSubject.name,
          type: qType as any,
          difficultyLevel: qDifficulty as any,
          marks: marksPerQ,
          negativeMarks: negMarks,
          assertion: qType === 'ASSERTION_REASON' ? qData.assertion || null : null,
          reason: qType === 'ASSERTION_REASON' ? qData.reason || null : null,
          questionText: qData.questionText,
          explanation: qData.explanation || null,
          correctAnswer: snapshotCorrectAnswer,
        } as any,
      });

      // English translation snapshot
      if (defaultLangId) {
        await this.prisma.examVersionTranslation.create({
          data: {
            examVersionQuestionId: evq.id,
            languageId: defaultLangId,
            languageCode: 'en',
            questionText: qData.questionText,
            explanation: qData.explanation || null,
          },
        });
      }

      // ExamVersionOption snapshots (isCorrect propagated)
      for (let oIdx = 0; oIdx < createdOpts.length; oIdx++) {
        const opt = createdOpts[oIdx];
        await this.prisma.examVersionOption.create({
          data: {
            examVersionQuestionId: evq.id,
            sourceOptionId: opt.id,
            displayOrder: oIdx + 1,
            optionKey: opt.optionKey,
            optionLabel: opt.optionLabel,
            optionText: opt.optionText || '',
            isCorrect: opt.isCorrect,
          },
        });
      }

      // Report dbSaveProgress every REPORT_INTERVAL or on the last question
      if ((idx + 1) % REPORT_INTERVAL === 0 || idx === totalQ - 1) {
        const dbPct = Math.round(((idx + 1) / totalQ) * 100);
        await this.prisma.aiTranslationJob.update({
          where: { id: jobId },
          data: { dbSaveProgress: dbPct } as any,
        });
        await this.jobProgressService.publishProgress(
          AI_TRANSLATION_QUEUE,
          jobId,
          idx + 1,
          totalQ,
          {
            stage: 'DB_SAVE',
            message: `Saving English questions: ${idx + 1} of ${totalQ}...`,
            dbSaveProgress: dbPct,
            phase: 'DB_SAVE',
          },
        );
      }
    }

    // Update exam totals
    await this.prisma.exam.update({
      where: { id: exam.id },
      data: { totalQuestions: questions.length, totalMarks: questions.length * marksPerQ },
    });

    // Link schedule to new version and mark answer key ready
    await this.prisma.examSchedule.updateMany({
      where: { examId: exam.id },
      data: {
        examVersionId: examVersion.id,
        hasAnswerKey: true,
        answerKeyUploadedAt: new Date(),
        answerKeyUploadedById: userId,
      } as any,
    });

    // Ensure English default language link
    if (defaultLangId) {
      await this.prisma.examLanguage.upsert({
        where: { examId_languageId: { examId: exam.id, languageId: defaultLangId } },
        create: { examId: exam.id, languageId: defaultLangId, isDefault: true, displayOrder: 1 },
        update: { isDefault: true },
      });
    }

    // Final: mark DB save as 100% complete
    await this.prisma.aiTranslationJob.update({
      where: { id: jobId },
      data: { dbSaveProgress: 100 } as any,
    });
    await this.jobProgressService.publishProgress(
      AI_TRANSLATION_QUEUE,
      jobId,
      totalQ,
      totalQ,
      {
        stage: 'DB_SAVE_COMPLETE',
        message: `All ${totalQ} questions saved to database! AI translation starting...`,
        dbSaveProgress: 100,
        examVersionId: examVersion.id,
      },
    );

    this.logger.log(
      `DB save complete: ExamVersion ${examVersion.id} created with ${totalQ} questions (correct answers preserved).`,
    );
    return examVersion.id;
  }
}
