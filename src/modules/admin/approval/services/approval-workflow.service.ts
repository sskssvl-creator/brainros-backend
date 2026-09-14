import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { ApprovalHandlerRegistry } from '../handlers/approval-handler.registry';
import {
  SubmitApprovalDto,
  ApproveRequestDto,
  RejectRequestDto,
  CancelRequestDto,
  ApprovalFilterDto,
} from '../../dto/admin.dto';

@Injectable()
export class ApprovalWorkflowService implements OnModuleInit {
  private readonly logger = new Logger(ApprovalWorkflowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ApprovalHandlerRegistry,
    private readonly auditService: AuditLogService,
  ) {}

  async onModuleInit() {
    await this.syncPendingExamsToApprovalQueue();
  }

  /**
   * Automatically ensure any scheduled or submitted exams have a corresponding pending ApprovalRequest
   */
  async syncPendingExamsToApprovalQueue() {
    try {
      const pendingExams = await this.prisma.exam.findMany({
        where: {
          status: { name: { in: ['SCHEDULED', 'SUBMITTED'] } },
        },
        include: {
          status: true,
          schedules: {
            where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          createdBy: { select: { id: true, name: true } },
        },
      });

      if (!pendingExams || pendingExams.length === 0) return;

      const existingReqs = await this.prisma.approvalRequest.findMany({
        where: {
          resourceType: { in: ['EXAM', 'MOCK_TEST', 'MOCK'] },
          resourceId: { in: pendingExams.map((e) => e.id) },
        },
      });

      const existingReqByExamId = new Map<string, any>();
      for (const req of existingReqs) {
        existingReqByExamId.set(req.resourceId, req);
      }

      for (const exam of pendingExams) {
        if (!existingReqByExamId.has(exam.id)) {
          const activeSchedule = exam.schedules?.[0];
          const isMock =
            exam.title.toUpperCase().includes('MOCK') ||
            exam.title.toUpperCase().includes('PRACTICE');

          await this.prisma.approvalRequest.create({
            data: {
              resourceType: isMock ? 'MOCK_TEST' : 'EXAM',
              resourceId: exam.id,
              requestedById:
                exam.createdById ||
                exam.createdBy?.id ||
                '0f577461-6f9b-41fe-a796-6587e2571959',
              status: 'PENDING',
              metadata: {
                examId: exam.id,
                title: exam.title,
                scheduleId: activeSchedule?.id,
                startTime: activeSchedule?.startTime
                  ? activeSchedule.startTime.toISOString()
                  : null,
                endTime: activeSchedule?.endTime
                  ? activeSchedule.endTime.toISOString()
                  : null,
                totalQuestions: exam.totalQuestions,
                durationMinutes: exam.durationMinutes,
                isMock,
              },
              submittedAt: exam.createdAt,
            },
          });
          this.logger.log(
            `[ApprovalQueue] Synced pending exam '${exam.title}' (${exam.id}) into Super Admin Approval Queue`,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to sync pending exams to approval queue: ${err.message}`,
      );
    }
  }

  /**
   * Submit an entity for administrative approval review.
   */
  async submit(
    dto: SubmitApprovalDto,
    submittedById: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const handler = this.registry.getHandler(dto.entityType);

    // 1. Verify entity existence and eligibility via domain handler
    await handler.validateEntity(dto.entityId);

    // 2. Prevent duplicate pending requests for the same entity
    const existingPending = await this.prisma.approvalRequest.findFirst({
      where: {
        resourceType: dto.entityType.toUpperCase(),
        resourceId: dto.entityId,
        status: 'PENDING',
      },
    });

    if (existingPending) {
      throw new BadRequestException(
        `There is already an active PENDING approval request for ${dto.entityType} '${dto.entityId}'.`,
      );
    }

    // 3. Create ApprovalRequest record & AuditLog inside a transaction
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.approvalRequest.create({
        data: {
          resourceType: dto.entityType.toUpperCase(),
          resourceId: dto.entityId,
          requestedById: submittedById,
          status: 'PENDING',
          metadata: dto.metadata || {},
          submittedAt: new Date(),
        },
      });

      await this.auditService.logAction({
        actorUserId: submittedById,
        action: 'SUBMIT_APPROVAL',
        entityType: dto.entityType.toUpperCase(),
        entityId: dto.entityId,
        afterState: { approvalRequestId: request.id, status: 'PENDING' },
        metadata: dto.metadata,
        ipAddress,
        userAgent,
        tx,
      });

      return request;
    });
  }

  /**
   * Approve a pending approval request.
   * Enforces self-approval prevention and executes domain-specific state transitions.
   */
  async approve(
    requestId: string,
    reviewerId: string,
    dto: ApproveRequestDto = {},
    ipAddress?: string,
    userAgent?: string,
  ) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Approval request '${requestId}' not found.`);
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot approve request with status '${request.status}'. Only PENDING requests can be approved.`,
      );
    }

    // ── Self-Approval Prevention Rule (Super Admin is root authority) ──
    const reviewer = await this.prisma.user.findUnique({
      where: { id: reviewerId },
      include: { userRoles: { include: { role: true } } },
    });
    const isSuperAdmin = reviewer?.userRoles?.some(
      (ur) => ur.role.name === 'SUPER_ADMIN',
    );

    if (request.requestedById === reviewerId && !isSuperAdmin) {
      this.logger.warn(
        `Self-approval blocked for user '${reviewerId}' on request '${requestId}'`,
      );
      throw new ForbiddenException(
        'Self-approval is forbidden. An administrative action must be reviewed by another authorized administrator.',
      );
    }

    const handler = this.registry.getHandler(request.resourceType);

    return this.prisma.$transaction(async (tx) => {
      // Execute domain-specific transition
      const { beforeState, afterState } = await handler.onApprove(
        request,
        reviewerId,
        dto.comment,
        tx,
      );

      const updatedRequest = await tx.approvalRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          reviewComment: dto.comment || null,
        },
      });

      await this.auditService.logAction({
        actorUserId: reviewerId,
        action: 'APPROVE',
        entityType: request.resourceType,
        entityId: request.resourceId,
        beforeState,
        afterState,
        reason: dto.comment,
        ipAddress,
        userAgent,
        tx,
      });

      return updatedRequest;
    });
  }

  /**
   * Reject a pending approval request (mandatory reason).
   */
  async reject(
    requestId: string,
    reviewerId: string,
    dto: RejectRequestDto,
    ipAddress?: string,
    userAgent?: string,
  ) {
    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException('Rejection reason is required.');
    }

    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Approval request '${requestId}' not found.`);
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot reject request with status '${request.status}'. Only PENDING requests can be rejected.`,
      );
    }

    const handler = this.registry.getHandler(request.resourceType);

    return this.prisma.$transaction(async (tx) => {
      const { beforeState, afterState } = await handler.onReject(
        request,
        reviewerId,
        dto.reason,
        tx,
      );

      const updatedRequest = await tx.approvalRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          rejectionReason: dto.reason,
          reviewComment: dto.comment || null,
        },
      });

      await this.auditService.logAction({
        actorUserId: reviewerId,
        action: 'REJECT',
        entityType: request.resourceType,
        entityId: request.resourceId,
        beforeState,
        afterState,
        reason: dto.reason,
        ipAddress,
        userAgent,
        tx,
      });

      return updatedRequest;
    });
  }

  /**
   * Cancel an open approval request.
   */
  async cancel(
    requestId: string,
    actorId: string,
    dto: CancelRequestDto = {},
    ipAddress?: string,
    userAgent?: string,
  ) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Approval request '${requestId}' not found.`);
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot cancel request with status '${request.status}'.`,
      );
    }

    const handler = this.registry.getHandler(request.resourceType);

    return this.prisma.$transaction(async (tx) => {
      let states = { beforeState: {}, afterState: {} };
      if (handler.onCancel) {
        states = await handler.onCancel(request, actorId, tx);
      }

      const updatedRequest = await tx.approvalRequest.update({
        where: { id: requestId },
        data: {
          status: 'CANCELLED',
          rejectionReason: dto.reason || 'Cancelled by requester',
        },
      });

      await this.auditService.logAction({
        actorUserId: actorId,
        action: 'CANCEL_APPROVAL',
        entityType: request.resourceType,
        entityId: request.resourceId,
        beforeState: states.beforeState,
        afterState: states.afterState,
        reason: dto.reason,
        ipAddress,
        userAgent,
        tx,
      });

      return updatedRequest;
    });
  }

  /**
   * Bulk approve multiple requests with per-item validation and auditing.
   */
  async bulkApprove(
    requestIds: string[],
    reviewerId: string,
    comment?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const results: Array<{
      id: string;
      status: 'APPROVED' | 'FAILED';
      error?: string;
    }> = [];

    for (const id of requestIds) {
      try {
        await this.approve(id, reviewerId, { comment }, ipAddress, userAgent);
        results.push({ id, status: 'APPROVED' });
      } catch (err: any) {
        results.push({ id, status: 'FAILED', error: err.message });
      }
    }

    return {
      total: requestIds.length,
      approvedCount: results.filter((r) => r.status === 'APPROVED').length,
      failedCount: results.filter((r) => r.status === 'FAILED').length,
      results,
    };
  }

  /**
   * Query dynamic supported queue types and live pending counts.
   */
  async getQueueTypesAndCounts() {
    await this.syncPendingExamsToApprovalQueue();

    const supportedTypes = [
      { key: 'ALL', label: 'All Requests', resourceType: 'ALL' },
      { key: 'STUDENT_REGISTRATION', label: 'Student Registrations', resourceType: 'STUDENT' },
      { key: 'SCHOOL_REGISTRATION', label: 'School Onboarding', resourceType: 'INSTITUTION' },
      { key: 'BULK_UPLOAD', label: 'Bulk Imports', resourceType: 'BULK_UPLOAD' },
      { key: 'EXAM', label: 'Live Exams & Mocks', resourceType: 'EXAM' },
      { key: 'QUESTION', label: 'Question Bank', resourceType: 'QUESTION' },
      { key: 'TRANSLATION', label: 'Translations', resourceType: 'QUESTION_TRANSLATION' },
      { key: 'BILL', label: 'Bills & Invoices', resourceType: 'BILL' },
      { key: 'STAFF_UPDATE', label: 'Staff Updates', resourceType: 'STAFF_UPDATE' },
    ];

    const counts = await this.prisma.approvalRequest.groupBy({
      by: ['resourceType'],
      where: { status: 'PENDING' },
      _count: { id: true },
    });

    const countMap: Record<string, number> = {};
    let totalPending = 0;
    for (const c of counts) {
      countMap[c.resourceType] = c._count.id;
      totalPending += c._count.id;
    }

    const queueTypes = supportedTypes.map((t) => {
      let count = 0;
      if (t.key === 'ALL') {
        count = totalPending;
      } else if (t.key === 'STUDENT_REGISTRATION') {
        count = (countMap['STUDENT'] || 0) + (countMap['BULK_UPLOAD'] || 0);
      } else if (t.resourceType === 'EXAM') {
        count = (countMap['EXAM'] || 0) + (countMap['MOCK_TEST'] || 0) + (countMap['MOCK'] || 0);
      } else if (t.resourceType === 'QUESTION_TRANSLATION') {
        count = (countMap['QUESTION_TRANSLATION'] || 0) + (countMap['TRANSLATION'] || 0);
      } else if (t.resourceType === 'BILL') {
        count = (countMap['BILL'] || 0) + (countMap['BILLING'] || 0);
      } else {
        count = countMap[t.resourceType] || 0;
      }
      return {
        ...t,
        pendingCount: count,
      };
    });

    return {
      queueTypes,
      totalPending,
      countsByResource: countMap,
    };
  }

  /**
   * Query approval requests with pagination and filters.
   */
  async getApprovalRequests(filter: ApprovalFilterDto) {
    await this.syncPendingExamsToApprovalQueue();

    const page = filter.page || 1;
    const limit = filter.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filter.entityType && filter.entityType.toUpperCase() !== 'ALL') {
      const et = filter.entityType.toUpperCase();
      if (et === 'STUDENT_REGISTRATION' || et === 'STUDENT') {
        where.resourceType = { in: ['STUDENT', 'BULK_UPLOAD'] };
      } else if (et === 'BULK_UPLOAD') {
        where.resourceType = 'BULK_UPLOAD';
      } else if (et === 'SCHOOL_REGISTRATION' || et === 'INSTITUTION' || et === 'SCHOOL') {
        where.resourceType = 'INSTITUTION';
      } else if (et === 'EXAM' || et === 'MOCK_TEST' || et === 'MOCK') {
        where.resourceType = { in: ['EXAM', 'MOCK_TEST', 'MOCK'] };
      } else if (et === 'TRANSLATION' || et === 'QUESTION_TRANSLATION') {
        where.resourceType = { in: ['QUESTION_TRANSLATION', 'TRANSLATION'] };
      } else if (et === 'BILL' || et === 'BILLING') {
        where.resourceType = { in: ['BILL', 'BILLING'] };
      } else if (et === 'QUESTION') {
        where.resourceType = 'QUESTION';
      } else if (et === 'STAFF_UPDATE') {
        where.resourceType = 'STAFF_UPDATE';
      } else {
        where.resourceType = et;
      }
    }

    if (filter.status && filter.status.toUpperCase() !== 'ALL') {
      where.status = filter.status.toUpperCase();
    }
    if (filter.submittedBy) where.requestedById = filter.submittedBy;

    if (filter.search && filter.search.trim()) {
      const s = filter.search.trim();
      where.OR = [
        { resourceId: { contains: s, mode: 'insensitive' } },
        { rejectionReason: { contains: s, mode: 'insensitive' } },
        { reviewComment: { contains: s, mode: 'insensitive' } },
      ];
    }

    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt.gte = new Date(filter.from);
      if (filter.to) where.createdAt.lte = new Date(filter.to);
    }

    const sortField = filter.sortBy || 'createdAt';
    const sortDirection = filter.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc';

    const [rawItems, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortField]: sortDirection },
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);

    // Batch enrich items with entity previews
    const items = await Promise.all(
      rawItems.map(async (item) => {
        let entitySummary: any = null;
        let requestedByEmail: string | undefined;

        try {
          // Fetch requester info
          const user = await this.prisma.user.findUnique({
            where: { id: item.requestedById },
            select: {
              name: true,
              email: true,
              phone: true,
              mobileNumber: true,
              userRoles: { include: { role: true } },
              student: { select: { name: true } },
            },
          });
          const staffRole = user?.userRoles?.[0]?.role?.name || 'STAFF';
          if (user) {
            requestedByEmail = user.name || user.student?.name || user.email || user.mobileNumber || user.phone || 'Staff';
          }

          if (item.resourceType === 'STAFF_UPDATE') {
            const meta = (item.metadata as any) || {};
            entitySummary = {
              staffMember: requestedByEmail || 'Staff',
              role: staffRole,
              entityType: meta.entityType || 'ENTITY',
              entityId: item.resourceId,
              currentValue: meta.currentValue || null,
              proposedValue: meta.proposedValue || null,
              reason: meta.reason || item.rejectionReason || 'Staff update request',
              submittedAt: item.submittedAt || item.createdAt,
              status: item.status,
            };
          } else if (item.resourceType === 'EXAM' || item.resourceType === 'MOCK_TEST' || item.resourceType === 'MOCK') {
            const exam = await this.prisma.exam.findUnique({
              where: { id: item.resourceId },
              include: {
                examTarget: { select: { name: true } },
                status: { select: { name: true } },
                sections: { include: { subject: { select: { name: true } } } },
                schedules: {
                  where: { status: { in: ['SCHEDULED', 'ACTIVE'] } },
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                },
                _count: { select: { examQuestions: true } },
              },
            });
            if (exam) {
              const activeSchedule = exam.schedules?.[0];
              const isMock =
                item.resourceType === 'MOCK_TEST' ||
                exam.title.toUpperCase().includes('MOCK') ||
                exam.title.toUpperCase().includes('PRACTICE') ||
                (exam.sections && exam.sections.length === 1);

              entitySummary = {
                id: exam.id,
                title: exam.title,
                targetExam: exam.examTarget?.name || 'General',
                totalQuestions: exam.totalQuestions || exam._count.examQuestions || 0,
                durationMinutes: exam.durationMinutes || 60,
                totalMarks: exam.totalMarks || 0,
                subjects: exam.sections.map((s) => s.subject.name),
                status: exam.status?.name,
                isMock,
                scheduleId: activeSchedule?.id,
                startTime: activeSchedule?.startTime
                  ? activeSchedule.startTime.toISOString()
                  : null,
                endTime: activeSchedule?.endTime
                  ? activeSchedule.endTime.toISOString()
                  : null,
              };
            }
          } else if (item.resourceType === 'QUESTION') {
            const question = await this.prisma.question.findUnique({
              where: { id: item.resourceId },
              include: {
                subject: { select: { name: true } },
                translations: { select: { questionText: true }, take: 1 },
              },
            });
            if (question) {
              entitySummary = {
                id: question.id,
                title:
                  question.translations?.[0]?.questionText?.substring(0, 100) ||
                  `Question ${question.id.substring(0, 8)}`,
                subject: question.subject?.name,
              };
            }
          } else if (item.resourceType === 'STUDENT') {
            const meta = (item.metadata as any) || {};
            const student = await this.prisma.student.findUnique({
              where: { id: item.resourceId },
              include: {
                studentClass: { select: { name: true } },
                examTarget: { select: { name: true } },
                institution: { select: { name: true, code: true } },
              },
            }).catch(() => null);

            entitySummary = {
              id: item.resourceId,
              title: student?.name || meta.name || 'Student Registration',
              studentId: student?.studentId || meta.studentId || 'N/A',
              studentCode: student?.studentCode || meta.studentCode || 'N/A',
              schoolName: student?.schoolCollege || student?.institution?.name || meta.schoolCollege || 'School / College',
              city: student?.district || meta.district || 'N/A',
              state: student?.state || meta.state || 'N/A',
              grade: student?.studentClass?.name || meta.grade || 'N/A',
              targetExam: student?.examTarget?.name || meta.targetExam || meta.examTarget || 'General',
              mobile: meta.mobile || meta.phone || 'N/A',
              email: meta.email || 'N/A',
            };
          } else if (item.resourceType === 'BULK_UPLOAD') {
            const meta = (item.metadata as any) || {};
            const upload = await this.prisma.bulkUpload.findUnique({
              where: { id: item.resourceId },
              include: { institution: { select: { name: true, code: true } } },
            }).catch(() => null);

            entitySummary = {
              id: item.resourceId,
              title: upload?.fileName || meta.fileName || `Student Bulk Import (${upload?.validRowCount ?? meta.validRowCount ?? 0} Students)`,
              schoolName: upload?.institution?.name || meta.schoolName || 'Institution Roster',
              validRowCount: upload?.validRowCount ?? meta.validRowCount ?? 0,
              invalidRowCount: upload?.invalidRowCount ?? meta.invalidRowCount ?? 0,
              batchId: upload?.batchId || meta.batchId || null,
            };
          } else if (item.resourceType === 'INSTITUTION') {
            const meta = (item.metadata as any) || {};
            const inst = await this.prisma.institution.findUnique({
              where: { id: item.resourceId },
            }).catch(() => null);

            entitySummary = {
              id: item.resourceId,
              title: inst?.name || meta.name || `School Onboarding (${meta.code || 'Registration'})`,
              code: inst?.code || meta.code || 'N/A',
              city: inst?.city || meta.city || 'N/A',
              state: inst?.state || meta.state || 'N/A',
              type: inst?.type || meta.type || 'SCHOOL',
            };
          } else if (item.resourceType === 'BILL' || item.resourceType === 'BILLING') {
            const meta = (item.metadata as any) || {};
            const bill = await this.prisma.bill.findUnique({
              where: { id: item.resourceId },
              include: { institution: { select: { name: true, code: true } } },
            }).catch(() => null);

            entitySummary = {
              id: item.resourceId,
              title: bill ? `Bill #${bill.billNumber}` : meta.billNumber ? `Bill #${meta.billNumber}` : 'B2B Invoice Approval',
              schoolName: bill?.institution?.name || meta.schoolName || 'Partner School',
              totalAmount: bill?.totalAmount ?? meta.totalAmount ?? meta.amount ?? 0,
              billNumber: bill?.billNumber || meta.billNumber,
            };
          } else if (item.resourceType === 'QUESTION_TRANSLATION' || item.resourceType === 'TRANSLATION') {
            const meta = (item.metadata as any) || {};
            entitySummary = {
              id: item.resourceId,
              title: meta.title || `Bilingual Translation for Question ${item.resourceId.substring(0, 8)}`,
              language: meta.targetLanguage || meta.language || 'Hindi / Regional',
            };
          }
        } catch {
          // graceful fallback
        }

