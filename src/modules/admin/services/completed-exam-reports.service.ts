import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit/services/audit-log.service';
import { ResultService } from '../../result/result.service';
import { NotificationChannel, NotificationStatus, NotificationType } from '@prisma/client';
import { ExamReportEmailProcessor } from '../processors/exam-report-email.processor';
import { JobProgressService } from '../../job-progress/services/job-progress.service';

export interface CompletedExamQueryDto {
  search?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

@Injectable()
export class CompletedExamReportsService {
  private readonly logger = new Logger(CompletedExamReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly resultService: ResultService,
    private readonly jobProgressService: JobProgressService,
    @InjectQueue('exam-report-email')
    private readonly emailReportQueue: Queue,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Determine whether an exam is an official completed LIVE exam (not a Mock Test).
   */
  private isLiveExamTitle(title: string): boolean {
    const t = (title || '').toUpperCase();
    if (t.includes('MOCK') || t.includes('PRACTICE')) {
      return false;
    }
    return true;
  }

  /**
   * Returns list of all completed Live Exams, ordered by most recently completed first.
   */
  async getCompletedLiveExams() {
    const exams = await this.prisma.exam.findMany({
      where: {},
      include: {
        status: true,
        examTarget: { select: { id: true, name: true } },
        schedules: {
          orderBy: { endTime: 'desc' },
          take: 1,
        },
        resultPublications: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: {
          select: {
            attempts: true,
          },
        },
      },
      orderBy: [{ endTime: 'desc' }, { createdAt: 'desc' }],
    });

    const now = new Date();

    // Filter to exams that are live and whose window has ended or are completed / published
    const completedLiveExams = exams.filter((exam: any) => {
      const schedule = exam.schedules?.[0];
      const pub = exam.resultPublications?.[0];

      const scheduleEnded = schedule && (schedule.status === 'ENDED' || new Date(schedule.endTime) <= now);
      const examWindowEnded = exam.endTime && new Date(exam.endTime) <= now;
      const isStatusCompleted = ['COMPLETED', 'PUBLISHED', 'EVALUATED'].includes(exam.status?.name?.toUpperCase());
      const isPubCompleted = pub && ['PUBLISHED', 'READY_TO_PUBLISH'].includes(pub.status);

      return Boolean(scheduleEnded || examWindowEnded || isStatusCompleted || isPubCompleted);
    });

    return completedLiveExams.map((exam: any) => {
      const pub = exam.resultPublications?.[0];
      return {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        examDate: exam.examDate || exam.schedules?.[0]?.startTime || exam.startTime,
        startTime: exam.startTime || exam.schedules?.[0]?.startTime,
        endTime: exam.endTime || exam.schedules?.[0]?.endTime,
        durationMinutes: exam.durationMinutes,
        totalMarks: exam.totalMarks,
        totalQuestions: exam.totalQuestions,
        examTarget: exam.examTarget?.name || 'General',
        status: exam.status?.name,
        publicationStatus: pub?.status || (exam._count?.attempts > 0 ? 'READY_TO_PUBLISH' : 'NOT_READY'),
        totalAttempts: exam._count?.attempts || 0,
        scheduleId: exam.schedules?.[0]?.id || null,
        hasAnswerKey: Boolean(exam.schedules?.[0]?.hasAnswerKey),
      };
    });
  }

  /**
   * Returns the most recently completed Live Exam.
   */
  async getLatestCompletedLiveExam() {
    const list = await this.getCompletedLiveExams();
    if (list.length === 0) {
      return null;
    }
    return list[0];
  }

  /**
   * Computes aggregate summary metrics for the selected Live Exam.
   */
  async getLiveExamSummary(examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        examTarget: true,
        schedules: { take: 1, orderBy: { endTime: 'desc' } },
        resultPublications: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    // Removed Mock Test check to allow mock tests in the dashboard

    // 1. Registered Count: Students with exam target or enrollments
    const registeredCount = await this.prisma.student.count({
      where: {
        examTargetId: exam.examTargetId,
        status: 'ACTIVE',
      },
    });

    // 2. Attended Attempts: Attempts that actually started
    const attendedAttempts = await this.prisma.attempt.findMany({
      where: {
        examId,
        OR: [
          { startedAt: { not: null } },
          { status: { name: { in: ['IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] } } },
        ],
      },
      include: {
        status: true,
        result: true,
      },
    });

    const totalAttended = attendedAttempts.length;
    const submittedCount = attendedAttempts.filter((a) => a.status.name === 'SUBMITTED').length;
    const autoSubmittedCount = attendedAttempts.filter((a) => a.status.name === 'AUTO_SUBMITTED').length;
    const evaluatedCount = attendedAttempts.filter((a) => a.result !== null).length;
    const failedCount = attendedAttempts.filter((a) => a.result?.resultStatus === 'FAILED').length;

    // 3. Averages from persisted Results
    const resultAggregates = await this.prisma.result.aggregate({
      where: {
        attempt: {
          examId,
        },
      },
      _avg: {
        totalScore: true,
        accuracy: true,
        percentage: true,
      },
      _max: {
        totalScore: true,
      },
      _min: {
        totalScore: true,
      },
    });

    const pub = exam.resultPublications[0];

    return {
      examId: exam.id,
      examTitle: exam.title,
      examDate: exam.examDate || exam.schedules[0]?.startTime || exam.startTime,
      durationMinutes: exam.durationMinutes,
      totalMarks: exam.totalMarks,
      totalQuestions: exam.totalQuestions,
      metrics: {
        registered: Math.max(registeredCount, totalAttended),
        attended: totalAttended,
        submitted: submittedCount,
        autoSubmitted: autoSubmittedCount,
        evaluated: evaluatedCount,
        failed: failedCount,
        averageScore: Number(resultAggregates._avg.totalScore || 0).toFixed(1),
        averageAccuracy: Number(resultAggregates._avg.accuracy || 0).toFixed(1),
        averagePercentage: Number(resultAggregates._avg.percentage || 0).toFixed(1),
        highestScore: resultAggregates._max.totalScore || 0,
        lowestScore: resultAggregates._min.totalScore || 0,
      },
      publication: {
        status: pub?.status || (evaluatedCount > 0 ? 'READY_TO_PUBLISH' : 'NOT_READY'),
        publishedAt: pub?.publishedAt || null,
        evaluatedAttempts: pub?.evaluatedAttempts || evaluatedCount,
        totalEligibleAttempts: pub?.totalEligibleAttempts || totalAttended,
      },
    };
  }

  /**
   * Paginated, searchable, filterable list of student attendees for the selected Live Exam.
   */
  async getLiveExamAttendees(examId: string, query: CompletedExamQueryDto) {
    const {
      search = '',
      status = '',
      sortBy = 'submittedAt',
      sortOrder = 'desc',
      page = 1,
      limit = 10,
    } = query;

    const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
    const take = Math.min(100, Math.max(1, limit));

    // Base WHERE condition: only actual attendees for this exam
    const whereCondition: any = {
      examId,
      OR: [
        { startedAt: { not: null } },
        { status: { name: { in: ['IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] } } },
      ],
    };

    if (search.trim()) {
      const q = search.trim();
      whereCondition.AND = [
        {
          OR: [
            { student: { name: { contains: q, mode: 'insensitive' } } },
            { student: { studentId: { contains: q, mode: 'insensitive' } } },
            { student: { studentCode: { contains: q, mode: 'insensitive' } } },
            { student: { user: { email: { contains: q, mode: 'insensitive' } } } },
            { student: { user: { phone: { contains: q, mode: 'insensitive' } } } },
          ],
        },
      ];
    }

    if (status.trim() && status.toUpperCase() !== 'ALL') {
      const s = status.toUpperCase();
      if (['SUBMITTED', 'AUTO_SUBMITTED', 'IN_PROGRESS', 'EVALUATED'].includes(s)) {
        whereCondition.status = { name: s };
      } else if (['PUBLISHED', 'READY_TO_PUBLISH', 'FAILED'].includes(s)) {
        whereCondition.result = { resultStatus: s };
      }
    }

    // Determine sorting
    let orderBy: any = { submittedAt: sortOrder };
    if (sortBy === 'studentName') {
      orderBy = { student: { name: sortOrder } };
    } else if (sortBy === 'score') {
      orderBy = { result: { totalScore: sortOrder } };
    } else if (sortBy === 'accuracy') {
      orderBy = { result: { accuracy: sortOrder } };
    } else if (sortBy === 'createdAt') {
      orderBy = { createdAt: sortOrder };
    }

    const [total, attempts] = await Promise.all([
      this.prisma.attempt.count({ where: whereCondition }),
      this.prisma.attempt.findMany({
        where: whereCondition,
        include: {
          status: true,
          student: {
            include: {
              user: { select: { id: true, email: true, phone: true } },
              preferredLanguage: { select: { name: true, code: true } },
              institution: { select: { id: true, name: true, code: true, email: true } },
            },
          },
          result: true,
          candidateRanks: {
            where: { rankType: 'OVERALL' },
            take: 1,
          },
        },
        orderBy,
        skip,
        take,
      }),
    ]);

    // Fetch latest email notification statuses and analysis reports for these attempts
    const attemptIds = attempts.map((a) => a.id);
    const [notifications, reports] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          type: NotificationType.REPORT_READY,
          correlationId: { in: attemptIds },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.examAnalysisReport.findMany({
        where: {
          attemptId: { in: attemptIds },
        },
      }),
    ]);

    const notificationMap = new Map<string, any>();
    notifications.forEach((n) => {
      if (n.correlationId && !notificationMap.has(n.correlationId)) {
        notificationMap.set(n.correlationId, n);
      }
    });

    const reportMap = new Map<string, any>();
    reports.forEach((r) => {
      reportMap.set(r.attemptId, r);
    });

    const items = attempts.map((att) => {
      const rankData = att.candidateRanks[0];
      const notif = notificationMap.get(att.id);
      const report = reportMap.get(att.id);

      let emailStatus: 'NONE' | 'QUEUED' | 'PROCESSING' | 'SENT' | 'FAILED' = 'NONE';
      if (notif) {
        if (notif.status === NotificationStatus.SENT) emailStatus = 'SENT';
        else if (notif.status === NotificationStatus.FAILED) emailStatus = 'FAILED';
        else if (notif.status === NotificationStatus.PROCESSING) emailStatus = 'PROCESSING';
        else if (notif.status === NotificationStatus.PENDING) emailStatus = 'QUEUED';
      }

      let reportStatus = report?.status || (att.result ? 'READY_FOR_REVIEW' : 'PENDING');
      if (emailStatus === 'SENT') reportStatus = 'EMAILED';

      return {
        attemptId: att.id,
        examId: att.examId,
        studentId: att.studentId,
        studentName: att.student.name,
        studentCode: att.student.studentCode || att.student.studentId,
        email: att.student.user.email,
        phone: att.student.user.phone,
        institutionId: att.student.institution?.id || null,
        institutionName: att.student.institution?.name || null,
        institutionEmail: att.student.institution?.email || null,
        attemptStatus: att.status.name,
        startedAt: att.startedAt,
        submittedAt: att.submittedAt,
        score: att.result?.totalScore ?? null,
        maxScore: att.result?.maxScore ?? null,
        percentage: att.result?.percentage ?? null,
        accuracy: att.result?.accuracy ?? null,
        rank: rankData?.rank ?? null,
        percentile: rankData?.percentile ?? null,
        totalCandidates: rankData?.totalCandidates ?? null,
        resultStatus: att.result ? att.result.resultStatus || 'EVALUATED' : 'EVALUATING',
        reportStatus,
        approvedAt: report?.approvedAt || null,
        approvedBy: report?.approvedById || null,
        emailStatus,
        lastEmailSentAt: notif?.sentAt || null,
      };
    });

    return {
      items,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / take),
      },
    };
  }

  /**
   * Pure Read-Only Student Analysis & Question Review
   * Uses existing persisted Result + Analytics + Answers snapshot without recalculation.
   */
  async getStudentAttemptAnalysis(examId: string, attemptId: string, user: any) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        exam: true,
        result: {
          include: {
            subjectResults: { include: { subject: true } },
            chapterResults: { include: { chapter: { include: { subject: true } } } },
          },
        },
        student: {
          include: {
            user: { select: { id: true, email: true, phone: true } },
          },
        },
        candidateRanks: {
          where: { rankType: 'OVERALL' },
          take: 1,
        },
      },
    });

    if (!attempt) {
      throw new NotFoundException(`Attempt with ID '${attemptId}' not found.`);
    }

    if (attempt.examId !== examId) {
      throw new BadRequestException('The requested attempt does not belong to the specified exam.');
    }

    // 1. Fetch full persisted analysis using ResultService (pure read-only)
    const fullAnalysis = (await this.resultService.getFullAnalysis(attemptId, user)) as any;

    // 2. Fetch question-by-question answer review (immutable snapshot)
    const review = await this.resultService.getAnswerReview(attemptId, user);

    // 3. Email delivery status check
    const emailStatus = await this.getReportEmailStatus(examId, attemptId);

    // 4. Normalize analysis: provide flat top-level metrics alongside nested analysis objects
    const normalizedAnalysis = {
      ...fullAnalysis,
      score: fullAnalysis?.overall?.obtainedMarks ?? attempt.result?.totalScore ?? 0,
      totalScore: fullAnalysis?.overall?.obtainedMarks ?? attempt.result?.totalScore ?? 0,
      maxScore: fullAnalysis?.overall?.totalMarks ?? attempt.result?.maxScore ?? attempt.exam?.totalMarks ?? 0,
      percentage: fullAnalysis?.overall?.percentage ?? attempt.result?.percentage ?? 0,
      accuracy: fullAnalysis?.overall?.accuracy ?? attempt.result?.accuracy ?? 0,
      correctAnswers: fullAnalysis?.overall?.correctCount ?? attempt.result?.correctAnswers ?? 0,
      wrongAnswers: fullAnalysis?.overall?.wrongCount ?? attempt.result?.wrongAnswers ?? 0,
      unattempted: fullAnalysis?.overall?.unattemptedCount ?? attempt.result?.unattempted ?? 0,
      totalQuestions: fullAnalysis?.overall?.totalQuestions ?? attempt.result?.totalQuestions ?? attempt.exam?.totalQuestions ?? 0,
      timeUsedSeconds: fullAnalysis?.overall?.timeUsedSeconds ?? fullAnalysis?.timeAnalysis?.totalTimeUsedSeconds ?? attempt.result?.timeUsedSeconds ?? 0,
      averageTimePerQuestion: fullAnalysis?.overall?.averageTimePerQuestionSeconds ?? fullAnalysis?.timeAnalysis?.averageTimePerQuestionSeconds ?? attempt.result?.averageTimePerQuestion ?? 0,
      quadrant: fullAnalysis?.overall?.speedAccuracyQuadrant || 'BALANCED',
      subjectAnalysis: fullAnalysis?.subjects?.items || attempt.result?.subjectResults?.map((sr: any) => ({
        subjectId: sr.subjectId,
        subjectName: sr.subject?.name || 'Subject',
        score: sr.score,
        maxScore: sr.maxScore,
        correct: sr.correctAnswers,
        wrong: sr.wrongAnswers,
        unattempted: sr.unattempted,
        accuracy: sr.accuracy,
        percentage: sr.percentage,
      })) || [],
      subjectResults: fullAnalysis?.subjects?.items || attempt.result?.subjectResults || [],
      chapterAnalysis: fullAnalysis?.chapters?.items || attempt.result?.chapterResults?.map((cr: any) => ({
        chapterId: cr.chapterId,
        chapterName: cr.chapter?.name || 'Chapter',
        subjectName: cr.chapter?.subject?.name || 'General',
        accuracy: cr.accuracy,
        status: cr.performanceStatus,
        score: cr.score,
        maxScore: cr.maxScore,
      })) || [],
      chapterResults: fullAnalysis?.chapters?.items || attempt.result?.chapterResults || [],
      timeAnalysis: {
        ...(fullAnalysis?.timeAnalysis || {}),
        averageTimePerQuestion: fullAnalysis?.timeAnalysis?.averageTimePerQuestionSeconds ?? fullAnalysis?.overall?.averageTimePerQuestionSeconds ?? 0,
        rushedCount: fullAnalysis?.timeAnalysis?.pacingMetrics?.rushedCount ?? fullAnalysis?.timeAnalysis?.rushedCount ?? 0,
        optimalCount: fullAnalysis?.timeAnalysis?.pacingMetrics?.optimalPaceCount ?? fullAnalysis?.timeAnalysis?.optimalCount ?? 0,
        overthoughtCount: fullAnalysis?.timeAnalysis?.pacingMetrics?.overthoughtCount ?? fullAnalysis?.timeAnalysis?.overthoughtCount ?? 0,
      },
      strategyAnalysis: {
        ...(fullAnalysis?.attemptStrategy || {}),
        primaryClassification: fullAnalysis?.attemptStrategy?.accuracyVsSpeedProfile || 'BALANCED',
        confidence: 'HIGH',
        avoidableNegativeMarks: fullAnalysis?.attemptStrategy?.negativeMarkingPenalty ?? 0,
        projectedScore: fullAnalysis?.attemptStrategy?.scoreWithoutNegativeMarking ?? (attempt.result?.totalScore ?? 0),
      },
      attemptStrategy: fullAnalysis?.attemptStrategy,
      recommendations: fullAnalysis?.recommendations || [],
    };

    return {
      attemptId: attempt.id,
      examId: attempt.examId,
      examTitle: attempt.exam.title,
      student: {
        id: attempt.student.id,
        name: attempt.student.name,
        studentCode: attempt.student.studentCode || attempt.student.studentId,
        email: attempt.student.user.email,
        phone: attempt.student.user.phone,
      },
      submittedAt: attempt.submittedAt,
      rank: attempt.candidateRanks[0]
        ? {
            rank: attempt.candidateRanks[0].rank,
            percentile: attempt.candidateRanks[0].percentile,
            totalCandidates: attempt.candidateRanks[0].totalCandidates,
          }
        : null,
      analysis: normalizedAnalysis,
      questionsReview: review,
      emailStatus,
    };
  }

  /**
   * Approves a student analysis report for email distribution.
   */
  async approveReport(examId: string, attemptId: string, adminUser: any) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { result: true },
    });

