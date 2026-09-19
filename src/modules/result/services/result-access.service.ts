import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ResultReadinessService } from './result-readiness.service';
import {
  ResultProcessingStatus,
  ResultPublicationStatus,
  ReportFileStatus,
  ResultStatusResponse,
  ResultStatusEnum,
} from '../interfaces/result-lifecycle.interface';

@Injectable()
export class ResultAccessService {
  private readonly logger = new Logger(ResultAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly readinessService: ResultReadinessService,
  ) {}

  /**
   * Verify caller ownership or permission to access an attempt.
   * Supports Student self, Parent (via ParentStudentLink), Institution Admin (via batch link),
   * and System Admin / Super Admin.
   */
  async verifyAttemptAccess(
    user: any,
    attemptId: string,
  ): Promise<{
    attempt: any;
    isAuthorized: boolean;
    role: string;
    studentId: string;
  }> {
    const userId = user?.userId || user?.id || user?.sub;
    const userRole = (user?.role || user?.roles?.[0] || 'STUDENT').toUpperCase();

    const attempt: any = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        student: {
          include: {
            user: { select: { id: true, email: true } },
          },
        },
        exam: {
          include: {
            schedules: {
              where: { status: { in: ['SCHEDULED', 'ACTIVE', 'ENDED'] } },
              take: 1,
            },
          },
        },
        status: true,
        result: {
          include: {
            subjectResults: true,
            chapterResults: true,
          },
        },
        timeAnalyses: { take: 1 },
        strategyAnalyses: { take: 1 },
        candidateRanks: { take: 1 },
      },
    });

    if (!attempt) {
      throw new NotFoundException(`Attempt with ID '${attemptId}' not found.`);
    }

    // 1. System Admins and Super Admins have universal access
    if (['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      return {
        attempt,
        isAuthorized: true,
        role: userRole,
        studentId: attempt.studentId,
      };
    }

    // 2. Student Self-Verification
    const studentUserMatches =
      attempt.student?.userId === userId ||
      attempt.studentId === user?.studentId ||
      attempt.studentId === userId;

    if (studentUserMatches) {
      return {
        attempt,
        isAuthorized: true,
        role: 'STUDENT',
        studentId: attempt.studentId,
      };
    }

    // 3. Parent Authorization via ParentStudentLink
    if (userRole === 'PARENT') {
      const parentLink = await this.prisma.parentStudentLink.findFirst({
        where: {
          parentId: userId,
          studentId: attempt.studentId,
          status: 'ACTIVE',
        },
      });

      if (parentLink) {
        return {
          attempt,
          isAuthorized: true,
          role: 'PARENT',
          studentId: attempt.studentId,
        };
      }
    }

    // 4. Institution Admin Authorization
    if (userRole === 'INSTITUTION_ADMIN') {
      const institutionAdmin = await this.prisma.institutionAdmin.findFirst({
        where: { userId },
      });

      if (institutionAdmin) {
        const batchStudent = await this.prisma.batchStudent.findFirst({
          where: {
            studentId: attempt.studentId,
            batch: { institutionId: institutionAdmin.institutionId },
          },
        });

        if (batchStudent) {
          return {
            attempt,
            isAuthorized: true,
            role: 'INSTITUTION_ADMIN',
            studentId: attempt.studentId,
          };
        }
      }
    }

    // If none matched, deny access
    throw new ForbiddenException(
      'You are not authorized to view or access this exam attempt result.',
    );
  }

  /**
   * Authoritative Verification of Result State using durable PostgreSQL data.
   * Redis / BullMQ queue state is NOT treated as authoritative.
   */
  async verifyResultState(attempt: any): Promise<{
    processingStatus: ResultProcessingStatus;
    publicationStatus: ResultPublicationStatus;
    isLive: boolean;
    resultCalculated: boolean;
    reportAvailable: boolean;
    onlineReportAvailable: boolean;
    pdfReportStatus: ReportFileStatus;
  }> {
    const isLive = await this.readinessService.isLiveExam(attempt.examId);
    const result = attempt.result;
    const attemptStatus = attempt.status?.name || '';

    // Check if result is durably calculated and persisted in PostgreSQL
    // If attempt status is EVALUATED or result exists with score, it is EVALUATED!
    const isEvaluated =
      attemptStatus === 'EVALUATED' ||
      result?.resultStatus === 'PUBLISHED' ||
      result?.resultStatus === 'COMPLETED' ||
      (result &&
        result.totalScore !== undefined &&
        result.totalScore !== null);

    const resultCalculated = Boolean(isEvaluated);

    let processingStatus: ResultProcessingStatus;
    let publicationStatus: ResultPublicationStatus;

    if (!resultCalculated) {
      if (['NOT_STARTED', 'IN_PROGRESS'].includes(attemptStatus)) {
        processingStatus = ResultProcessingStatus.NOT_STARTED;
      } else if (['SUBMITTED', 'AUTO_SUBMITTED'].includes(attemptStatus)) {
        processingStatus =
          result?.resultStatus === ResultStatusEnum.PENDING_WINDOW_CLOSE
            ? ResultProcessingStatus.PENDING_WINDOW_CLOSE
            : ResultProcessingStatus.PROCESSING;
      } else if (attemptStatus === 'CANCELLED' || attemptStatus === 'FAILED') {
        processingStatus = ResultProcessingStatus.FAILED;
      } else {
        processingStatus = ResultProcessingStatus.PROCESSING;
      }
      publicationStatus = ResultPublicationStatus.NOT_PUBLISHED;
    } else {
      // Result is durably calculated in DB
      processingStatus = ResultProcessingStatus.COMPLETED;

      // Determine Publication Status
      const rawStatus = (result?.resultStatus || '').toUpperCase();

      if (isLive) {
        // For Live exams, official report is strictly withheld until Super Admin publication
        publicationStatus =
          rawStatus === 'PUBLISHED'
            ? ResultPublicationStatus.PUBLISHED
            : rawStatus === 'READY_TO_PUBLISH'
            ? ResultPublicationStatus.READY_TO_PUBLISH
            : ResultPublicationStatus.NOT_PUBLISHED;
      } else {
        // For Mock tests: once calculation is complete, it is auto-published/available
        publicationStatus = ResultPublicationStatus.PUBLISHED;

        // Auto-heal DB status if it was still labelled EVALUATED/COMPLETED
        if (result && result.resultStatus !== ResultStatusEnum.PUBLISHED) {
          this.prisma.result
            .update({
              where: { id: result.id },
              data: {
                resultStatus: ResultStatusEnum.PUBLISHED,
                publishedAt: result.publishedAt || new Date(),
              },
            })
            .catch((err) =>
              this.logger.warn(`Failed auto-healing Mock publication: ${err.message}`),
            );
        }
      }
    }

    // Check downloadable PDF file status
    let pdfReportStatus = ReportFileStatus.REPORT_NOT_GENERATED;
    try {
      const reportJob = await this.prisma.reportJob.findFirst({
        where: {
          filters: {
            path: ['attemptId'],
            equals: attempt.id,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (reportJob) {
        if (reportJob.status === 'COMPLETED') {
          pdfReportStatus = ReportFileStatus.REPORT_READY;
        } else if (reportJob.status === 'PROCESSING' || reportJob.status === 'QUEUED') {
          pdfReportStatus = ReportFileStatus.REPORT_PROCESSING;
        } else if (reportJob.status === 'FAILED') {
          pdfReportStatus = ReportFileStatus.REPORT_FAILED;
        }
      }
    } catch {
      // Non-blocking report job inspection fallback
    }

    // Online report visibility logic:
    // For Live exams, official result is strictly hidden until Super Admin publishes it.
    // For Mock tests, result is available as soon as calculation completes.
    const canStudentView = isLive
      ? publicationStatus === ResultPublicationStatus.PUBLISHED
      : resultCalculated;

    const reportAvailable = canStudentView;
    const onlineReportAvailable = canStudentView;

    return {
      processingStatus,
      publicationStatus,
      isLive,
      resultCalculated,
      reportAvailable,
      onlineReportAvailable,
      pdfReportStatus,
    };
  }

  /**
   * Determine whether a specific user can view the complete diagnostic report.
   */
  async canViewReport(user: any, attemptId: string): Promise<boolean> {
    const { attempt, role } = await this.verifyAttemptAccess(user, attemptId);
    const state = await this.verifyResultState(attempt);

    // Admins can always view calculated reports even before official Live publication
    if (['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return state.resultCalculated;
    }

    return state.reportAvailable;
  }

  /**
   * Get formatted Result Status Response matching the API contract
   * and providing full backward-compatibility with frontend checks.
   */
  async getResultStatus(user: any, attemptId: string): Promise<ResultStatusResponse> {
    const { attempt, role } = await this.verifyAttemptAccess(user, attemptId);
    const state = await this.verifyResultState(attempt);

    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(role);

    // Backward-compatible availability field
    let availability: 'PROCESSING' | 'RESULT_PENDING' | 'RESULT_READY' | 'PUBLISHED' | 'WITHHELD' | 'DISQUALIFIED' | 'FAILED';
    let message: string;

    if (state.processingStatus === ResultProcessingStatus.FAILED) {
      availability = 'FAILED';
      message = 'We could not calculate your result. Please contact support or request a recalculation.';
    } else if (state.processingStatus === ResultProcessingStatus.PENDING_WINDOW_CLOSE) {
      availability = 'RESULT_PENDING';
      message = 'Your examination has been submitted. Evaluation and ranking will begin after the scheduled examination window ends.';
    } else if (!state.resultCalculated) {
      availability = 'PROCESSING';
      message = 'Your result is being calculated... Please check again shortly.';
    } else if (state.isLive && state.publicationStatus !== ResultPublicationStatus.PUBLISHED && !isAdmin) {
      availability = 'RESULT_PENDING';
      message = 'Your examination responses have been securely recorded and evaluated. Official results will be released upon publication by administration.';
    } else {
      // Result is calculated and either Mock or Published Live (or viewed by Admin)
      availability = 'PUBLISHED';
      message = 'Result is published and available.';
    }

    return {
      processingStatus: state.processingStatus,
      publicationStatus: state.publicationStatus,
      resultAvailable: state.resultCalculated,
      reportAvailable: isAdmin ? state.resultCalculated : state.reportAvailable,
      onlineReportAvailable: isAdmin ? state.resultCalculated : state.onlineReportAvailable,
      pdfReportStatus: state.pdfReportStatus,
      availability,
      resultStatus: state.resultCalculated ? 'COMPLETED' : 'PROCESSING',
      examType: state.isLive ? 'LIVE' : 'MOCK',
      message,
      attemptId: attempt.id,
      examTitle: attempt.exam?.title || 'Examination',
      submittedAt: attempt.submittedAt || null,
      publishedAt: attempt.result?.publishedAt || null,
    };
  }

  /**
   * Invalidate Redis result cache upon status transitions or result completion
   */
  async invalidateResultCache(attemptId: string, studentId?: string, examId?: string): Promise<void> {
    try {
      await this.redisService.del(`result:visibility:${attemptId}`);
      await this.redisService.del(`result:${attemptId}:status`);
      if (studentId) {
        await this.redisService.del(`student:${studentId}:results`);
        await this.redisService.del(`student:${studentId}:dashboard`);
      }
      if (examId) {
        await this.redisService.del(`exam:${examId}:leaderboard`);
        await this.redisService.del(`exam:${examId}:ranks`);
      }
    } catch (err: any) {
      this.logger.warn(`Redis cache invalidation warning for attempt '${attemptId}': ${err.message}`);
    }
  }
}
