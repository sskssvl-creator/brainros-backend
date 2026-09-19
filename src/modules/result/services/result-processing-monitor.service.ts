import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ResultReadinessService } from './result-readiness.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import {
  EVALUATION_QUEUE_NAME,
  EXAM_WINDOW_END_QUEUE_NAME,
  ResultStatusEnum,
  ExamPublicationStatusEnum,
} from '../interfaces/result-lifecycle.interface';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';

export interface ExamProcessingSummaryResponse {
  examId: string;
  examTitle: string;
  examType: 'LIVE' | 'MOCK';
  examTarget?: string;
  examDate?: string | null;
  answerKeyStatus?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  examStatus?: string;
  publicationStatus: string;
  status: 'EMPTY' | 'QUEUED' | 'PROCESSING' | 'READY_TO_PUBLISH' | 'PUBLISHED' | 'FAILED';
  overallPercentage: number;
  totalJobs: number;
  completedJobs: number;
  processingJobs: number;
  pendingJobs: number;
  failedJobs: number;
  stages: {
    evaluation: { total: number; completed: number; processing: number; failed: number; percentage: number };
    analytics: { total: number; completed: number; processing: number; failed: number; percentage: number };
    ranking: { total: number; completed: number; processing: number; failed: number; percentage: number };
    reconciliation: { total: number; completed: number; percentage: number; status: string };
  };
  isReadyToPublish: boolean;
  canPublish: boolean;
  notReadyReason: string | null;
  redisActive: boolean;
  lastUpdated: string;
}

export interface ExamProcessingJobItem {
  jobId: string;
  attemptId: string;
  studentId: string;
  studentName: string;
  studentEmail?: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
  progress: number;
  stage: 'WAITING' | 'EVALUATION' | 'ANALYTICS' | 'RANKING' | 'RECONCILIATION' | 'COMPLETED' | 'FAILED';
  message: string;
  errorMessage?: string | null;
  retryCount: number;
  submittedAt: string | null;
  updatedAt: string;
}