        return {
          ...item,
          entitySummary,
          requestedByName: requestedByEmail || 'Admin',
        };
      }),
    );

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single approval request by ID with target entity preview.
   */
  async getApprovalById(id: string) {
    const request = await this.prisma.approvalRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException(`Approval request '${id}' not found.`);
    }

    // Resolve target entity summary
    let entityPreview: any = null;
    let requestedByName: string | undefined;

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: request.requestedById },
        select: {
          name: true,
          email: true,
          phone: true,
          mobileNumber: true,
          userRoles: { include: { role: true } },
          student: { select: { name: true } },
        },
      });
      const staffRole = user?.userRoles?.[0]?.role?.name || 'STAFF';
      if (user) {
        requestedByName = user.name || user.student?.name || user.email || user.mobileNumber || user.phone || 'Staff';
      }

      if (request.resourceType === 'STAFF_UPDATE') {
        const meta = (request.metadata as any) || {};
        entityPreview = {
          staffMember: requestedByName || 'Staff',
          role: staffRole,
          entityType: meta.entityType || 'ENTITY',
          entityId: request.resourceId,
          currentValue: meta.currentValue || null,
          proposedValue: meta.proposedValue || null,
          reason: meta.reason || request.rejectionReason || 'Staff update request',
          submittedAt: request.submittedAt || request.createdAt,
          status: request.status,
        };
      } else if (request.resourceType === 'QUESTION') {
        entityPreview = await this.prisma.question.findUnique({
          where: { id: request.resourceId },
          include: {
            subject: { select: { name: true } },
            options: true,
          },
        });
      } else if (
        request.resourceType === 'EXAM' ||
        request.resourceType === 'MOCK_TEST' ||
        request.resourceType === 'MOCK'
      ) {
        entityPreview = await this.prisma.exam.findUnique({
          where: { id: request.resourceId },
          include: {
            examTarget: true,
            status: true,
            sections: { include: { subject: true } },
            versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            _count: { select: { examQuestions: true } },
          },
        });
      } else if (request.resourceType === 'INSTITUTION') {
        entityPreview = await this.prisma.institution.findUnique({
          where: { id: request.resourceId },
        });
      } else if (request.resourceType === 'BULK_UPLOAD') {
        entityPreview = await this.prisma.bulkUpload.findUnique({
          where: { id: request.resourceId },
          include: { batch: true },
        });
      }
    } catch {
      // Graceful fallback
    }

    return {
      ...request,
      entityPreview,
      requestedByName: requestedByName || 'Admin',
    };
  }
}
