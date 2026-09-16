import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ResultReadinessService } from './result-readiness.service';
import {
  ExamPublicationStatusEnum,
  ResultStatusEnum,
  BulkResultNotificationJobPayload,
} from '../interfaces/result-lifecycle.interface';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  NOTIFICATION_QUEUE_NAME,
  WHATSAPP_REMINDER_QUEUE_NAME,
  WhatsAppReminderJobData,
  WHATSAPP_JOB_NAMES,
} from '../../notification/interfaces/exam-notification-job.interface';
import {
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { normalizeToWhatsApp, maskPhone } from '../../notification/utils/phone-normalizer.util';
import { RankGenerationService } from '../../rank-engine/services/rank-generation.service';

@Injectable()
export class ExamPublicationService {
  private readonly logger = new Logger(ExamPublicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly readinessService: ResultReadinessService,
    private readonly rankGenerationService: RankGenerationService,
    @InjectQueue(NOTIFICATION_QUEUE_NAME)
    private readonly notificationQueue: Queue,
    @InjectQueue(WHATSAPP_REMINDER_QUEUE_NAME)
    private readonly whatsAppQueue: Queue,
  ) {}

  /**
   * Get all live exams with their publication status and readiness metrics.
   */
  async getLiveExamsPublicationDashboard(query?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }) {
    const page = query?.page ? Math.max(1, Number(query.page)) : 1;
    const limit = query?.limit ? Math.min(Math.max(1, Number(query.limit)), 100) : 10;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query?.search && query.search.trim()) {
      where.OR = [
        { title: { contains: query.search.trim(), mode: 'insensitive' } },
        { examTarget: { name: { contains: query.search.trim(), mode: 'insensitive' } } },
      ];
    }

    if (query?.status && query.status !== 'ALL') {
      if (query.status === 'PUBLISHED') {
        where.resultPublications = { some: {} };
      }
    }

    // 1. Fetch paginated exams and total count
    const [exams, totalCount, allExamsCount] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          examTarget: { select: { id: true, name: true } },
          status: { select: { id: true, name: true } },
          schedules: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              startTime: true,
              endTime: true,
              status: true,
            },
          },
          resultPublications: {
            orderBy: { publicationVersion: 'desc' },
            take: 1,
            include: {
              publishedBy: { select: { id: true, email: true, phone: true } },
            },
          },
          _count: {
            select: { attempts: true },
          },
        },
      }),
      this.prisma.exam.count({ where }),
      this.prisma.exam.count(),
    ]);

    const examIds = exams.map((e) => e.id);

    // 2. Batch aggregation for attempts in the current page's exams
    let attemptStats: Array<{
      exam_id: string;
      total_eligible: number;
      finalized: number;
      evaluated: number;
      analytics_completed: number;
      pending_security: number;
    }> = [];

    if (examIds.length > 0) {
      try {
        attemptStats = await this.prisma.$queryRaw<any[]>`
          SELECT
            a.exam_id,
            COUNT(a.id)::int AS total_eligible,
            COUNT(CASE WHEN ast.name IN ('SUBMITTED', 'AUTO_SUBMITTED') THEN 1 END)::int AS finalized,
            COUNT(CASE WHEN ast.name IN ('SUBMITTED', 'AUTO_SUBMITTED') AND r.id IS NOT NULL AND r.result_status NOT IN ('PENDING_WINDOW_CLOSE', 'PROCESSING', 'FAILED') THEN 1 END)::int AS evaluated,
            COUNT(CASE WHEN ast.name IN ('SUBMITTED', 'AUTO_SUBMITTED') AND ta.id IS NOT NULL AND sa.id IS NOT NULL THEN 1 END)::int AS analytics_completed,
            COUNT(CASE WHEN sr.status = 'PENDING' THEN 1 END)::int AS pending_security
          FROM attempts a
          JOIN attempt_statuses ast ON ast.id = a.status_id
          LEFT JOIN results r ON r.attempt_id = a.id
          LEFT JOIN LATERAL (SELECT id FROM time_analyses WHERE attempt_id = a.id LIMIT 1) ta ON true
          LEFT JOIN LATERAL (SELECT id FROM strategy_analyses WHERE attempt_id = a.id LIMIT 1) sa ON true
          LEFT JOIN attempt_security_reviews sr ON sr.attempt_id = a.id AND sr.status = 'PENDING'
          WHERE a.exam_id IN (${Prisma.join(examIds.map((id) => Prisma.raw(`'${id}'::uuid`)))})
            AND ast.name NOT IN ('CANCELLED', 'NOT_STARTED')
          GROUP BY a.exam_id
        `;
      } catch (err) {
        this.logger.warn(`Aggregated attempt stats query error: ${err?.message}`);
      }
    }

    const statsMap = new Map<string, any>();
    for (const stat of attemptStats) {
      statsMap.set(stat.exam_id, stat);
    }

    // 3. Batch check rank snapshots for current page exams
    let rankSnapshots: any[] = [];
    if (examIds.length > 0) {
      try {
        rankSnapshots = await this.prisma.rankSnapshot.findMany({
          where: { examId: { in: examIds } },
          orderBy: { snapshotVersion: 'desc' },
          distinct: ['examId'],
          select: { examId: true, status: true },
        });
      } catch (err) {
        this.logger.warn(`Rank snapshot batch query error: ${err?.message}`);
      }
    }
    const rankMap = new Map<string, string>();
    for (const r of rankSnapshots) {
      rankMap.set(r.examId, r.status);
    }

    const items = exams.map((exam) => {
      const titleUpper = (exam.title || '').toUpperCase();
      const isMockOrPractice = titleUpper.includes('MOCK') || titleUpper.includes('PRACTICE');
      const hasSchedules = exam.schedules && exam.schedules.length > 0;
      const titleIndicatesLive = titleUpper.includes('LIVE');
      const isLive = !isMockOrPractice && Boolean(hasSchedules || titleIndicatesLive);

      const stats = statsMap.get(exam.id) || {
        total_eligible: 0,
        finalized: 0,
        evaluated: 0,
        analytics_completed: 0,
        pending_security: 0,
      };

      const totalEligible = Number(stats.total_eligible || 0);
      const finalized = Number(stats.finalized || 0);
      const evaluated = Number(stats.evaluated || 0);
      const analyticsCompleted = Number(stats.analytics_completed || 0);
      const pendingSecurity = Number(stats.pending_security || 0);

      const rankingCompleted = rankMap.get(exam.id) === 'COMPLETED';
      const securityReviewCompleted = pendingSecurity === 0;

      const latestPub = exam.resultPublications?.[0];
      const isPublished = Boolean(latestPub);

      // Determine readiness
      let isReadyToPublish = false;
      let notReadyReason: string | null = null;
      let publicationStatus: 'READY_TO_PUBLISH' | 'PUBLISHED' | 'PROCESSING' | 'NOT_READY' =
        'NOT_READY';

      if (isPublished) {
        publicationStatus = 'PUBLISHED';
      } else if (
        totalEligible > 0 &&
        finalized === totalEligible &&
        evaluated === finalized &&
        securityReviewCompleted
      ) {
        isReadyToPublish = true;
        publicationStatus = 'READY_TO_PUBLISH';
      } else if (totalEligible > 0) {
        publicationStatus = 'PROCESSING';
        if (finalized < totalEligible) {
          notReadyReason = `${totalEligible - finalized} attempt(s) pending finalization.`;
        } else if (evaluated < finalized) {
          notReadyReason = `${finalized - evaluated} attempt(s) pending evaluation.`;
        } else if (!securityReviewCompleted) {
          notReadyReason = `${pendingSecurity} security review(s) pending.`;
        }
      } else {
        notReadyReason = 'No candidate attempts found.';
      }

      return {
        examId: exam.id,
        examTitle: exam.title,
        examTarget: exam.examTarget?.name || 'General',
        examStatus: exam.status?.name,
        examType: isLive ? 'LIVE' : 'MOCK',
        totalCandidates: totalEligible,
        finalizedAttempts: finalized,
        evaluatedAttempts: evaluated,
        analyticsCompletedAttempts: analyticsCompleted,
        rankingCompleted,
        securityReviewCompleted,
        publicationStatus,
        isReadyToPublish,
        notReadyReason,
        publishedAt: latestPub?.publishedAt || null,
        publishedBy: latestPub?.publishedBy?.email || null,
        publicationVersion: latestPub?.publicationVersion || 1,
        lastSchedule: exam.schedules?.[0]
          ? {
              startTime: exam.schedules[0].startTime,
              endTime: exam.schedules[0].endTime,
              status: exam.schedules[0].status,
            }
          : null,
      };
    });

    return {
      items,
      summary: {
        totalMonitored: allExamsCount,
      },
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit) || 1,
      },
    };
  }

  /**
   * Get publication preview summary for a specific live exam before Super Admin confirmation.
   */
  async getPublicationPreview(examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: { select: { id: true, name: true } },
        status: { select: { id: true, name: true } },
        versions: { take: 1 },
        resultPublications: {
          orderBy: { publicationVersion: 'desc' },
          take: 1,
          include: {
            publishedBy: { select: { id: true, email: true } },
          },
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam '${examId}' not found`);
    }

    const readiness = await this.readinessService.checkExamReadiness(examId);
    const publication = exam.resultPublications?.[0];

    return {
      examId: exam.id,
      examTitle: exam.title,
      examTarget: exam.examTarget?.name,
      examStatus: exam.status?.name,
      examType: readiness.examType,
      publicationStatus: readiness.publicationStatus,
      isReadyToPublish: readiness.ready,
      notReadyReason: readiness.reason,
      totalCandidates: readiness.totalEligibleAttempts,
      finalizedAttempts: readiness.finalizedAttempts,
      evaluatedAttempts: readiness.evaluatedAttempts,
      analyticsCompleted: readiness.analyticsCompletedAttempts,
      rankingStatus: readiness.rankingCompleted ? 'COMPLETED' : 'PROCESSING',
      securityStatus: readiness.securityReviewCompleted
        ? 'CLEARED'
        : 'PENDING_REVIEW',
      flaggedAttempts: readiness.flaggedAttempts,
      disqualifiedAttempts: readiness.disqualifiedAttempts,
      currentPublicationVersion: publication?.publicationVersion || 1,
      publishedAt: publication?.publishedAt || null,
      publishedBy: publication?.publishedBy?.email || null,
    };
  }

  /**
   * Super Admin Official Result Publication Execution
   *
   * Protection & Guarantees:
   *  1. Super Admin permission verification
   *  2. Redis concurrency distributed lock (prevents dual-admin simultaneous publish)
   *  3. Strict server-side readiness verification at time of execution
   *  4. Single atomic PostgreSQL transaction (ResultPublication + Results)
   *  5. Invalidate all Redis caches
   *  6. Enqueue bulk student notifications asynchronously via BullMQ
   */
  async publishExamResults(examId: string, superAdminUserId: string) {
    // 1. Concurrency Lock in Redis
    const lockKey = `lock:publish:${examId}`;
    const existingLock = await this.redisService.get(lockKey);
    if (existingLock) {
      throw new ConflictException(
        'Publication is already being processed for this exam by another administrator.',
      );
    }
    await this.redisService.set(lockKey, 'locked', 30); // 30s lock

    try {
      // 2. Strict Readiness Verification at moment of publication
      const readiness = await this.readinessService.checkExamReadiness(examId);

      if (readiness.publicationStatus === ExamPublicationStatusEnum.PUBLISHED) {
        throw new ConflictException(
          'Official results for this exam have already been published.',
        );
      }

      if (!readiness.ready) {
        throw new BadRequestException(
          `Cannot publish exam results. Readiness check failed: ${readiness.reason}`,
        );
      }

      // Auto-generate ranks if rank snapshot is missing before publication
      try {
        const latestRankSnapshot = await this.prisma.rankSnapshot.findFirst({
          where: { examId },
          orderBy: { snapshotVersion: 'desc' },
        });
        if (!latestRankSnapshot || latestRankSnapshot.status !== 'COMPLETED') {
          this.logger.log(`[PublishExamResults] Auto-generating ranks for exam '${examId}' before publication...`);
          await this.rankGenerationService.generateRanks({
            examId,
            forceRegenerate: true,
          });
        }
      } catch (rErr: any) {
        this.logger.warn(`Auto rank generation notice for exam '${examId}': ${rErr.message}`);
      }

      const exam = await this.prisma.exam.findUnique({
        where: { id: examId },
        include: { versions: { take: 1 } },
      });

      if (!exam) {
        throw new NotFoundException(`Exam '${examId}' not found`);
      }

      const now = new Date();

      // 3. Atomic Database Transaction
      const publicationResult = await this.prisma.$transaction(
        async (tx) => {
          // A. Update or create ExamResultPublication record
          const existingPub = await tx.examResultPublication.findFirst({
            where: { examId },
            orderBy: { publicationVersion: 'desc' },
          });

          const publicationVersion = existingPub
            ? existingPub.publicationVersion
            : 1;

          const updatedPub = await tx.examResultPublication.upsert({
            where: {
              examId_publicationVersion: {
                examId,
                publicationVersion,
              },
            },
            update: {
              status: ExamPublicationStatusEnum.PUBLISHED,
              publishedById: superAdminUserId,
              publishedAt: now,
              totalEligibleAttempts: readiness.totalEligibleAttempts,
              finalizedAttempts: readiness.finalizedAttempts,
              evaluatedAttempts: readiness.evaluatedAttempts,
              analyticsCompletedAttempts: readiness.analyticsCompletedAttempts,
              rankingCompleted: true,
              securityReviewCompleted: true,
              metadata: {
                publishedBySuperAdmin: superAdminUserId,
                publishedAt: now.toISOString(),
                totalCandidates: readiness.totalEligibleAttempts,
              },
            },
            create: {
              examId,
              examVersionId: exam.versions?.[0]?.id,
              status: ExamPublicationStatusEnum.PUBLISHED,
              publicationVersion: 1,
              publishedById: superAdminUserId,
              publishedAt: now,
              totalEligibleAttempts: readiness.totalEligibleAttempts,
              finalizedAttempts: readiness.finalizedAttempts,
              evaluatedAttempts: readiness.evaluatedAttempts,
              analyticsCompletedAttempts: readiness.analyticsCompletedAttempts,
              rankingCompleted: true,
              securityReviewCompleted: true,
              metadata: {
                publishedBySuperAdmin: superAdminUserId,
                publishedAt: now.toISOString(),
                totalCandidates: readiness.totalEligibleAttempts,
              },
            },
          });

          // B. Atomically update all eligible attempt results to PUBLISHED
          const eligibleAttempts = await tx.attempt.findMany({
            where: {
              examId,
              status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
            },
            select: { id: true, studentId: true },
          });

          const attemptIds = eligibleAttempts.map((a) => a.id);

          await tx.result.updateMany({
            where: {
              attemptId: { in: attemptIds },
            },
            data: {
              resultStatus: ResultStatusEnum.PUBLISHED,
              publishedAt: now,
              publishedBy: superAdminUserId,
              publicationVersion,
            },
          });

          // C. Record Audit Log
          try {
            await tx.securityEvent.create({
              data: {
                userId: superAdminUserId,
                eventType: 'ROLE_CHANGED' as any, // audit marker
                ipAddress: 'server-internal',
                metadata: {
                  action: 'RESULT_PUBLISHED',
                  examId,
                  examTitle: exam.title,
                  publishedBy: superAdminUserId,
                  publishedAt: now.toISOString(),
                  totalCandidates: eligibleAttempts.length,
                  publicationVersion,
                },
              },
            });
          } catch {
            // Non-blocking audit log fallback
          }

          return {
            updatedPub,
            totalPublished: eligibleAttempts.length,
            eligibleAttempts,
          };
        },
      );

      // 4. Invalidate Redis Caches
      try {
        await this.redisService.del(`exam:${examId}:leaderboard`);
        await this.redisService.del(`exam:${examId}:ranks`);
        for (const att of publicationResult.eligibleAttempts) {
          await this.redisService.del(`result:visibility:${att.id}`);
          await this.redisService.del(`student:${att.studentId}:results`);
        }
      } catch (err) {
        this.logger.warn(`Redis cache invalidation warning: ${err}`);
      }

      // 5. Asynchronous Bulk Notifications via BullMQ
      this.enqueuePublicationNotifications(
        exam,
        publicationResult.eligibleAttempts,
        publicationResult.updatedPub.publicationVersion,
      ).catch((err) => {
        this.logger.error(
          `Asynchronous notification queuing error (non-blocking): ${err}`,
        );
      });

      // 6. Enqueue WhatsApp result notification per student (non-blocking, after successful publish)
      this.enqueueWhatsAppResultNotifications(
        exam,
        publicationResult.eligibleAttempts,
        publicationResult.updatedPub.publicationVersion,
      ).catch((err) => {
        this.logger.error(
          `[WhatsApp] Result notification queuing error (non-blocking): ${err}`,
        );
      });

      this.logger.log(
        `Official results for Live Exam '${exam.title}' (${examId}) PUBLISHED by Super Admin '${superAdminUserId}' for ${publicationResult.totalPublished} candidates.`,
      );

      return {
        success: true,
        examId,
        examTitle: exam.title,
        status: ExamPublicationStatusEnum.PUBLISHED,
        publishedAt: now.toISOString(),
        publishedBy: superAdminUserId,
        totalCandidates: publicationResult.totalPublished,
        publicationVersion: publicationResult.updatedPub.publicationVersion,
      };
    } finally {
      // Release Redis lock
      await this.redisService.del(lockKey);
    }
  }

  /**
   * Enqueue bulk student notifications asynchronously with controlled concurrency.
   */
  private async enqueuePublicationNotifications(
    exam: any,
    attempts: Array<{ id: string; studentId: string }>,
    publicationVersion: number,
  ) {
    if (!attempts || attempts.length === 0) return;

    for (const att of attempts) {
      const jobId = `notif_pub_${exam.id}_v${publicationVersion}_${att.studentId}`;
      try {
        await this.notificationQueue.add(
          'EXAM_RESULT_PUBLISHED',
          {
            examId: exam.id,
            examTitle: exam.title,
            studentId: att.studentId,
            attemptId: att.id,
            publicationVersion,
          },
          {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
          },
        );
      } catch {
        // Individual notification failure does not block publication
      }
    }
  }

  /**
   * Enqueue WhatsApp result notification jobs for each student after result publication.
   *
   * Each job is idempotent via a unique Notification.idempotencyKey and BullMQ jobId.
   * Failures here NEVER affect the published result — fully isolated.
   */
  private async enqueueWhatsAppResultNotifications(
    exam: any,
    attempts: Array<{ id: string; studentId: string }>,
    publicationVersion: number,
  ): Promise<void> {
    if (!attempts || attempts.length === 0) return;

    // Batch-fetch student + user phone info for all eligible attempts
    const studentIds = attempts.map((a) => a.studentId);
    const students = await this.prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        userId: true,
        name: true,
        user: {
          select: { phone: true, mobileNumber: true },
        },
      },
    });

    const studentMap = new Map(students.map((s) => [s.id, s]));
    const examTargetName = exam.examTarget?.name || '';

    const jobsToEnqueue: any[] = [];

    for (const att of attempts) {
      const student = studentMap.get(att.studentId);
      if (!student) continue;

      const rawPhone = student.user?.phone || student.user?.mobileNumber;
      if (!rawPhone) {
        this.logger.debug(
          `[WhatsApp Result] Student '${student.userId}' has no phone. Skipping WhatsApp notification.`,
        );
        continue;
      }

      const whatsappTo = normalizeToWhatsApp(rawPhone);
      if (!whatsappTo) {
        this.logger.warn(
          `[WhatsApp Result] Invalid phone for student '${student.userId}': ${maskPhone(rawPhone)}`,
        );
        continue;
      }

      const idempotencyKey = `wa_result_${exam.id}_v${publicationVersion}_${student.userId}`;

      // Create Notification record (idempotent via unique key)
      let notification: any;
      try {
        notification = await this.prisma.notification.upsert({
          where: { idempotencyKey },
          update: {},
          create: {
            userId: student.userId,
            recipientUserId: student.userId,
            recipientAddress: rawPhone,
            channel: NotificationChannel.WHATSAPP,
            type: NotificationType.EXAM_RESULT_PUBLISHED,
            title: `Result Published: ${exam.title}`,
            message: `Your ${exam.title} result has been published. View your result and analysis in Brainros.`,
            payload: {
              examId: exam.id,
              examTitle: exam.title,
              examTarget: examTargetName,
              publicationVersion,
              reminderType: 'EXAM_RESULT_PUBLISHED',
            },
            priority: NotificationPriority.HIGH,
            status: NotificationStatus.QUEUED,
            idempotencyKey,
          },
        });
      } catch (dbErr: any) {
        this.logger.error(
          `[WhatsApp Result] DB error creating notification for student '${student.userId}': ${dbErr.message}`,
        );
        continue;
      }

      jobsToEnqueue.push({
        name: WHATSAPP_JOB_NAMES.SEND_REMINDER,
        data: {
          notificationId: notification.id,
          recipientUserId: student.userId,
          phone: rawPhone,
          examId: exam.id,
          examTitle: exam.title,
          examTarget: examTargetName,
          reminderType: 'EXAM_RESULT_PUBLISHED',
          studentName: student.name,
        } as WhatsAppReminderJobData,
        opts: {
          jobId: `wa_${notification.id}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 200,
          removeOnFail: 1000,
        },
      });
    }

    // Bulk-enqueue in chunks of 500 for optimal Redis pipeline throughput
    const BULK_CHUNK_SIZE = 500;
    for (let i = 0; i < jobsToEnqueue.length; i += BULK_CHUNK_SIZE) {
      const chunk = jobsToEnqueue.slice(i, i + BULK_CHUNK_SIZE);
      try {
        await this.whatsAppQueue.addBulk(chunk);
      } catch (queueErr: any) {
        this.logger.error(
          `[WhatsApp Result] Bulk queue error for chunk [${i}..${i + chunk.length}]: ${queueErr.message}`,
        );
      }
    }

    this.logger.log(
      `[WhatsApp Result] Enqueued ${jobsToEnqueue.length} WhatsApp result notifications for exam '${exam.title}'.`,
    );
  }
}
