import { Processor, WorkerHost, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ResultService } from '../result.service';
import {
  EVALUATION_QUEUE_NAME,
  ANALYTICS_QUEUE_NAME,
  EvaluationJobPayload,
  ResultStatusEnum,
} from '../interfaces/result-lifecycle.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';

@Processor(EVALUATION_QUEUE_NAME, {
  concurrency: 5,
})
export class EvaluationProcessor extends WorkerHost {
  private readonly logger = new Logger(EvaluationProcessor.name);

  constructor(
    private readonly resultService: ResultService,
    private readonly prisma: PrismaService,
    @InjectQueue(ANALYTICS_QUEUE_NAME)
    private readonly analyticsQueue: Queue,
    private readonly jobProgressService: JobProgressService,
  ) {
    super();
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.warn(`Evaluation worker connection/runtime error: ${err.message}`);
  }

  async process(job: Job<EvaluationJobPayload>): Promise<any> {
    const { attemptId } = job.data;
    const jobId = String(job.id || `eval_${attemptId}`);
    this.logger.log(
      `[EvaluationWorker] Starting evaluation job for attempt '${attemptId}' (Job ID: ${jobId})`,
    );

    // Retrieve attempt owner to attach userId, examId, and studentId
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      select: {
        examId: true,
        studentId: true,
        student: { select: { userId: true } },
      },
    });
    const userId = (attempt as any)?.student?.userId;
    const examId = attempt?.examId;
    const studentId = attempt?.studentId;

    await this.jobProgressService.publishStarted(EVALUATION_QUEUE_NAME, jobId, {
      type: 'EXAM_EVALUATION',
      stage: 'EVALUATION',
      attemptId,
      examId,
      studentId,
      userId,
      message: 'Evaluating exam responses...',
    });

    try {
      // 1. Calculate question-level scoring and result atomicity
      const result = await this.resultService.calculateResult(attemptId);

      await this.jobProgressService.publishProgress(
        EVALUATION_QUEUE_NAME,
        jobId,
        100,
        100,
        {
          stage: 'EVALUATION',
          stageIndex: 1,
          totalStages: 4,
          message: 'Evaluation completed. Marking result...',
          attemptId,
          examId,
          studentId,
          userId,
          percentage: 100,
        },
      );

      // 2. Mark Result Status as EVALUATED
      if (result) {
        await this.prisma.result.update({
          where: { id: result.id },
          data: { resultStatus: ResultStatusEnum.EVALUATED },
        });
      }

      // 3. Enqueue Next Stage: Analytics Worker
      const analyticsJobId = `analytics_${attemptId}_${Date.now()}`;
      await this.analyticsQueue.add(
        'RUN_ANALYTICS',
        {
          attemptId,
          triggeredAt: new Date().toISOString(),
        },
        {
          jobId: analyticsJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1500 },
          removeOnComplete: true,
        },
      );

      await this.jobProgressService.publishCompleted(EVALUATION_QUEUE_NAME, jobId, {
        message: 'Evaluation stage completed successfully. Enqueueing analytics...',
        resultSummary: { attemptId, score: result?.totalScore },
        stage: 'EVALUATION',
        attemptId,
        examId,
        studentId,
        userId,
      });

      this.logger.log(
        `[EvaluationWorker] Evaluation completed for attempt '${attemptId}'. Enqueued analytics job.`,
      );

      return { success: true, attemptId, score: result?.totalScore };
    } catch (err: any) {
      this.logger.error(
        `[EvaluationWorker] Failed evaluation for attempt '${attemptId}': ${err.message}`,
        err.stack,
      );

      // Safe sanitized message for Super Admin UI
      const safeErrorMsg = 'Result evaluation failed during question scoring.';

      await this.jobProgressService.publishFailed(
        EVALUATION_QUEUE_NAME,
        jobId,
        safeErrorMsg,
      );

      // Mark result as FAILED if error persists
      try {
        const res = await this.prisma.result.findUnique({
          where: { attemptId },
        });
        if (res) {
          await this.prisma.result.update({
            where: { id: res.id },
            data: {
              resultStatus: ResultStatusEnum.FAILED,
              metadata: {
                ...(res.metadata as object || {}),
                failureReason: safeErrorMsg,
                failedAt: new Date().toISOString(),
              },
            },
          });
        }
      } catch {}

      throw err;
    }
  }
}