    if (!attempt || attempt.examId !== examId) {
      throw new NotFoundException(`Attempt '${attemptId}' not found for exam '${examId}'.`);
    }

    if (!attempt.result) {
      throw new BadRequestException('Cannot approve report: Result has not been evaluated yet.');
    }

    const adminId = adminUser?.userId || adminUser?.id;
    const report = await this.prisma.examAnalysisReport.upsert({
      where: { attemptId },
      create: {
        examId: attempt.examId,
        examVersionId: attempt.examVersionId,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        status: 'APPROVED',
        approvedById: adminId,
        approvedAt: new Date(),
      },
      update: {
        status: 'APPROVED',
        approvedById: adminId,
        approvedAt: new Date(),
      },
    });

    if (adminId) {
      await this.auditLogService.logAction({
        actorUserId: adminId,
        action: 'REPORT_APPROVED',
        entityType: 'ExamAnalysisReport',
        entityId: report.id,
        metadata: { examId, attemptId, studentId: attempt.studentId },
      });
    }

    return {
      success: true,
      message: 'Report approved successfully.',
      reportStatus: report.status,
      approvedAt: report.approvedAt,
    };
  }

  /**
   * Enqueues a BullMQ job to asynchronously generate PDF and deliver via Resend.
   */
  async queueReportEmail(examId: string, attemptId: string, adminUser: any) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        exam: {
          include: {
            resultPublications: { take: 1, orderBy: { createdAt: 'desc' } },
          },
        },
        student: {
          include: {
            user: { select: { id: true, email: true, phone: true } },
          },
        },
        result: true,
      },
    });

    if (!attempt) {
      throw new NotFoundException(`Attempt with ID '${attemptId}' not found.`);
    }

    if (attempt.examId !== examId) {
      throw new BadRequestException('The requested attempt does not belong to the specified exam.');
    }

    if (!attempt.result) {
      throw new BadRequestException('Cannot send report email: Result has not been evaluated yet.');
    }

    const recipientEmail = attempt.student.user?.email;
    if (!recipientEmail || !recipientEmail.includes('@')) {
      throw new BadRequestException(`Student '${attempt.student.name}' does not have a valid registered email address.`);
    }

    // Ensure ExamAnalysisReport status is set to EMAIL_QUEUED
    await this.prisma.examAnalysisReport.upsert({
      where: { attemptId },
      create: {
        examId: attempt.examId,
        examVersionId: attempt.examVersionId,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        status: 'EMAIL_QUEUED',
        emailStatus: 'QUEUED',
      },
      update: {
        status: 'EMAIL_QUEUED',
        emailStatus: 'QUEUED',
      },
    });

    const adminId = adminUser?.userId || adminUser?.id || null;

    // Idempotency: create or update Notification record
    const idempotencyKey = `report-email:${examId}:${attemptId}:${Date.now()}`;
    const notification = await this.prisma.notification.create({
      data: {
        userId: attempt.student.userId,
        recipientUserId: attempt.student.userId,
        recipientAddress: recipientEmail,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.REPORT_READY,
        title: `Brainros Exam Report - ${attempt.exam.title}`,
        message: `Your performance report for ${attempt.exam.title} is attached.`,
        status: NotificationStatus.PENDING,
        correlationId: attemptId,
        idempotencyKey,
        data: {
          examId,
          attemptId,
          studentId: attempt.studentId,
          requestedByAdminId: adminId,
        },
      },
    });

    // Add BullMQ Job with resilient fallback if queue/Redis is unavailable
    let jobId = `report_email_${attemptId}_${Date.now()}`;
    try {
      const job = await this.emailReportQueue.add(
        'send-student-report-email',
        {
          notificationId: notification.id,
          examId,
          attemptId,
          studentId: attempt.studentId,
          recipientEmail,
          requestedByAdminId: adminId,
          reportType: 'EXAM_ANALYSIS',
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3000,
          },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      );
      if (job?.id) {
        jobId = job.id;
      }
    } catch (queueErr: any) {
      this.logger.warn(
        `[CompletedExamReportsService] Queue service unavailable (${queueErr.message || queueErr}). Falling back to asynchronous direct email dispatch.`,
      );

      // Asynchronous direct dispatch without blocking HTTP response
      setImmediate(async () => {
        try {
          const processor = this.moduleRef?.get(ExamReportEmailProcessor, { strict: false });
          if (processor) {
            await processor.process({
              id: jobId,
              name: 'send-student-report-email',
              data: {
                notificationId: notification.id,
                examId,
                attemptId,
                studentId: attempt.studentId,
                recipientEmail,
                requestedByAdminId: adminId,
                reportType: 'EXAM_ANALYSIS',
              },
            } as any);
          }
        } catch (dispatchErr: any) {
          this.logger.error(
            `[CompletedExamReportsService] Direct report email dispatch failed: ${dispatchErr.message || dispatchErr}`,
          );
        }
      });
    }

    // Audit Log
    await this.auditLogService.logAction({
      actorUserId: adminId,
      action: 'EXAM_REPORT_EMAIL_REQUESTED',
      entityType: 'Attempt',
      entityId: attemptId,
      metadata: {
        examId,
        studentId: attempt.studentId,
        recipientEmail,
        jobId,
      },
    });

    this.logger.log(
      `[CompletedExamReportsService] Dispatched report email job '${jobId}' for student '${recipientEmail}' on attempt '${attemptId}'`,
    );

    return {
      success: true,
      message: 'Report queued for email delivery.',
      status: 'QUEUED',
      jobId,
      recipientEmail,
    };
  }

  /**
   * Enqueues a BullMQ job to send the student analysis report to the student's registered Institute/School.
   */
  async queueReportToInstituteEmail(examId: string, attemptId: string, adminUser: any) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        exam: {
          include: {
            resultPublications: { take: 1, orderBy: { createdAt: 'desc' } },
          },
        },
        student: {
          include: {
            user: { select: { id: true, email: true, phone: true } },
            institution: true,
          },
        },
        result: true,
      },
    });

    if (!attempt) {
      throw new NotFoundException('Student analysis report is not available.');
    }

    if (attempt.examId !== examId) {
      throw new BadRequestException('The requested attempt does not belong to the specified exam.');
    }

    if (!attempt.result) {
      throw new BadRequestException('Student analysis report is not available.');
    }

    const institution = attempt.student.institution;
    if (!institution || !institution.email || !institution.email.trim() || !institution.email.includes('@')) {
      throw new BadRequestException('Institute email is not configured for this student.');
    }

    const recipientEmail = institution.email.trim();
    const adminId = adminUser?.userId || adminUser?.id || null;

    // Idempotency: create Notification record for institute dispatch
    const idempotencyKey = `report-inst-email:${examId}:${attemptId}:${Date.now()}`;
    const notification = await this.prisma.notification.create({
      data: {
        userId: attempt.student.userId,
        recipientUserId: attempt.student.userId,
        recipientAddress: recipientEmail,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.REPORT_READY,
        title: `Student Analysis Report - ${attempt.student.name} - ${attempt.exam.title}`,
        message: `Student analysis report for ${attempt.student.name} on ${attempt.exam.title}`,
        status: NotificationStatus.PENDING,
        correlationId: attemptId,
        idempotencyKey,
        data: {
          examId,
          attemptId,
          studentId: attempt.studentId,
          institutionId: institution.id,
          recipientType: 'INSTITUTE',
          requestedByAdminId: adminId,
        },
      },
    });

    let jobId = `report_inst_email_${attemptId}_${Date.now()}`;
    try {
      const job = await this.emailReportQueue.add(
        'send-student-report-email',
        {
          notificationId: notification.id,
          examId,
          attemptId,
          studentId: attempt.studentId,
          recipientEmail,
          recipientType: 'INSTITUTE',
          institutionId: institution.id,
          institutionName: institution.name,
          requestedByAdminId: adminId,
          reportType: 'EXAM_ANALYSIS_INSTITUTE',
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3000,
          },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      );
      if (job?.id) {
        jobId = job.id;
      }
    } catch (queueErr: any) {
      this.logger.warn(
        `[CompletedExamReportsService] Queue service unavailable (${queueErr.message || queueErr}). Falling back to asynchronous direct email dispatch.`,
      );

      setImmediate(async () => {
        try {
          const processor = this.moduleRef?.get(ExamReportEmailProcessor, { strict: false });
          if (processor) {
            await processor.process({
              id: jobId,
              name: 'send-student-report-email',
              data: {
                notificationId: notification.id,
                examId,
                attemptId,
                studentId: attempt.studentId,
                recipientEmail,
                recipientType: 'INSTITUTE',
                institutionId: institution.id,
                institutionName: institution.name,
                requestedByAdminId: adminId,
                reportType: 'EXAM_ANALYSIS_INSTITUTE',
              },
            } as any);
          }
        } catch (dispatchErr: any) {
          this.logger.error(
            `[CompletedExamReportsService] Direct institute report email dispatch failed: ${dispatchErr.message || dispatchErr}`,
          );
        }
      });
    }

    // Audit Log
    await this.auditLogService.logAction({
      actorUserId: adminId,
      action: 'EXAM_REPORT_INSTITUTE_EMAIL_REQUESTED',
      entityType: 'Attempt',
      entityId: attemptId,
      metadata: {
        examId,
        studentId: attempt.studentId,
        institutionId: institution.id,
        institutionName: institution.name,
        recipientEmail,
        jobId,
      },
    });

    this.logger.log(
      `[CompletedExamReportsService] Dispatched report email job '${jobId}' for institute '${institution.name}' (${recipientEmail}) on attempt '${attemptId}'`,
    );

    return {
      success: true,
      message: 'Student analysis report has been queued for sending to the institute.',
      status: 'QUEUED',
      jobId,
      recipientEmail,
      institutionName: institution.name,
    };
  }

  /**
   * Returns the latest email delivery status for an attempt.
   */
  async getReportEmailStatus(examId: string, attemptId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        type: NotificationType.REPORT_READY,
        correlationId: attemptId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        logs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!notification) {
      return {
        status: 'NONE',
        sentAt: null,
        messageId: null,
        error: null,
      };
    }

    const latestLog = notification.logs[0];

    return {
      notificationId: notification.id,
      status: notification.status,
      sentAt: notification.sentAt,
      messageId: latestLog?.providerMessageId || null,
      error: notification.lastError || latestLog?.errorMessage || null,
      recipient: notification.recipientAddress,
    };
  }

  /**
   * Dispatches PDF reports for ALL evaluated student attendees for a given Live Exam.
   * Tracks real-time batch progress via JobProgressService / WebSocket.
   */
  async sendAllReportEmails(examId: string, adminUser: any) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    // Removed Mock Test check to allow mock tests in the dashboard

    // Find all evaluated attempts for this exam with valid student emails
    const attempts = await this.prisma.attempt.findMany({
      where: {
        examId,
        result: {
          isNot: null,
        },
      },
      include: {
        student: {
          include: {
            user: { select: { id: true, email: true, phone: true } },
          },
        },
        result: true,
      },
      orderBy: { submittedAt: 'asc' },
    });

    const eligibleAttempts = attempts.filter((att) => {
      const email = att.student?.user?.email;
      return email && email.includes('@');
    });

    if (eligibleAttempts.length === 0) {
      throw new BadRequestException(
        'No evaluated attendees with valid registered email addresses found for this exam.',
      );
    }

    const totalCount = eligibleAttempts.length;
    const adminId = adminUser?.userId || adminUser?.id || null;
    const batchJobId = `bulk_report_email_${examId}_${Date.now()}`;

    // Publish start of bulk dispatch job
    await this.jobProgressService.publishStarted(
      'bulk-exam-report-email',
      batchJobId,
      {
        type: 'BULK_REPORT_EMAIL_DISPATCH',
        stage: 'QUEUEING_REPORTS',
        examId,
        userId: adminId,
        totalRecords: totalCount,
        message: `Starting bulk email dispatch for ${totalCount} attendees...`,
      },
    );

    this.logger.log(
      `[CompletedExamReportsService] Initiating bulk report email batch '${batchJobId}' for exam '${examId}' (${totalCount} candidates)`,
    );

    // Asynchronously queue individual jobs to keep the HTTP response instant while updating WebSocket progress
    setImmediate(async () => {
      let queuedCount = 0;
      const processor = this.moduleRef?.get(ExamReportEmailProcessor, { strict: false });

      for (let i = 0; i < eligibleAttempts.length; i++) {
        const attempt = eligibleAttempts[i];
        const rawEmail = attempt.student?.user?.email;
        if (!rawEmail) continue;
        const recipientEmail = rawEmail.trim();

        try {
          // Upsert ExamAnalysisReport status
          await this.prisma.examAnalysisReport.upsert({
            where: { attemptId: attempt.id },
            create: {
              examId: attempt.examId,
              examVersionId: attempt.examVersionId,
              attemptId: attempt.id,
              studentId: attempt.studentId,
              status: 'EMAIL_QUEUED',
              emailStatus: 'QUEUED',
            },
            update: {
              status: 'EMAIL_QUEUED',
              emailStatus: 'QUEUED',
            },
          });

          // Create Notification
          const idempotencyKey = `report-email:${examId}:${attempt.id}:${Date.now()}`;
          const notification = await this.prisma.notification.create({
            data: {
              userId: attempt.student.userId,
              recipientUserId: attempt.student.userId,
              recipientAddress: recipientEmail,
              channel: NotificationChannel.EMAIL,
              type: NotificationType.REPORT_READY,
              title: `Brainros Exam Report - ${exam.title}`,
              message: `Your performance report for ${exam.title} is attached.`,
              status: NotificationStatus.PENDING,
              correlationId: attempt.id,
              idempotencyKey,
              data: {
                examId,
                attemptId: attempt.id,
                studentId: attempt.studentId,
                requestedByAdminId: adminId,
                batchJobId,
              },
            },
          });

          // Add to BullMQ queue or fallback
          let singleJobId = `report_email_${attempt.id}_${Date.now()}`;
          try {
            const job = await this.emailReportQueue.add(
              'send-student-report-email',
              {
                notificationId: notification.id,
                examId,
                attemptId: attempt.id,
                studentId: attempt.studentId,
                recipientEmail,
                requestedByAdminId: adminId,
                reportType: 'EXAM_ANALYSIS',
              },
              {
                attempts: 3,
                backoff: { type: 'exponential', delay: 3000 },
                removeOnComplete: 100,
                removeOnFail: 200,
              },
            );
            if (job?.id) singleJobId = job.id;
          } catch {
            // Queue fallback
            if (processor) {
              processor.process({
                id: singleJobId,
                name: 'send-student-report-email',
                data: {
                  notificationId: notification.id,
                  examId,
                  attemptId: attempt.id,
                  studentId: attempt.studentId,
                  recipientEmail,
                  requestedByAdminId: adminId,
                  reportType: 'EXAM_ANALYSIS',
                },
              } as any).catch((e: any) =>
                this.logger.warn(`Bulk fallback dispatch error: ${e?.message}`)
              );
            }
          }

          queuedCount++;
        } catch (itemErr: any) {
          this.logger.error(
            `[CompletedExamReportsService] Failed to queue report for attempt ${attempt.id}: ${itemErr.message}`,
          );
        }

        // Emit incremental progress over WebSocket
        const currentProgress = i + 1;
        await this.jobProgressService.publishProgress(
          'bulk-exam-report-email',
          batchJobId,
          {
            current: currentProgress,
            total: totalCount,
            percentage: Math.round((currentProgress / totalCount) * 100),
            stage: 'ENQUEUED',
            examId,
            userId: adminId,
            message: `Queued ${currentProgress} of ${totalCount} attendee reports...`,
          },
        );
      }

      // Final complete notification
      await this.jobProgressService.publishCompleted(
        'bulk-exam-report-email',
        batchJobId,
        {
          message: `Successfully queued ${queuedCount} of ${totalCount} student report emails.`,
          totalProcessed: queuedCount,
          examId,
          userId: adminId,
          resultSummary: {
            totalEligible: totalCount,
            queuedSuccessfully: queuedCount,
          },
        },
      );
    });

    // Audit Log
    await this.auditLogService.logAction({
      actorUserId: adminId,
      action: 'BULK_EXAM_REPORT_EMAILS_REQUESTED',
      entityType: 'Exam',
      entityId: examId,
      metadata: {
        examId,
        batchJobId,
        totalEligibleAttendees: totalCount,
      },
    });

    return {
      success: true,
      jobId: batchJobId,
      queue: 'bulk-exam-report-email',
      totalAttendees: totalCount,
      message: `Bulk report email dispatch initiated for ${totalCount} attendees.`,
    };
  }
}

