import { Injectable, Logger, Optional } from '@nestjs/common';
import { JobProgressGateway } from '../gateways/job-progress.gateway';
import {
  JobProgressEventDto,
  JobStatus,
  JobProgressData,
} from '../dto/job-progress.dto';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { parseBooleanFlag } from '../../feature-flag/feature-flag.constants';

@Injectable()
export class JobProgressService {
  private readonly logger = new Logger(JobProgressService.name);

  // In-memory status cache for fallback & fast lookups
  private readonly statusCache = new Map<string, JobProgressEventDto>();
  private readonly lastEmittedTime = new Map<string, number>();

  constructor(
    @Optional() private readonly gateway?: JobProgressGateway,
    @Optional() private readonly redisService?: RedisService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  private getCacheKey(queue: string, jobId: string): string {
    return `${queue}:${jobId}`;
  }

  private clampPercentage(current: number, total: number): JobProgressData {
    if (!total || total <= 0 || Number.isNaN(total)) {
      return { current: current || 0, total: 0, percentage: 0 };
    }
    const safeCurrent = Math.max(0, current || 0);
    const rawPct = (safeCurrent / total) * 100;
    const percentage = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));
    return { current: safeCurrent, total, percentage };
  }

  /**
   * Publishes QUEUED event when a job is added to BullMQ
   */
  async publishQueued(
    queue: string,
    jobId: string,
    meta?: {
      type?: string;
      userId?: string;
      attemptId?: string;
      examId?: string;
      institutionId?: string;
      resourceId?: string;
      message?: string;
    },
  ): Promise<JobProgressEventDto> {
    return this.publishEvent({
      event: 'job.queued',
      job: {
        queue,
        jobId,
        type: meta?.type,
        status: 'QUEUED',
        userId: meta?.userId,
        attemptId: meta?.attemptId,
        examId: meta?.examId,
        institutionId: meta?.institutionId,
        resourceId: meta?.resourceId,
      },
      progress: { current: 0, total: 0, percentage: 0 },
      message: meta?.message || 'Job queued for processing.',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publishes STARTED event when a worker picks up the job
   */
  async publishStarted(
    queue: string,
    jobId: string,
    arg3?: any,
    arg4?: any,
    arg5?: any,
  ): Promise<JobProgressEventDto> {
    let meta: {
      type?: string;
      stage?: string;
      userId?: string;
      attemptId?: string;
      examId?: string;
      resourceId?: string;
      totalRecords?: number;
      message?: string;
    } = {};

    if (typeof arg3 === 'object' && arg3 !== null) {
      meta = arg3;
    } else {
      if (typeof arg3 === 'string') meta.type = arg3;
      if (typeof arg4 === 'string') meta.message = arg4;
      if (typeof arg5 === 'object' && arg5 !== null) Object.assign(meta, arg5);
    }

    const total = meta.totalRecords || 0;
    return this.publishEvent({
      event: 'job.started',
      job: {
        queue,
        jobId,
        type: meta.type,
        status: 'PROCESSING',
        stage: meta.stage,
        userId: meta.userId,
        attemptId: meta.attemptId,
        examId: meta.examId,
        resourceId: meta.resourceId,
      },
      progress: this.clampPercentage(0, total),
      message: meta.message || 'Processing started.',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publishes PROGRESS event with actual work counters
   */
  async publishProgress(
    queue: string,
    jobId: string,
    arg3: any,
    arg4?: any,
    arg5?: any,
  ): Promise<JobProgressEventDto | null> {
    let current = 0;
    let total = 0;
    let meta: {
      stage?: string;
      stageIndex?: number;
      totalStages?: number;
      message?: string;
      userId?: string;
      attemptId?: string;
      examId?: string;
      percentage?: number;
    } = {};

    if (typeof arg3 === 'object' && arg3 !== null) {
      current = arg3.current || 0;
      total = arg3.total || 0;
      meta = arg3;
    } else {
      current = Number(arg3) || 0;
      if (typeof arg4 === 'number') {
        total = arg4;
        meta = arg5 || {};
      } else if (typeof arg4 === 'object' && arg4 !== null) {
        meta = arg4;
        total = (arg4 as any).total || 0;
      }
    }

    const cacheKey = this.getCacheKey(queue, jobId);
    const now = Date.now();
    const lastTime = this.lastEmittedTime.get(cacheKey) || 0;

    // Throttle intermediate progress updates (max 1 event per 200ms unless complete)
    const isTerminal = current >= total && total > 0;
    if (!isTerminal && now - lastTime < 200) {
      return null;
    }

    const progressData = this.clampPercentage(current, total);
    if (typeof meta.percentage === 'number') {
      progressData.percentage = Math.min(100, Math.max(0, meta.percentage));
    }

    // Monotonic check: prevent progress bar from moving backwards for same stage
    const existing = this.statusCache.get(cacheKey);
    if (
      existing &&
      existing.job.stage === meta.stage &&
      progressData.percentage < existing.progress.percentage &&
      !isTerminal
    ) {
      progressData.percentage = existing.progress.percentage;
    }

    this.lastEmittedTime.set(cacheKey, now);

    return this.publishEvent({
      event: 'job.progress',
      job: {
        queue,
        jobId,
        type: existing?.job?.type,
        status: 'PROCESSING',
        stage: meta.stage || existing?.job?.stage,
        userId: meta.userId || existing?.job?.userId,
        attemptId: meta.attemptId || existing?.job?.attemptId,
        examId: meta.examId || existing?.job?.examId,
      },
      progress: progressData,
      stageIndex: meta.stageIndex,
      totalStages: meta.totalStages,
      message:
        meta.message ||
        `Processing... (${progressData.current}/${progressData.total})`,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publishes COMPLETED event when job finishes successfully
   */
  async publishCompleted(
    queue: string,
    jobId: string,
    arg3?: any,
    arg4?: any,
  ): Promise<JobProgressEventDto> {
    let meta: {
      message?: string;
      resultSummary?: Record<string, any>;
      totalProcessed?: number;
      userId?: string;
      attemptId?: string;
      examId?: string;
    } = {};

    if (typeof arg3 === 'object' && arg3 !== null) {
      meta = arg3;
    } else {
      if (typeof arg3 === 'string') meta.message = arg3;
      if (typeof arg4 === 'object' && arg4 !== null) meta.resultSummary = arg4;
    }

    const cacheKey = this.getCacheKey(queue, jobId);
    const existing = this.statusCache.get(cacheKey);
    const total = meta.totalProcessed || existing?.progress?.total || 100;

    return this.publishEvent({
      event: 'job.completed',
      job: {
        queue,
        jobId,
        type: existing?.job?.type,
        status: 'COMPLETED',
        stage: 'COMPLETED',
        userId: meta.userId || existing?.job?.userId,
        attemptId: meta.attemptId || existing?.job?.attemptId,
        examId: meta.examId || existing?.job?.examId,
      },
      progress: { current: total, total, percentage: 100 },
      message: meta.message || 'Processing completed successfully.',
      resultSummary: meta.resultSummary,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publishes FAILED event when job fails
   */
  async publishFailed(
    queue: string,
    jobId: string,
    errorMessage: string,
    errorCode = 'JOB_PROCESSING_ERROR',
  ): Promise<JobProgressEventDto> {
    const cacheKey = this.getCacheKey(queue, jobId);
    const existing = this.statusCache.get(cacheKey);

    return this.publishEvent({
      event: 'job.failed',
      job: {
        queue,
        jobId,
        type: existing?.job?.type,
        status: 'FAILED',
        stage: 'FAILED',
        userId: existing?.job?.userId,
        attemptId: existing?.job?.attemptId,
        examId: existing?.job?.examId,
      },
      progress: existing?.progress || { current: 0, total: 0, percentage: 0 },
      message: errorMessage || 'Job processing failed.',
      errorCode,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publishes RETRYING event when BullMQ retries a job
   */
  async publishRetrying(
    queue: string,
    jobId: string,
    attemptNumber: number,
    maxAttempts: number,
  ): Promise<JobProgressEventDto> {
    const cacheKey = this.getCacheKey(queue, jobId);
    const existing = this.statusCache.get(cacheKey);

    return this.publishEvent({
      event: 'job.retrying',
      job: {
        queue,
        jobId,
        type: existing?.job?.type,
        status: 'RETRYING',
        stage: `RETRY_${attemptNumber}`,
        userId: existing?.job?.userId,
        attemptId: existing?.job?.attemptId,
        examId: existing?.job?.examId,
      },
      progress: existing?.progress || { current: 0, total: 0, percentage: 0 },
      message: `Retrying job (Attempt ${attemptNumber} of ${maxAttempts})...`,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Retrieves authoritative job status from cache or Redis
   */
  async getJobStatus(
    queue: string,
    jobId: string,
  ): Promise<JobProgressEventDto | null> {
    const cacheKey = this.getCacheKey(queue, jobId);
    const cached = this.statusCache.get(cacheKey);
    if (cached) return cached;

    if (this.redisService) {
      try {
        const raw = await this.redisService.get(`job_status:${cacheKey}`);
        if (raw) {
          return JSON.parse(raw);
        }
      } catch {
        // Fallback silently if Redis error occurs
      }
    }

    // Database persistent fallback for known queues
    if (this.prisma) {
      try {
        if (queue === 'ai-translation' || queue.startsWith('ai-translation')) {
          const job = await this.prisma.aiTranslationJob.findUnique({
            where: { id: jobId },
          });
          if (job) {
            const percentage = job.overallProgress || 0;
            const status: JobStatus =
              job.status === 'COMPLETED' || job.status === 'PARTIALLY_COMPLETED'
                ? 'COMPLETED'
                : job.status === 'FAILED'
                ? 'FAILED'
                : job.status === 'PROCESSING'
                ? 'PROCESSING'
                : 'QUEUED';

            const event: JobProgressEventDto = {
              event:
                status === 'COMPLETED'
                  ? 'job.completed'
                  : status === 'FAILED'
                  ? 'job.failed'
                  : status === 'PROCESSING'
                  ? 'job.progress'
                  : 'job.queued',
              job: {
                queue,
                jobId,
                type: 'AI Question Paper Translation',
                status,
                stage:
                  status === 'COMPLETED'
                    ? 'COMPLETED'
                    : status === 'FAILED'
                    ? 'FAILED'
                    : 'Translating regional languages',
                userId: job.createdById,
                examId: job.examId,
              },
              progress: {
                current: Math.round(((job.overallProgress || 0) / 100) * (job.totalQuestions || 1)),
                total: job.totalQuestions || 1,
                percentage,
              },
              message:
                status === 'COMPLETED'
                  ? 'All language translations completed successfully.'
                  : status === 'FAILED'
                  ? (job.errorMessage || 'Translation failed.')
                  : `Translation in progress (${percentage}%).`,
              timestamp: job.updatedAt ? job.updatedAt.toISOString() : new Date().toISOString(),
            };
            this.statusCache.set(cacheKey, event);
            return event;
          }
        }

        if (
          queue === 'schools-bulk-upload' ||
          queue === 'student-bulk-registration' ||
          queue === 'students-bulk-upload' ||
          queue.includes('bulk')
        ) {
          const upload = await this.prisma.bulkUpload.findUnique({
            where: { id: jobId },
          });
          if (upload) {
            const total = upload.validRowCount || upload.rowCount || 1;
            const current = (upload.activatedCount || 0) + (upload.failedCount || 0);
            const percentage = Math.min(100, Math.round((current / total) * 100));
            const status: JobStatus =
              upload.status === 'ACTIVATED' || upload.status === 'READY_FOR_REVIEW'
                ? 'COMPLETED'
                : upload.status === 'FAILED'
                ? 'FAILED'
                : upload.status === 'ACTIVATING' || upload.status === 'VALIDATING'
                ? 'PROCESSING'
                : 'QUEUED';

            const event: JobProgressEventDto = {
              event:
                status === 'COMPLETED'
                  ? 'job.completed'
                  : status === 'FAILED'
                  ? 'job.failed'
                  : status === 'PROCESSING'
                  ? 'job.progress'
                  : 'job.queued',
              job: {
                queue,
                jobId,
                type: upload.uploadType || 'Bulk Upload Processing',
                status,
                stage:
                  status === 'COMPLETED'
                    ? 'COMPLETED'
                    : status === 'FAILED'
                    ? 'FAILED'
                    : upload.status === 'ACTIVATING'
                    ? 'ACTIVATING_RECORDS'
                    : 'VALIDATING',
                userId: upload.uploadedById,
                institutionId: upload.institutionId || undefined,
              },
              progress: {
                current,
                total,
                percentage,
              },
              message:
                status === 'COMPLETED'
                  ? `Completed processing (${current}/${total} records).`
                  : status === 'FAILED'
                  ? (upload.rejectionReason || 'Bulk upload failed.')
                  : `Processing ${current} of ${total} records (${percentage}%)...`,
              timestamp: upload.updatedAt ? upload.updatedAt.toISOString() : new Date().toISOString(),
            };
            this.statusCache.set(cacheKey, event);
            return event;
          }
        }
      } catch (err: any) {
        this.logger.debug(`Failed database lookup for job ${queue}:${jobId}: ${err?.message}`);
      }
    }

    return null;
  }

  /**
   * Core publisher method
   */
  private async publishEvent(
    event: JobProgressEventDto,
  ): Promise<JobProgressEventDto> {
    const cacheKey = this.getCacheKey(event.job.queue, event.job.jobId);
    this.statusCache.set(cacheKey, event);

    // Save to Redis if enabled
    if (this.redisService) {
      try {
        await this.redisService.set(
          `job_status:${cacheKey}`,
          JSON.stringify(event),
          3600, // 1 hour TTL
        );
      } catch {
        // Ignore Redis errors
      }
    }

    // Deliver via WebSocket Gateway
    if (this.gateway) {
      try {
        this.gateway.emitJobProgress(event);
      } catch (err: any) {
        this.logger.warn(`Failed to emit WebSocket progress event: ${err.message}`);
      }
    }

    return event;
  }

  /**
   * Broadcasts exam-level completion / readiness event
   */
  emitExamCompleted(examId: string, status: string = 'READY_TO_PUBLISH') {
    if (this.gateway) {
      try {
        this.gateway.emitExamCompletion(examId, status);
      } catch (err: any) {
        this.logger.warn(`Failed to emit exam completion WebSocket event: ${err.message}`);
      }
    }
  }
}
