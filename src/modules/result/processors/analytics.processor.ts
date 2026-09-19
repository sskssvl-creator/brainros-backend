import { Processor, WorkerHost, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import {
  ANALYTICS_QUEUE_NAME,
  RANKING_QUEUE_NAME,
  AnalyticsJobPayload,
  ResultStatusEnum,
} from '../interfaces/result-lifecycle.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { ResultService } from '../result.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { TimeAnalysisService } from '../../time-analysis/services/time-analysis.service';
import { StrategyAnalyzerService } from '../../attempt-strategy/services/strategy-analyzer.service';

@Processor(ANALYTICS_QUEUE_NAME, {
  concurrency: 5,
})
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resultService: ResultService,
    private readonly timeAnalysisService: TimeAnalysisService,
    private readonly strategyAnalyzerService: StrategyAnalyzerService,
    @InjectQueue(RANKING_QUEUE_NAME)
    private readonly rankingQueue: Queue,
    private readonly jobProgressService: JobProgressService,
  ) {
    super();
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.warn(`Analytics worker connection/runtime error: ${err.message}`);
  }

  async process(job: Job<AnalyticsJobPayload>): Promise<any> {
    const { attemptId } = job.data;
    const jobId = String(job.id || `analytics_${attemptId}`);
    this.logger.log(
      `[AnalyticsWorker] Starting analytics processing for attempt '${attemptId}'`,
    );

    try {
      const attempt = await this.prisma.attempt.findUnique({
        where: { id: attemptId },
        include: { exam: true, result: true },
      });

      if (!attempt) {
        throw new Error(`Attempt '${attemptId}' not found for analytics`);
      }

      await this.jobProgressService.publishStarted(ANALYTICS_QUEUE_NAME, jobId, {
        type: 'EXAM_ANALYTICS',
        stage: 'ANALYTICS',
        attemptId,
        examId: attempt.examId,
        studentId: attempt.studentId,
        userId: (attempt as any)?.student?.userId,
        message: 'Calculating time & strategy analytics...',
      });

      // 1. Mark status as ANALYTICS_PROCESSING
      if (attempt.result) {
        await this.prisma.result.update({
          where: { id: attempt.result.id },
          data: { resultStatus: ResultStatusEnum.ANALYTICS_PROCESSING },
        });
      }

      // 2. Execute Time Analysis & Attempt Strategy calculations and materialize them
      await this.resultService.getTimeAnalysis(attemptId);
      await this.resultService.getAttemptStrategy(attemptId);

      try {
        await this.timeAnalysisService.generateTimeAnalysis(attemptId);
      } catch (tErr: any) {
        this.logger.warn(`Time analysis materialization error: ${tErr.message}`);
      }

      try {
        await this.strategyAnalyzerService.generateStrategyAnalysis(attemptId);
      } catch (sErr: any) {
        this.logger.warn(`Strategy analysis materialization error: ${sErr.message}`);
      }

      await this.jobProgressService.publishProgress(
        ANALYTICS_QUEUE_NAME,
        jobId,
        100,
        100,
        {
          stage: 'ANALYTICS',
          stageIndex: 2,
          totalStages: 4,
          percentage: 100,
          message: 'Analytics completed. Preparing ranking...',
          attemptId,
          examId: attempt.examId,
          studentId: attempt.studentId,
          userId: (attempt as any)?.student?.userId,
        },
      );

      // 3. Mark status as RANKING_PROCESSING
      if (attempt.result) {
        await this.prisma.result.update({
          where: { id: attempt.result.id },
          data: { resultStatus: ResultStatusEnum.RANKING_PROCESSING },
        });
      }

      // 4. Enqueue Ranking Worker
      const rankingJobId = `ranking_${attemptId}_${Date.now()}`;
      await this.rankingQueue.add(
        'RUN_RANKING',
        {
          examId: attempt.examId,
          attemptId,
          triggeredAt: new Date().toISOString(),
        },
        {
          jobId: rankingJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1500 },
          removeOnComplete: true,
        },
      );

      await this.jobProgressService.publishCompleted(ANALYTICS_QUEUE_NAME, jobId, {
        message: 'Analytics stage completed. Enqueued ranking stage.',
        stage: 'ANALYTICS',
        attemptId,
        examId: attempt.examId,
        studentId: attempt.studentId,
        userId: (attempt as any)?.student?.userId,
      });

      this.logger.log(
        `[AnalyticsWorker] Analytics completed for attempt '${attemptId}'. Enqueued ranking job.`,
      );

      return { success: true, attemptId };
    } catch (err: any) {
      this.logger.error(
        `[AnalyticsWorker] Failed analytics for attempt '${attemptId}': ${err.message}`,
        err.stack,
      );
      const safeErrorMsg = 'Result processing failed during subject and strategy analytics.';
      await this.jobProgressService.publishFailed(
        ANALYTICS_QUEUE_NAME,
        jobId,
        safeErrorMsg,
      );
      throw err;
    }
  }
}