import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class ExamProcessingJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  sortBy?: string = 'updatedAt';

  @IsOptional()
  @IsIn(['asc', 'desc', 'ASC', 'DESC'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}

@Injectable()
export class ResultProcessingMonitorService {
  private readonly logger = new Logger(ResultProcessingMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly readinessService: ResultReadinessService,
    private readonly jobProgressService: JobProgressService,
    @InjectQueue(EVALUATION_QUEUE_NAME)
    private readonly evaluationQueue: Queue,
    @InjectQueue(EXAM_WINDOW_END_QUEUE_NAME)
    private readonly windowEndQueue: Queue,
  ) {}

  private maskEmail(email?: string | null): string | undefined {
    if (!email) return undefined;
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 2) return `*@${domain}`;
    return `${name[0]}***${name[name.length - 1]}@${domain}`;
  }

  /**
   * Authoritative summary of result processing for an exam.
   * Aggregated directly from PostgreSQL source of truth.
   */
  async getExamProcessingSummary(examId: string): Promise<ExamProcessingSummaryResponse> {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        examTarget: true,
        schedules: { take: 1, orderBy: { createdAt: 'desc' } },
        resultPublications: { take: 1, orderBy: { publicationVersion: 'desc' } },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    const titleUpper = (exam.title || '').toUpperCase();
    const isMockOrPractice = titleUpper.includes('MOCK') || titleUpper.includes('PRACTICE');
    const hasSchedules = exam.schedules && exam.schedules.length > 0;
    const titleIndicatesLive = titleUpper.includes('LIVE');
    const isLive = !isMockOrPractice && Boolean(hasSchedules || titleIndicatesLive);

    // If live exam has closed window and attempts waiting in PENDING_WINDOW_CLOSE, auto-trigger window end
    const latestSchedule = exam.schedules?.[0];
    const now = new Date();
    if (isLive && latestSchedule && latestSchedule.endTime && new Date(latestSchedule.endTime) <= now) {
      const hasPendingAttempts = await this.prisma.attempt.findFirst({
        where: {
          examId,
          status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
          OR: [
            { result: null },
            { result: { resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE } },
          ],
        },
        select: { id: true },
      });
      if (hasPendingAttempts) {
        this.logger.log(
          `[ResultProcessingMonitor] Triggering window-end batch processing for ended exam '${exam.title}' (${exam.id}).`,
        );
        await this.windowEndQueue
          .add(
            'EXAM_WINDOW_END',
            {
              examId,
              scheduleId: latestSchedule.id,
              triggeredAt: now.toISOString(),
            },
            {
              jobId: `window_end_monitor_${examId}_${Date.now()}`,
              removeOnComplete: true,
            },
          )
          .catch((e) => this.logger.warn(`Window end trigger notice: ${e.message}`));
      }
    }

    let stats: any = null;
    try {
      const rawStats = await this.prisma.$queryRaw<any[]>`
        SELECT
          COUNT(a.id)::int AS total_jobs,
          COUNT(CASE WHEN r.result_status IN ('PUBLISHED', 'READY_TO_PUBLISH') THEN 1 END)::int AS completed_jobs,
          COUNT(CASE WHEN r.result_status IN ('PROCESSING', 'EVALUATED', 'ANALYTICS_PROCESSING', 'RANKING_PROCESSING') THEN 1 END)::int AS processing_jobs,
          COUNT(CASE WHEN r.result_status = 'FAILED' THEN 1 END)::int AS failed_jobs,
          COUNT(CASE WHEN r.id IS NULL OR r.result_status = 'PENDING_WINDOW_CLOSE' OR ast.name NOT IN ('SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED') THEN 1 END)::int AS pending_jobs,

          COUNT(CASE WHEN r.total_score IS NOT NULL AND r.result_status NOT IN ('PROCESSING', 'FAILED', 'PENDING_WINDOW_CLOSE') THEN 1 END)::int AS eval_completed,
          COUNT(CASE WHEN r.result_status = 'PROCESSING' THEN 1 END)::int AS eval_processing,
          COUNT(CASE WHEN r.result_status = 'FAILED' THEN 1 END)::int AS eval_failed,

          COUNT(CASE WHEN (ta.id IS NOT NULL OR sa.id IS NOT NULL OR ear.id IS NOT NULL OR r.result_status IN ('READY_TO_PUBLISH', 'PUBLISHED', 'EVALUATED')) AND r.total_score IS NOT NULL THEN 1 END)::int AS analytics_completed,
          COUNT(CASE WHEN r.total_score IS NOT NULL AND ta.id IS NULL AND sa.id IS NULL AND ear.id IS NULL AND r.result_status NOT IN ('FAILED', 'READY_TO_PUBLISH', 'PUBLISHED', 'EVALUATED') THEN 1 END)::int AS analytics_processing,

          COUNT(CASE WHEN cr.id IS NOT NULL OR r.result_status IN ('READY_TO_PUBLISH', 'PUBLISHED') THEN 1 END)::int AS ranking_completed,
          COUNT(CASE WHEN cr.id IS NULL AND r.result_status NOT IN ('FAILED', 'READY_TO_PUBLISH', 'PUBLISHED') THEN 1 END)::int AS ranking_processing
        FROM attempts a
        JOIN attempt_statuses ast ON ast.id = a.status_id
        LEFT JOIN results r ON r.attempt_id = a.id
        LEFT JOIN LATERAL (SELECT id FROM time_analyses WHERE attempt_id = a.id LIMIT 1) ta ON true
        LEFT JOIN LATERAL (SELECT id FROM strategy_analyses WHERE attempt_id = a.id LIMIT 1) sa ON true
        LEFT JOIN LATERAL (SELECT id FROM candidate_ranks WHERE attempt_id = a.id LIMIT 1) cr ON true
        LEFT JOIN LATERAL (SELECT id FROM exam_analysis_reports WHERE attempt_id = a.id LIMIT 1) ear ON true
        WHERE a.exam_id = ${Prisma.raw(`'${examId}'::uuid`)}
          AND ast.name NOT IN ('CANCELLED', 'NOT_STARTED')
      `;
      stats = rawStats?.[0];
    } catch (err) {
      this.logger.warn(`Aggregated stats query error: ${err?.message}`);
    }

    if (!stats) {
      try {
        const attempts = await this.prisma.attempt.findMany({
          where: { examId },
          include: {
            status: true,
            result: true,
            timeAnalyses: { select: { id: true } },
            strategyAnalyses: { select: { id: true } },
            candidateRanks: { select: { id: true } },
            analysisReport: { select: { id: true } },
          },
        });

        if (attempts && attempts.length > 0) {
          let total_jobs = 0;
          let completed_jobs = 0;
          let processing_jobs = 0;
          let failed_jobs = 0;
          let pending_jobs = 0;

          let eval_completed = 0;
          let eval_processing = 0;
          let eval_failed = 0;

          let analytics_completed = 0;
          let analytics_processing = 0;

          let ranking_completed = 0;
          let ranking_processing = 0;

          for (const a of attempts) {
            const statusName = a.status?.name;
            if (statusName === 'CANCELLED' || statusName === 'NOT_STARTED') continue;
            total_jobs++;

            const r = (a as any).result;
            const resStatus = r?.resultStatus;

            if (resStatus === 'PUBLISHED' || resStatus === 'READY_TO_PUBLISH') {
              completed_jobs++;
            } else if (resStatus === 'FAILED') {
              failed_jobs++;
            } else if (
              resStatus === 'PROCESSING' ||
              resStatus === 'EVALUATED' ||
              resStatus === 'ANALYTICS_PROCESSING' ||
              resStatus === 'RANKING_PROCESSING'
            ) {
              processing_jobs++;
            } else {
              pending_jobs++;
            }

            if (
              r &&
              r.totalScore !== null &&
              r.totalScore !== undefined &&
              resStatus !== 'PROCESSING' &&
              resStatus !== 'FAILED' &&
              resStatus !== 'PENDING_WINDOW_CLOSE'
            ) {
              eval_completed++;
            } else if (resStatus === 'PROCESSING') {
              eval_processing++;
            } else if (resStatus === 'FAILED') {
              eval_failed++;
            }

            const hasAnalytics =
              ((a as any).timeAnalyses?.length || 0) > 0 ||
              ((a as any).strategyAnalyses?.length || 0) > 0 ||
              (a as any).analysisReport !== null ||
              ['EVALUATED', 'READY_TO_PUBLISH', 'PUBLISHED'].includes(resStatus);
            if (hasAnalytics && r?.totalScore !== null && r?.totalScore !== undefined) {
              analytics_completed++;
            } else if (r?.totalScore !== null && r?.totalScore !== undefined && resStatus !== 'FAILED') {
              analytics_processing++;
            }

            const hasRank =
              ((a as any).candidateRanks?.length || 0) > 0 ||
              ['READY_TO_PUBLISH', 'PUBLISHED'].includes(resStatus);
            if (hasRank) {
              ranking_completed++;
            } else if (hasAnalytics && resStatus !== 'FAILED') {
              ranking_processing++;
            }
          }

          stats = {
            total_jobs,
            completed_jobs,
            processing_jobs,
            failed_jobs,
            pending_jobs,
            eval_completed,
            eval_processing,
            eval_failed,
            analytics_completed,
            analytics_processing,
            ranking_completed,
            ranking_processing,
          };
        }
      } catch (fallbackErr) {
        this.logger.warn(`ORM fallback stats query error: ${fallbackErr?.message}`);
      }
    }

    const totalJobs = Number(stats?.total_jobs || 0);
    const completedJobs = Number(stats?.completed_jobs || 0);
    const processingJobs = Number(stats?.processing_jobs || 0);
    const pendingJobs = Number(stats?.pending_jobs || 0);
    const failedJobs = Number(stats?.failed_jobs || 0);

    const evalCompleted = Math.min(totalJobs, Number(stats?.eval_completed || 0));
    const evalProcessing = Number(stats?.eval_processing || 0);
    const evalFailed = Number(stats?.eval_failed || 0);

    let rankingSnapshotCompleted = false;
    try {
      const latestRankSnapshot = await this.prisma.rankSnapshot.findFirst({
        where: { examId },
        orderBy: { snapshotVersion: 'desc' },
        select: { status: true },
      });
      rankingSnapshotCompleted = latestRankSnapshot
        ? latestRankSnapshot.status === 'COMPLETED'
        : (Number(stats?.ranking_completed || 0) === totalJobs && totalJobs > 0);
    } catch {
      rankingSnapshotCompleted = totalJobs > 0;
    }

    let analyticsCompleted = Math.min(totalJobs, Number(stats?.analytics_completed || 0));
    let analyticsProcessing = Number(stats?.analytics_processing || 0);
    const analyticsFailed = Number(stats?.eval_failed || 0);

    let rankingCompleted = Math.min(totalJobs, Number(stats?.ranking_completed || 0));
    if (rankingSnapshotCompleted && totalJobs > 0) {
      rankingCompleted = totalJobs;
    }
    const rankingProcessing = Number(stats?.ranking_processing || 0);
    const rankingFailed = Number(stats?.eval_failed || 0);

    // If evaluated attempts exist, ensure analytics & ranking counts match eval completion
    if (evalCompleted > 0) {
      analyticsCompleted = Math.max(analyticsCompleted, evalCompleted);
      rankingCompleted = Math.max(rankingCompleted, evalCompleted);
    }

    const allStagesFinished =
      totalJobs > 0 &&
      evalCompleted === totalJobs &&
      analyticsCompleted === totalJobs &&
      rankingCompleted === totalJobs;

    const effectiveCompletedJobs = Math.max(
      completedJobs,
      allStagesFinished ? totalJobs : 0,
    );

    const effectiveProcessingJobs = Math.max(
      0,
      totalJobs - effectiveCompletedJobs - failedJobs - pendingJobs,
    );

    const overallPercentage =
      totalJobs > 0
        ? Math.min(100, Math.max(0, Math.round((effectiveCompletedJobs / totalJobs) * 100)))
        : 0;

    const latestPub = exam.resultPublications?.[0];
    const isPublished = Boolean(
      latestPub && (latestPub.status === 'PUBLISHED' || latestPub.publishedAt),
    );

    const isReadyToPublish =
      (totalJobs > 0 &&
        evalCompleted === totalJobs &&
        failedJobs === 0 &&
        rankingSnapshotCompleted) ||
      latestPub?.status === 'READY_TO_PUBLISH';

    const canPublish = isReadyToPublish && !isPublished;

    let overallStatus: ExamProcessingSummaryResponse['status'] = 'PROCESSING';
    let publicationStatus = 'NOT_READY';
    let notReadyReason: string | null = null;

    if (totalJobs === 0) {
      overallStatus = 'EMPTY';
      notReadyReason = 'No candidate attempts found.';
    } else if (isPublished) {
      overallStatus = 'PUBLISHED';
      publicationStatus = 'PUBLISHED';
    } else if (canPublish) {
      overallStatus = 'READY_TO_PUBLISH';
      publicationStatus = 'READY_TO_PUBLISH';
    } else if (failedJobs > 0) {
      overallStatus = 'FAILED';
      publicationStatus = 'PROCESSING';
      notReadyReason = `${failedJobs} job(s) failed. Retry required.`;
    } else if (effectiveCompletedJobs === 0 && effectiveProcessingJobs === 0) {
      overallStatus = 'QUEUED';
      publicationStatus = 'PROCESSING';
      notReadyReason = 'Waiting for jobs to start.';
    } else {
      publicationStatus = 'PROCESSING';
      if (evalCompleted < totalJobs) {
        notReadyReason = `${totalJobs - evalCompleted} evaluation(s) pending.`;
      } else if (!rankingSnapshotCompleted) {
        notReadyReason = 'Rank snapshot pending.';
      }
    }

    const redisActive = Boolean(this.redisService.getClient());

    return {
      examId,
      examTitle: exam.title,
      examType: isLive ? 'LIVE' : 'MOCK',
      examDate: exam.schedules?.[0]?.startTime
        ? new Date(exam.schedules[0].startTime).toISOString()
        : exam.createdAt
          ? new Date(exam.createdAt).toISOString()
          : new Date().toISOString(),
      answerKeyStatus: exam.schedules?.[0]?.hasAnswerKey ? 'UPLOADED' : 'PENDING',
      startedAt: exam.schedules?.[0]?.startTime ? new Date(exam.schedules[0].startTime).toISOString() : null,
      completedAt:
        isPublished
          ? exam.resultPublications?.[0]?.publishedAt
            ? new Date(exam.resultPublications[0].publishedAt).toISOString()
            : null
          : (overallStatus === 'READY_TO_PUBLISH'
              ? exam.schedules?.[0]?.endTime
                ? new Date(exam.schedules[0].endTime).toISOString()
                : null
              : null),
      examStatus: exam.status?.name,
      publicationStatus,
      status: overallStatus,
      overallPercentage,
      totalJobs,
      completedJobs: effectiveCompletedJobs,
      processingJobs: effectiveProcessingJobs,
      pendingJobs,
      failedJobs,
      stages: {
        evaluation: {
          total: totalJobs,
          completed: evalCompleted,
          processing: evalProcessing,
          failed: evalFailed,
          percentage: totalJobs > 0 ? Math.round((evalCompleted / totalJobs) * 100) : 0,
        },
        analytics: {
          total: totalJobs,
          completed: analyticsCompleted,
          processing: analyticsProcessing,
          failed: analyticsFailed,
          percentage: totalJobs > 0 ? Math.round((analyticsCompleted / totalJobs) * 100) : 0,
        },
        ranking: {
          total: totalJobs,
          completed: rankingCompleted,
          processing: rankingProcessing,
          failed: rankingFailed,
          percentage: totalJobs > 0 ? Math.round((rankingCompleted / totalJobs) * 100) : 0,
        },
        reconciliation: {
          total: totalJobs,
          completed: failedJobs === 0 && evalCompleted === totalJobs ? totalJobs : evalCompleted,
          percentage: totalJobs > 0 ? Math.round((evalCompleted / totalJobs) * 100) : 0,
          status: failedJobs === 0 ? 'HEALTHY' : 'RETRY_REQUIRED',
        },
      },
      isReadyToPublish,
      canPublish,
      notReadyReason,
      redisActive,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Server-side paginated, filtered, and searched job-by-job table items.
   */
  async getExamProcessingJobs(
    examId: string,
    query: ExamProcessingJobsQueryDto,
  ): Promise<{ items: ExamProcessingJobItem[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    const skip = (page - 1) * limit;

    const baseWhere: any = {
      examId,
      status: { name: { notIn: ['CANCELLED', 'NOT_STARTED'] } },
    };

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      baseWhere.OR = [
        { student: { name: { contains: term, mode: 'insensitive' } } },
        { studentId: { contains: term, mode: 'insensitive' } },
        { id: { contains: term, mode: 'insensitive' } },
      ];
    }

    // Status filter
    if (query.status && query.status !== 'ALL') {
      switch (query.status) {
        case 'FAILED':
          baseWhere.result = { resultStatus: ResultStatusEnum.FAILED };
          break;
        case 'COMPLETED':
          baseWhere.result = {
            resultStatus: { in: [ResultStatusEnum.READY_TO_PUBLISH, ResultStatusEnum.PUBLISHED] },
          };
          break;
        case 'PROCESSING':
          baseWhere.result = {
            resultStatus: {
              in: [
                ResultStatusEnum.PROCESSING,
                ResultStatusEnum.EVALUATED,
                ResultStatusEnum.ANALYTICS_PROCESSING,
                ResultStatusEnum.RANKING_PROCESSING,
              ],
            },
          };
          break;
        case 'PENDING':
          baseWhere.OR = [
            { result: null },
            { result: { resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE } },
          ];
          break;
        default:
          break;
      }
    }

    // Sorting
    let orderBy: any = { createdAt: 'desc' };
    if (query.sortBy === 'studentName') {
      orderBy = { student: { name: query.sortOrder || 'asc' } };
    } else if (query.sortBy === 'updatedAt') {
      orderBy = { updatedAt: query.sortOrder || 'desc' };
    }

    const [total, attemptsResult, latestRankSnapshot] = await Promise.all([
      this.prisma.attempt.count({ where: baseWhere }),
      this.prisma.attempt.findMany({
        where: baseWhere,
        skip,
        take: limit,
        orderBy,
        include: {
          student: {
            include: {
              user: { select: { email: true } },
            },
          },
          status: true,
          result: true,
          timeAnalyses: { select: { id: true }, take: 1 },
          strategyAnalyses: { select: { id: true }, take: 1 },
          candidateRanks: { select: { id: true }, take: 1 },
          analysisReport: { select: { id: true } },
        },
      }),
      this.prisma.rankSnapshot.findFirst({
        where: { examId },
        orderBy: { snapshotVersion: 'desc' },
        select: { status: true },
      }),
    ]);

    const attempts = attemptsResult as any[];
    const isRankSnapshotCompleted = latestRankSnapshot?.status === 'COMPLETED';
    const items: ExamProcessingJobItem[] = [];

    for (const att of attempts) {
      const jobId = `eval_${att.id}`;
      const res = att.result;
      const resStatus = res?.resultStatus;

      const evalDone = Boolean(
        res &&
          res.totalScore !== null &&
          res.totalScore !== undefined &&
          resStatus !== ResultStatusEnum.PROCESSING &&
          resStatus !== ResultStatusEnum.FAILED &&
          resStatus !== ResultStatusEnum.PENDING_WINDOW_CLOSE,
      );
      const isFailed = resStatus === ResultStatusEnum.FAILED;
      const analyticsDone = Boolean(
        att.timeAnalyses?.length > 0 ||
          att.strategyAnalyses?.length > 0 ||
          att.analysisReport !== null ||
          ['EVALUATED', 'READY_TO_PUBLISH', 'PUBLISHED'].includes(resStatus || ''),
      );
      const rankDone = Boolean(
        att.candidateRanks?.length > 0 ||
          ['READY_TO_PUBLISH', 'PUBLISHED'].includes(resStatus || '') ||
          isRankSnapshotCompleted ||
          evalDone,
      );

      let status: ExamProcessingJobItem['status'] = 'PENDING';
      let stage: ExamProcessingJobItem['stage'] = 'WAITING';
      let progress = 0;
      let message = 'Waiting in queue';

      if (isFailed) {
        status = 'FAILED';
        stage = 'FAILED';
        progress = 0;
        message = 'Result calculation failed';
      } else if (
        resStatus === ResultStatusEnum.PUBLISHED ||
        resStatus === ResultStatusEnum.READY_TO_PUBLISH ||
        (evalDone && (analyticsDone || rankDone))
      ) {
        status = 'COMPLETED';
        stage = 'COMPLETED';
        progress = 100;
        message = 'Completed all processing stages';
      } else if (rankDone) {
        status = 'PROCESSING';
        stage = 'RANKING';
        progress = 90;
        message = 'Finalizing ranking and readiness verification';
      } else if (analyticsDone) {
        status = 'PROCESSING';
        stage = 'RANKING';
        progress = 75;
        message = 'Generating percentile & rank snapshots';
      } else if (evalDone) {
        status = 'PROCESSING';
        stage = 'ANALYTICS';
        progress = 50;
        message = 'Calculating subject and chapter analytics';
      } else if (resStatus === ResultStatusEnum.PROCESSING) {
        status = 'PROCESSING';
        stage = 'EVALUATION';
        progress = 25;
        message = 'Evaluating student responses';
      }

      // Check live cache from BullMQ JobProgressService if processing
      if (status === 'PROCESSING') {
        const liveStatus = await this.jobProgressService.getJobStatus(EVALUATION_QUEUE_NAME, jobId);
        if (liveStatus?.progress?.percentage) {
          progress = Math.max(progress, liveStatus.progress.percentage);
          if (liveStatus.message) message = liveStatus.message;
        }
      }

      const retryCount = (res?.metadata as any)?.retryCount || 0;
      const errorMessage = isFailed
        ? (res?.metadata as any)?.failureReason || 'Result processing failed.'
        : null;

      items.push({
        jobId,
        attemptId: att.id,
        studentId: att.studentId,
        studentName: att.student?.name || 'Candidate',
        studentEmail: this.maskEmail(att.student?.user?.email),
        status,
        progress,
        stage,
        message,
        errorMessage,
        retryCount,
        submittedAt: att.submittedAt ? new Date(att.submittedAt).toISOString() : null,
        updatedAt: att.updatedAt ? new Date(att.updatedAt).toISOString() : new Date().toISOString(),
      });
    }

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Safe individual job details for Super Admin inspection modal.
   * Never leaks raw stack traces, database credentials, or server paths.
   */
  async getJobDetail(examId: string, jobId: string) {
    const attemptId = jobId.startsWith('eval_') ? jobId.replace('eval_', '') : jobId;

    const attempt = await this.prisma.attempt.findFirst({
      where: { id: attemptId, examId },
      include: {
        student: {
          include: {
            user: { select: { email: true } },
          },
        },
        result: true,
        timeAnalyses: { select: { id: true, createdAt: true }, take: 1 },
        strategyAnalyses: { select: { id: true, createdAt: true }, take: 1 },
        candidateRanks: { select: { rank: true, percentile: true }, take: 1 },
        analysisReport: { select: { id: true } },
      },
    });

    if (!attempt) {
      throw new NotFoundException(`Job for attempt '${attemptId}' in exam '${examId}' not found.`);
    }

    const res = attempt.result;
    const isFailed = res?.resultStatus === ResultStatusEnum.FAILED;
    const evalDone = Boolean(
      res &&
        res.totalScore !== null &&
        res.totalScore !== undefined &&
        res?.resultStatus !== ResultStatusEnum.FAILED,
    );
    const analyticsDone = Boolean(
      attempt.timeAnalyses?.length > 0 ||
        attempt.strategyAnalyses?.length > 0 ||
        (attempt as any).analysisReport !== null ||
        ['EVALUATED', 'READY_TO_PUBLISH', 'PUBLISHED'].includes(res?.resultStatus || ''),
    );
    const rankDone = Boolean(
      attempt.candidateRanks?.length > 0 ||
        ['READY_TO_PUBLISH', 'PUBLISHED'].includes(res?.resultStatus || '') ||
        evalDone,
    );

    return {
      jobId: `eval_${attempt.id}`,
      attemptId: attempt.id,
      studentId: attempt.studentId,
      studentName: attempt.student?.name || 'Student Candidate',
      studentEmail: this.maskEmail(attempt.student?.user?.email),
      status: isFailed
        ? 'FAILED'
        : evalDone && analyticsDone && rankDone
          ? 'COMPLETED'
          : 'PROCESSING',
      stage: isFailed
        ? 'FAILED'
        : evalDone && analyticsDone && rankDone
          ? 'COMPLETED'
          : !evalDone
            ? 'EVALUATION'
            : !analyticsDone
              ? 'ANALYTICS'
              : 'RANKING',
      stages: {
        evaluation: evalDone ? 'COMPLETED' : isFailed ? 'FAILED' : 'PROCESSING',
        analytics: analyticsDone ? 'COMPLETED' : evalDone ? 'PROCESSING' : 'PENDING',
        ranking: rankDone ? 'COMPLETED' : analyticsDone ? 'PROCESSING' : 'PENDING',
      },
      score: evalDone ? res?.totalScore : null,
      rank: rankDone ? attempt.candidateRanks[0]?.rank : null,
      percentile: rankDone ? attempt.candidateRanks[0]?.percentile : null,
      retryCount: (res?.metadata as any)?.retryCount || 0,
      errorMessage: isFailed ? (res?.metadata as any)?.failureReason || 'Result processing failed.' : null,
      createdAt: attempt.createdAt.toISOString(),
      submittedAt: attempt.submittedAt?.toISOString() || null,
      updatedAt: attempt.updatedAt.toISOString(),
    };
  }

  /**
   * Safe batch retry for all failed jobs of an exam.
   * Re-enqueues into BullMQ with deterministic job IDs to guarantee idempotency.
   */
  async retryFailedJobs(examId: string, superAdminUserId: string) {
    const failedAttempts = await this.prisma.attempt.findMany({
      where: {
        examId,
        result: {
          resultStatus: ResultStatusEnum.FAILED,
        },
      },
      include: {
        result: true,
      },
    });

    if (failedAttempts.length === 0) {
      return { success: true, retriedCount: 0, message: 'No failed jobs found to retry.' };
    }

    const now = new Date();
    let retriedCount = 0;

    for (const att of failedAttempts) {
      const evalJobId = `eval_${att.id}`;
      const currentRetry = ((att.result?.metadata as any)?.retryCount || 0) + 1;

      // Update Result state back to PROCESSING
      await this.prisma.result.update({
        where: { id: att.result!.id },
        data: {
          resultStatus: ResultStatusEnum.PROCESSING,
          metadata: {
            ...(att.result?.metadata as object || {}),
            retryCount: currentRetry,
            lastRetriedAt: now.toISOString(),
            lastRetriedBy: superAdminUserId,
            failureReason: null,
          },
        },
      });

      // Remove any stale BullMQ job if present
      try {
        const existingJob = await this.evaluationQueue.getJob(evalJobId);
        if (existingJob) {
          await existingJob.remove();
        }
      } catch {}

      // Re-enqueue cleanly
      await this.evaluationQueue.add(
        'EVALUATE_ATTEMPT',
        {
          attemptId: att.id,
          triggeredAt: now.toISOString(),
          evaluationMode: 'DEFERRED',
          retryCount: currentRetry,
        },
        {
          jobId: evalJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        },
      );

      await this.jobProgressService.publishRetrying(
        EVALUATION_QUEUE_NAME,
        evalJobId,
        currentRetry,
        3,
      );

      retriedCount++;
    }

    this.logger.log(
      `[ResultProcessingMonitor] Super Admin '${superAdminUserId}' triggered retry for ${retriedCount} failed jobs in exam '${examId}'.`,
    );

    return {
      success: true,
      retriedCount,
      message: `Successfully re-queued ${retriedCount} failed job(s) for evaluation.`,
    };
  }

  /**
   * Safe single-job retry.
   */
  async retrySingleJob(examId: string, jobId: string, superAdminUserId: string) {
    const attemptId = jobId.startsWith('eval_') ? jobId.replace('eval_', '') : jobId;

    const attempt = await this.prisma.attempt.findFirst({
      where: { id: attemptId, examId },
      include: { result: true },
    });

    if (!attempt) {
      throw new NotFoundException(`Attempt '${attemptId}' for exam '${examId}' not found.`);
    }

    const now = new Date();
    const evalJobId = `eval_${attempt.id}`;
    const currentRetry = ((attempt.result?.metadata as any)?.retryCount || 0) + 1;

    if (attempt.result) {
      await this.prisma.result.update({
        where: { id: attempt.result.id },
        data: {
          resultStatus: ResultStatusEnum.PROCESSING,
          metadata: {
            ...(attempt.result.metadata as object || {}),
            retryCount: currentRetry,
            lastRetriedAt: now.toISOString(),
            lastRetriedBy: superAdminUserId,
            failureReason: null,
          },
        },
      });
    }

    try {
      const existing = await this.evaluationQueue.getJob(evalJobId);
      if (existing) await existing.remove();
    } catch {}

    await this.evaluationQueue.add(
      'EVALUATE_ATTEMPT',
      {
        attemptId: attempt.id,
        triggeredAt: now.toISOString(),
        evaluationMode: 'DEFERRED',
        retryCount: currentRetry,
      },
      {
        jobId: evalJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    );

    await this.jobProgressService.publishRetrying(
      EVALUATION_QUEUE_NAME,
      evalJobId,
      currentRetry,
      3,
    );

    return {
      success: true,
      jobId: evalJobId,
      attemptId: attempt.id,
      message: `Job ${evalJobId} re-queued successfully.`,
    };
  }
}
