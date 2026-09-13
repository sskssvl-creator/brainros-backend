import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import {
  AI_TRANSLATION_QUEUE,
  AI_TRANSLATION_LANGUAGE_QUEUE,
} from '../constants/ai-translation.constants';
import { AiTranslationLanguageJobData } from './ai-translation-language.processor';
import { LanguageTranslationProgress } from '../dto/ai-translation-upload.dto';

export interface AiTranslationParentJobData {
  jobId: string;
  examId: string;
  examVersionId?: string;
  userId: string;
  manualQuestionsPayload?: any;
}

@Processor(AI_TRANSLATION_QUEUE, {
  concurrency: 2,
})
export class AiTranslationParentProcessor extends WorkerHost {
  private readonly logger = new Logger(AiTranslationParentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobProgressService: JobProgressService,
    @InjectQueue(AI_TRANSLATION_LANGUAGE_QUEUE)
    private readonly languageQueue: Queue<AiTranslationLanguageJobData>,
  ) {
    super();
  }

  async process(job: Job<AiTranslationParentJobData>): Promise<void> {
    const { jobId, examId, examVersionId, userId } = job.data;
    this.logger.log(`Starting Parent AI Translation Job ${jobId} for exam ${examId}`);

    try {
      // 1. Fetch Job and Exam Languages
      const translationJob = await this.prisma.aiTranslationJob.findUnique({
        where: { id: jobId },
      });

      if (!translationJob) {
        this.logger.error(`AiTranslationJob ${jobId} not found.`);
        return;
      }

      // 2. Update Status to PROCESSING
      await this.prisma.aiTranslationJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
        },
      });

      await this.jobProgressService.publishStarted(
        AI_TRANSLATION_QUEUE,
        jobId,
        'AI Translation',
        'Dispatching per-language translation jobs...',
        { userId, examId, totalRecords: translationJob.totalQuestions },
      );

      // 3. Find configured exam languages (excluding English / default if source is en)
      const examLanguages = await this.prisma.examLanguage.findMany({
        where: { examId },
        include: { language: true },
      });

      // Target languages: filter out default or 'en'
      let targetLanguages = examLanguages
        .filter((el) => el.language && (el.language.code || '').toLowerCase() !== 'en' && el.language.isActive)
        .map((el) => ({
          id: el.language!.id,
          name: el.language!.name,
          code: el.language!.code || 'en',
        }));

      // If no regional languages configured, default to ALL active regional languages from Language Master
      if (targetLanguages.length === 0) {
        const masterLanguages = await this.prisma.preferredLanguage.findMany({
          where: {
            isActive: true,
            code: { notIn: ['en', 'EN'] },
          },
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
            where: {
              examId_languageId: {
                examId,
                languageId: tl.id,
              },
            },
            create: {
              examId,
              languageId: tl.id,
              isDefault: false,
              displayOrder: i + 2,
            },
            update: {},
          });
        }
      }

      if (targetLanguages.length === 0) {
        this.logger.log(`No regional target languages found in Language Master. Marking complete.`);
        await this.prisma.aiTranslationJob.update({
          where: { id: jobId },
          data: {
            status: 'COMPLETED',
            overallProgress: 100,
            completedAt: new Date(),
          },
        });
        await this.jobProgressService.publishCompleted(
          AI_TRANSLATION_QUEUE,
          jobId,
          {
            message: 'No regional languages available in Language Master.',
            userId,
            examId,
          },
        );
        return;
      }

      // Initialize language statuses in DB
      const initialLanguageStatuses: LanguageTranslationProgress[] = targetLanguages.map(
        (lang) => ({
          languageId: lang.id,
          languageName: lang.name,
          languageCode: lang.code,
          status: 'QUEUED',
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
        },
      });

      const resolvedVersionId = job.data.examVersionId || translationJob.examVersionId || '';

      // 4. Dispatch BullMQ job for each language
      for (const lang of targetLanguages) {
        await this.languageQueue.add(
          `translate-${lang.code}-${jobId}`,
          {
            jobId,
            examId,
            examVersionId: resolvedVersionId,
            languageId: lang.id,
            languageName: lang.name,
            languageCode: lang.code,
            userId,
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        );
      }

      this.logger.log(
        `Dispatched ${targetLanguages.length} language jobs for AI translation job ${jobId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed in Parent AI Translation processor for Job ${jobId}: ${err.message}`,
        err.stack,
      );

      await this.prisma.aiTranslationJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
          failedAt: new Date(),
        },
      });

      await this.jobProgressService.publishFailed(
        AI_TRANSLATION_QUEUE,
        jobId,
        `AI Translation orchestration failed: ${err.message}`,
        'PARENT_ORCHESTRATION_FAILED',
      );
    }
  }
}
