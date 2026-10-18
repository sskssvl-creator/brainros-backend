import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExamLifecycleService } from './exam-lifecycle.service';
import { resolveEligibleExamTypes } from '../../../common/constants/target-exam.constant';

export interface ExamAccessValidationResult {
  isAllowed: boolean;
  examId: string;
  examVersionId?: string;
  scheduleId?: string;
  serverTime: Date;
  startTime: Date;
  endTime: Date;
  timeRemainingSeconds: number;
}

@Injectable()
export class ExamAccessService {
  private readonly logger = new Logger(ExamAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycleService: ExamLifecycleService,
  ) {}

  /**
   * Server-Authoritative Student Access Evaluation
   * Evaluates exact time boundaries (UTC) and lifecycle requirements.
   */
  async validateStudentAccess(
    examId: string,
    studentId?: string,
  ): Promise<ExamAccessValidationResult> {
    const serverNow = new Date();

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        examTarget: true,
        schedules: {
          where: { status: { in: ['ACTIVE', 'SCHEDULED'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    const currentStatus = exam.status?.name;

    // 1. Status Lifecycle Checks
    if (currentStatus === 'CANCELLED') {
      throw new ForbiddenException({
        code: 'EXAM_CANCELLED',
        message: 'This examination has been cancelled by administration.',
      });
    }

    if (currentStatus === 'DRAFT' || currentStatus === 'SUBMITTED') {
      throw new ForbiddenException({
        code: 'EXAM_NOT_APPROVED',
        message: 'This exam is still in authoring review and not yet approved.',
      });
    }

    if (currentStatus === 'APPROVED') {
      throw new ForbiddenException({
        code: 'EXAM_NOT_SCHEDULED',
        message:
          'This exam is approved but has not yet been scheduled or activated.',
      });
    }

    if (currentStatus === 'SCHEDULED') {
      throw new ForbiddenException({
        code: 'EXAM_NOT_ACTIVE',
        message:
          'This exam is scheduled but not yet activated by Super Admin. Please wait for activation.',
      });
    }

    if (currentStatus === 'ENDED' || currentStatus === 'EVALUATING') {
      throw new ForbiddenException({
        code: 'EXAM_ENDED',
        message: 'The examination window for this test has ended.',
      });
    }

    if (currentStatus !== 'ACTIVE' && currentStatus !== 'COMPLETED') {
      throw new ForbiddenException({
        code: 'EXAM_ACCESS_DENIED',
        message: `Exam status is '${currentStatus}'. Student access is denied.`,
      });
    }

    // 2. Active Schedule Check
    const activeSchedule = exam.schedules?.[0];

    if (activeSchedule) {
      if (activeSchedule.status !== 'ACTIVE') {
        throw new ForbiddenException({
          code: 'EXAM_NOT_ACTIVE',
          message: 'No active schedule found for this exam.',
        });
      }

      const startTime = new Date(activeSchedule.startTime);
      const endTime = new Date(activeSchedule.endTime);

      // Rule: serverNow must be >= startTime
      if (serverNow.getTime() < startTime.getTime()) {
        const waitSeconds = Math.ceil(
          (startTime.getTime() - serverNow.getTime()) / 1000,
        );
        throw new ForbiddenException({
          code: 'EXAM_NOT_YET_STARTED',
          message: `This exam is scheduled to start at ${startTime.toISOString()}. Please wait ${waitSeconds} seconds.`,
          serverTime: serverNow.toISOString(),
          startTime: startTime.toISOString(),
          waitSeconds,
        });
      }

      // Rule: serverNow must be < endTime
      if (serverNow.getTime() >= endTime.getTime()) {
        this.lifecycleService.endExam(examId).catch((err) => {
          this.logger.error(
            `Error transitioning exam '${examId}' to ENDED: ${err.message}`,
          );
        });

        throw new ForbiddenException({
          code: 'EXAM_ENDED',
          message: `The live examination window ended at ${endTime.toISOString()}. Student access is closed.`,
          serverTime: serverNow.toISOString(),
          endTime: endTime.toISOString(),
        });
      }

      // 3. Student Eligibility Check
      if (studentId && exam.examTarget && exam.examTarget.name !== 'General') {
        const student = await this.prisma.student.findFirst({
          where: { OR: [{ id: studentId }, { userId: studentId }] },
          include: {
            examTarget: true,
            studentExamTargets: { include: { examTarget: true } },
          },
        });

        if (student) {
          const rawTargetNames: string[] = [];
          if (student.examTarget?.name) rawTargetNames.push(student.examTarget.name);
          if (Array.isArray(student.studentExamTargets)) {
            student.studentExamTargets.forEach((st: any) => {
              if (st.examTarget?.name) rawTargetNames.push(st.examTarget.name);
            });
          }

          const eligibleTypes = new Set<string>();
          for (const name of rawTargetNames) {
            resolveEligibleExamTypes(name).forEach((t) =>
              eligibleTypes.add(t.toLowerCase()),
            );
          }

          if (student.jee) eligibleTypes.add('jee');
          if (student.cet) eligibleTypes.add('cet');
          if (student.neet) eligibleTypes.add('neet');

          const directTargetIds = new Set<string>([
            ...(student.examTargetId ? [student.examTargetId] : []),
            ...(student.studentExamTargets?.map((st: any) => st.examTargetId) || []),
          ]);

          const examTargetNameLower = exam.examTarget.name.toLowerCase().trim();
          const isEligible =
            eligibleTypes.has(examTargetNameLower) ||
            directTargetIds.has(exam.examTargetId);

          if (!isEligible) {
            const studentTargetLabel = student.examTarget?.name || 'Unassigned';
            throw new ForbiddenException({
              code: 'EXAM_NOT_ELIGIBLE',
              message: `You are not eligible to take this examination. Your registered target is '${studentTargetLabel}', but this exam is for '${exam.examTarget.name}'.`,
            });
          }
        }
      }

      const timeRemainingSeconds = Math.max(
        0,
        Math.floor((endTime.getTime() - serverNow.getTime()) / 1000),
      );

      return {
        isAllowed: true,
        examId: exam.id,
        examVersionId: activeSchedule.examVersionId || undefined,
        scheduleId: activeSchedule.id,
        serverTime: serverNow,
        startTime,
        endTime,
        timeRemainingSeconds,
      };
    }

    // If no schedule exists (e.g. self-paced mock test), provide standard exam duration window
    const durationMinutes = exam.durationMinutes || 60;
    const openEndTime = new Date(
      serverNow.getTime() + durationMinutes * 60 * 1000,
    );

    return {
      isAllowed: true,
      examId: exam.id,
      serverTime: serverNow,
      startTime: serverNow,
      endTime: openEndTime,
      timeRemainingSeconds: durationMinutes * 60,
    };
  }
}
