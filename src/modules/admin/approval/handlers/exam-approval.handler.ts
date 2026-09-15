import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { IApprovalHandler } from '../interfaces/approval-handler.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationQueueService } from '../../../notification/queues/notification-queue.service';
import { ExamScheduleService } from '../../../exam-scheduling/services/exam-schedule.service';
import { ExamLifecycleService } from '../../../exam-scheduling/services/exam-lifecycle.service';

@Injectable()
export class ExamApprovalHandler implements IApprovalHandler {
  readonly entityType = 'EXAM';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ExamScheduleService))
    private readonly scheduleService: ExamScheduleService,
    @Inject(forwardRef(() => ExamLifecycleService))
    private readonly lifecycleService: ExamLifecycleService,
    @Optional()
    private readonly notificationQueue?: NotificationQueueService,
  ) {}

  async validateEntity(entityId: string, tx?: any): Promise<any> {
    const db = tx || this.prisma;
    const exam = await db.exam.findUnique({
      where: { id: entityId },
      include: { status: true },
    });

    if (!exam) {
      throw new NotFoundException(`Exam '${entityId}' not found.`);
    }

    // Allow SCHEDULED and SUBMITTED exams to be approved/activated by Super Admin!
    if (['APPROVED', 'ACTIVE', 'COMPLETED'].includes(exam.status.name)) {
      throw new BadRequestException(
        `Exam '${entityId}' is already in status '${exam.status.name}'.`,
      );
    }

    return exam;
  }

  async onApprove(
    request: any,
    reviewerId: string,
    comment?: string,
    tx?: any,
  ): Promise<{
    beforeState: Record<string, any>;
    afterState: Record<string, any>;
  }> {
    const db = tx || this.prisma;
    const exam = await db.exam.findUnique({
      where: { id: request.resourceId },
      include: {
        status: true,
        sections: { select: { subjectId: true } },
        schedules: {
          where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam '${request.resourceId}' not found.`);
    }

    const beforeState = { status: exam.status.name, title: exam.title };
    const activeSchedule = exam.schedules?.[0];

    // ── 1. SCHEDULED EXAMS WORKFLOW: APPROVAL -> ACTIVATE EXAM & SCHEDULE ──
    // When Super Admin approves an exam in SCHEDULED state (or with a schedule), it activates the exam & schedule
    if (exam.status.name === 'SCHEDULED' || activeSchedule) {
      await this.lifecycleService.activateExam(exam.id, reviewerId, tx);

      const updated = await db.exam.findUnique({
        where: { id: exam.id },
        include: { status: true },
      });

      const afterState = {
        status: updated?.status?.name || 'ACTIVE',
        approvedById: reviewerId,
        activatedAt: new Date(),
        title: exam.title,
        message: 'Exam and schedule successfully approved and activated by Super Admin.',
      };

      return { beforeState, afterState };
    }

    // ── 2. Check if entity is a Mock Test vs Live Exam (Unscheduled) ──
    const isMock =
      request.resourceType === 'MOCK_TEST' ||
      request.resourceType === 'MOCK' ||
      exam.title.toUpperCase().includes('MOCK') ||
      exam.title.toUpperCase().includes('PRACTICE') ||
      (exam.sections && exam.sections.length === 1);

    if (isMock) {
      // ── MOCK TEST WORKFLOW: APPROVAL -> ACTIVE (Available directly) ──
      let activeStatus = await db.examStatus.findUnique({
        where: { name: 'ACTIVE' },
      });
      if (!activeStatus) {
        activeStatus = await db.examStatus.create({
          data: { name: 'ACTIVE' },
        });
      }

      const updated = await db.exam.update({
        where: { id: exam.id },
        data: {
          statusId: activeStatus.id,
          approvedById: reviewerId,
          approvedAt: new Date(),
          activatedAt: new Date(),
        },
        include: { status: true },
      });

      await db.examLifecycleHistory.create({
        data: {
          examId: exam.id,
          action: 'APPROVE',
          fromStatus: exam.status.name,
          toStatus: 'ACTIVE',
          performedById: reviewerId,
          comment: comment || 'Mock test approved by Super Admin and made available to students.',
        },
      });

      // Dispatch async notification to eligible students
      if (this.notificationQueue) {
        try {
          this.notificationQueue.dispatchExamNotificationJob({
            type: 'MOCK_AVAILABLE' as any,
            examId: exam.id,
          });
        } catch {
          // Non-blocking notification dispatch
        }
      }

      const afterState = {
        status: 'ACTIVE',
        approvedById: reviewerId,
        approvedAt: updated.approvedAt,
        isMock: true,
        isAvailableToStudents: true,
      };
      return { beforeState, afterState };
    } else {
      // ── LIVE EXAM WORKFLOW: APPROVAL -> APPROVED (Awaiting Scheduling by Super Admin) ──
      let approvedStatus = await db.examStatus.findUnique({
        where: { name: 'APPROVED' },
      });
      if (!approvedStatus) {
        approvedStatus = await db.examStatus.create({
          data: { name: 'APPROVED' },
        });
      }

      const updated = await db.exam.update({
        where: { id: exam.id },
        data: {
          statusId: approvedStatus.id,
          approvedById: reviewerId,
          approvedAt: new Date(),
        },
        include: { status: true },
      });

      await db.examLifecycleHistory.create({
        data: {
          examId: exam.id,
          action: 'APPROVE',
          fromStatus: exam.status.name,
          toStatus: 'APPROVED',
          performedById: reviewerId,
          comment: comment || 'Live exam approved by Super Admin. Awaiting scheduling.',
        },
      });

      const afterState = {
        status: 'APPROVED',
        approvedById: reviewerId,
        approvedAt: updated.approvedAt,
        isMock: false,
        isAwaitingScheduling: true,
        isAvailableToStudents: false,
      };
      return { beforeState, afterState };
    }
  }

  async onReject(
    request: any,
    reviewerId: string,
    reason: string,
    tx?: any,
  ): Promise<{
    beforeState: Record<string, any>;
    afterState: Record<string, any>;
  }> {
    const db = tx || this.prisma;
    const exam = await db.exam.findUnique({
      where: { id: request.resourceId },
      include: {
        status: true,
        schedules: {
          where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam '${request.resourceId}' not found.`);
    }

    const beforeState = { status: exam.status.name, title: exam.title };

    let rejectedStatus = await db.examStatus.findUnique({
      where: { name: 'REJECTED' },
    });
    if (!rejectedStatus) {
      rejectedStatus = await db.examStatus.create({
        data: { name: 'REJECTED' },
      });
    }

    const updated = await db.exam.update({
      where: { id: exam.id },
      data: { statusId: rejectedStatus.id },
      include: { status: true },
    });

    // Cancel any schedules
    if (exam.schedules && exam.schedules.length > 0) {
      await db.examSchedule.updateMany({
        where: { examId: exam.id, status: 'SCHEDULED' },
        data: {
          status: 'CANCELLED',
          cancelledById: reviewerId,
          cancelledAt: new Date(),
        },
      });
    }

    await db.examLifecycleHistory.create({
      data: {
        examId: exam.id,
        action: 'CANCEL',
        fromStatus: exam.status.name,
        toStatus: 'REJECTED',
        performedById: reviewerId,
        comment: reason,
      },
    });

    const afterState = { status: updated.status.name, reason };
    return { beforeState, afterState };
  }

  async onCancel(
    request: any,
    actorId: string,
    tx?: any,
  ): Promise<{
    beforeState: Record<string, any>;
    afterState: Record<string, any>;
  }> {
    const db = tx || this.prisma;
    const exam = await db.exam.findUnique({
      where: { id: request.resourceId },
      include: { status: true },
    });
    if (!exam)
      throw new NotFoundException(`Exam '${request.resourceId}' not found.`);

    let draftStatus = await db.examStatus.findUnique({
      where: { name: 'DRAFT' },
    });
    if (!draftStatus) {
      draftStatus = await db.examStatus.create({ data: { name: 'DRAFT' } });
    }

    const updated = await db.exam.update({
      where: { id: exam.id },
      data: { statusId: draftStatus.id },
      include: { status: true },
    });

    return {
      beforeState: { status: exam.status.name },
      afterState: { status: updated.status.name },
    };
  }
}
