import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExamLifecycleAction } from '@prisma/client';
import { NotificationQueueService } from '../../notification/queues/notification-queue.service';
import { ExamCacheService } from '../../exam-cache/services/exam-cache.service';

export const VALID_LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  REJECTED: ['SUBMITTED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['ACTIVE', 'CANCELLED', 'SCHEDULED'], // reschedule stays SCHEDULED
  ACTIVE: ['ENDED', 'CANCELLED'],
  ENDED: ['EVALUATING'],
  EVALUATING: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

@Injectable()
export class ExamLifecycleService {
  private readonly logger = new Logger(ExamLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationQueue: NotificationQueueService,
    private readonly examCacheService: ExamCacheService,
  ) {}

  /**
   * Asserts whether a transition between two statuses is valid
   */
  validateTransition(fromStatus: string, toStatus: string): void {
    const allowed = VALID_LIFECYCLE_TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw new BadRequestException(
        `Invalid exam status transition from '${fromStatus}' to '${toStatus}'. Allowed transitions: [${allowed.join(
          ', ',
        )}]`,
      );
    }
  }

  /**
   * Helper to ensure ExamStatus record exists in DB
   */
  async getOrCreateExamStatus(statusName: string, tx?: any) {
    const db = tx || this.prisma;
    let status = await db.examStatus.findUnique({
      where: { name: statusName },
    });

    if (!status) {
      status = await db.examStatus.create({
        data: { name: statusName },
      });
    }
    return status;
  }

  /**
   * Record lifecycle audit trail
   */
  async recordHistory(
    params: {
      examId: string;
      examVersionId?: string | null;
      scheduleId?: string | null;
      action: ExamLifecycleAction;
      fromStatus: string;
      toStatus: string;
      performedById: string;
      comment?: string | null;
      metadata?: any;
    },
    tx?: any,
  ) {
    const db = tx || this.prisma;
    return db.examLifecycleHistory.create({
      data: {
        examId: params.examId,
        examVersionId: params.examVersionId || null,
        scheduleId: params.scheduleId || null,
        action: params.action,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        performedById: params.performedById,
        comment: params.comment || null,
        metadata: params.metadata || null,
      },
    });
  }

  /**
   * Admin submits Exam: DRAFT -> SUBMITTED
   */
  async submitExam(examId: string, performedById: string, comment?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        versions: true,
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    this.validateTransition(exam.status.name, 'SUBMITTED');

    // Preconditions: Must have at least 1 generated ExamVersion
    if (!exam.versions || exam.versions.length === 0) {
      throw new BadRequestException(
        'Cannot submit an exam without at least one generated ExamVersion. Please generate an exam version first.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const submittedStatus = await this.getOrCreateExamStatus('SUBMITTED', tx);

      const updated = await tx.exam.update({
        where: { id: examId },
        data: { statusId: submittedStatus.id },
        include: { status: true },
      });

      await this.recordHistory(
        {
          examId,
          examVersionId: exam.versions[0]?.id || null,
          action: 'SUBMIT',
          fromStatus: exam.status.name,
          toStatus: 'SUBMITTED',
          performedById,
          comment,
        },
        tx,
      );

      const isMock =
        exam.title.toUpperCase().includes('MOCK') ||
        exam.title.toUpperCase().includes('PRACTICE');

      await tx.approvalRequest.create({
        data: {
          resourceType: isMock ? 'MOCK_TEST' : 'EXAM',
          resourceId: examId,
          requestedById: performedById,
          status: 'PENDING',
          metadata: {
            examId,
            title: exam.title,
            totalQuestions: exam.totalQuestions,
            durationMinutes: exam.durationMinutes,
            isMock,
          },
          submittedAt: new Date(),
        },
      });

      this.logger.log(`Exam '${examId}' submitted by user '${performedById}'`);
      return updated;
    }, { maxWait: 10000, timeout: 30000 });
  }

  /**
   * Super Admin approves Exam: SUBMITTED -> APPROVED
   */
  async approveExam(examId: string, performedById: string, comment?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        versions: true,
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    if (exam.createdById && exam.createdById === performedById) {
      throw new ForbiddenException(
        'Self-approval is forbidden. An exam must be reviewed and approved by another administrator.',
      );
    }

    this.validateTransition(exam.status.name, 'APPROVED');

    return this.prisma.$transaction(async (tx) => {
      const approvedStatus = await this.getOrCreateExamStatus('APPROVED', tx);

      const updated = await tx.exam.update({
        where: { id: examId },
        data: {
          statusId: approvedStatus.id,
          approvedById: performedById,
          approvedAt: new Date(),
        },
        include: { status: true },
      });

      await this.recordHistory(
        {
          examId,
          examVersionId: exam.versions[0]?.id || null,
          action: 'APPROVE',
          fromStatus: exam.status.name,
          toStatus: 'APPROVED',
          performedById,
          comment,
        },
        tx,
      );

      this.logger.log(
        `Exam '${examId}' approved by Super Admin '${performedById}'`,
      );
      return updated;
    }, { maxWait: 10000, timeout: 30000 });
  }

  /**
   * Super Admin rejects Exam: SUBMITTED -> REJECTED
   */
  async rejectExam(examId: string, performedById: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('A valid rejection reason is mandatory.');
    }

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        versions: true,
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    this.validateTransition(exam.status.name, 'REJECTED');

    return this.prisma.$transaction(async (tx) => {
      const rejectedStatus = await this.getOrCreateExamStatus('REJECTED', tx);

      const updated = await tx.exam.update({
        where: { id: examId },
        data: {
          statusId: rejectedStatus.id,
        },
        include: { status: true },
      });

      await this.recordHistory(
        {
          examId,
          examVersionId: exam.versions[0]?.id || null,
          action: 'REJECT' as any,
          fromStatus: exam.status.name,
          toStatus: 'REJECTED',
          performedById,
          comment: reason.trim(),
        },
        tx,
      );

      this.logger.log(
        `Exam '${examId}' rejected by Super Admin '${performedById}': ${reason}`,
      );
      return updated;
    }, { maxWait: 10000, timeout: 30000 });
  }

  /**
   * Cancel Exam: from valid pre-live states -> CANCELLED
   */
  async cancelExam(examId: string, performedById: string, reason?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        schedules: { where: { status: { in: ['SCHEDULED', 'ACTIVE'] } } },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    this.validateTransition(exam.status.name, 'CANCELLED');

    const updated = await this.prisma.$transaction(async (tx) => {
      const cancelledStatus = await this.getOrCreateExamStatus('CANCELLED', tx);

      const updatedExam = await tx.exam.update({
        where: { id: examId },
        data: { statusId: cancelledStatus.id },
        include: { status: true },
      });

      // Mark any active/scheduled schedules as CANCELLED
      if (exam.schedules && exam.schedules.length > 0) {
        for (const sch of exam.schedules) {
          await tx.examSchedule.update({
            where: { id: sch.id },
            data: {
              status: 'CANCELLED',
              cancelledById: performedById,
              cancelledAt: new Date(),
            },
          });
        }
      }

      // Mark calendar entries as CANCELLED
      await tx.examCalendar.updateMany({
        where: { examId },
        data: { status: 'CANCELLED' },
      });

      await this.recordHistory(
        {
          examId,
          action: 'CANCEL',
          fromStatus: exam.status.name,
          toStatus: 'CANCELLED',
          performedById,
          comment: reason,
        },
        tx,
      );

      this.logger.log(`Exam '${examId}' cancelled by user '${performedById}'`);
      return updatedExam;
    }, { maxWait: 10000, timeout: 30000 });

    // Invalidate Redis question cache for cancelled exam
    await this.examCacheService.invalidateExamCache(examId).catch((cErr: any) => {
      this.logger.warn(`ExamCache invalidation on cancel error: ${cErr.message}`);
    });

    // 1. Direct in-app notification creation for all active students
    try {
      const students = await this.prisma.student.findMany({
        where: { status: 'ACTIVE' },
        select: { userId: true, name: true },
      });

      if (students.length > 0) {
        const records = students.map((s) => ({
          userId: s.userId,
          recipientUserId: s.userId,
          channel: 'IN_APP' as any,
          type: 'EXAM_CANCELLED' as any,
          title: `Exam Cancelled: ${exam.title}`,
          message: `The scheduled examination "${exam.title}" has been cancelled by administration.${reason ? ' Reason: ' + reason : ''}`,
          data: {
            entityType: 'EXAM',
            entityId: exam.id,
            action: 'VIEW',
            examTitle: exam.title,
            reason: reason || null,
          },
          payload: {
            examTitle: exam.title,
            reason: reason || null,
          },
          priority: 'HIGH' as any,
          status: 'DELIVERED' as any,
          isRead: false,
          idempotencyKey: `cancel_${exam.id}_${s.userId}_${Date.now()}`,
        }));

        await this.prisma.notification.createMany({
          data: records,
          skipDuplicates: true,
        });
      }
    } catch (err: any) {
      this.logger.warn(`Direct cancel notification creation error: ${err.message}`);
    }

    // 2. Dispatch BullMQ background notification job
    this.notificationQueue.dispatchExamNotificationJob({
      type: 'EXAM_CANCELLED',
      examId,
      message: reason ? `Exam ${exam.title} cancelled: ${reason}` : undefined,
    });

    return updated;
  }

  /**
   * Super Admin activates Exam: SCHEDULED -> ACTIVE
   */
  async activateExam(examId: string, performedById: string, tx?: any) {
    const db = tx || this.prisma;
    const exam = await db.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        schedules: {
          where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!exam) throw new NotFoundException(`Exam '${examId}' not found`);

    // Verify valid lifecycle transition (prevents activating DRAFT, REJECTED, or already ACTIVE exams)
    this.validateTransition(exam.status.name, 'ACTIVE');

    // Verify active/scheduled window exists and has not already expired
    const activeSchedule = exam.schedules?.[0];
    if (!activeSchedule) {
      throw new BadRequestException(
        'Cannot activate an exam without an active or scheduled time slot.',
      );
    }

    const now = new Date();
    if (now >= new Date(activeSchedule.endTime)) {
      throw new BadRequestException(
        'Cannot activate an exam whose scheduled end time has already passed.',
      );
    }

    // ── Cache verification gate before activation ──
    const isCacheReady = await this.examCacheService.isExamCacheReady(
      examId,
      activeSchedule.examVersionId,
    );

    if (!isCacheReady) {
      this.logger.log(
        `[ExamLifecycle] Cache not ready for exam '${examId}', preparing and verifying before activation...`,
      );
      try {
        await this.examCacheService.prepareExamCache({
          examId,
          examVersionId: activeSchedule.examVersionId,
          scheduleId: activeSchedule.id,
          officialEndTime: activeSchedule.endTime,
          userId: performedById,
        });
      } catch (cacheErr: any) {
        this.logger.error(
          `[ExamLifecycle] Cannot activate exam '${examId}': Cache preparation/verification failed: ${cacheErr.message}`,
        );
        throw new BadRequestException(
          `Cannot activate exam: Exam question cache preparation or verification failed (${cacheErr.message}).`,
        );
      }
    }

    const activeStatus = await this.getOrCreateExamStatus('ACTIVE', db);

    const updated = await db.exam.update({
      where: { id: examId },
      data: {
        statusId: activeStatus.id,
        activatedAt: now,
      },
      include: { status: true },
    });

    if (activeSchedule.status !== 'ACTIVE') {
      await db.examSchedule.update({
        where: { id: activeSchedule.id },
        data: { status: 'ACTIVE' },
      });
    }

    // Mark any pending approval request as APPROVED
    await db.approvalRequest.updateMany({
      where: {
        resourceType: { in: ['EXAM', 'MOCK_TEST', 'MOCK'] },
        resourceId: examId,
        status: 'PENDING',
      },
      data: {
        status: 'APPROVED',
        reviewedById: performedById,
        reviewedAt: now,
      },
    });

    await this.recordHistory(
      {
        examId,
        action: 'ACTIVATE',
        fromStatus: exam.status.name,
        toStatus: 'ACTIVE',
        performedById,
        comment: 'Super Admin activated exam for live testing',
      },
      db,
    );

    this.logger.log(`Exam '${examId}' activated after cache verification.`);

    return updated;
  }

  /**
   * Transition Exam to ENDED: ACTIVE -> ENDED
   */
  async endExam(examId: string, performedById?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        schedules: { where: { status: 'ACTIVE' } },
      },
    });

    if (!exam || exam.status.name !== 'ACTIVE') return exam;

    return this.prisma.$transaction(async (tx) => {
      const endedStatus = await this.getOrCreateExamStatus('ENDED', tx);

      const updated = await tx.exam.update({
        where: { id: examId },
        data: { statusId: endedStatus.id },
        include: { status: true },
      });

      if (exam.schedules.length > 0) {
        await tx.examSchedule.updateMany({
          where: { examId, status: 'ACTIVE' },
          data: { status: 'ENDED' },
        });
      }

      await this.recordHistory(
        {
          examId,
          action: 'END',
          fromStatus: 'ACTIVE',
          toStatus: 'ENDED',
          performedById: performedById || exam.createdById,
          comment: 'Exam live window concluded.',
        },
        tx,
      );

      this.logger.log(`Exam '${examId}' transitioned to ENDED.`);
      return updated;
    }, { maxWait: 10000, timeout: 30000 });
  }

  /**
   * Get lifecycle audit history for an exam
   */
  async getExamLifecycleHistory(examId: string) {
    return this.prisma.examLifecycleHistory.findMany({
      where: { examId },
      orderBy: { createdAt: 'asc' },
      include: {
        performedBy: { select: { id: true, email: true } },
        examVersion: { select: { id: true, versionNumber: true } },
        schedule: true,
      },
    });
  }
}
