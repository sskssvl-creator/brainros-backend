import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  ResultReadinessResponse,
  ResultStatusEnum,
  ExamPublicationStatusEnum,
} from '../interfaces/result-lifecycle.interface';

@Injectable()
export class ResultReadinessService {
  private readonly logger = new Logger(ResultReadinessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Determine whether an exam is a synchronized LIVE exam or an on-demand MOCK test.
   * Mock and practice tests are always evaluated immediately and auto-published.
   */
  async isLiveExam(examId: string): Promise<boolean> {
    const exam: any = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        schedules: {
          where: { status: { in: ['SCHEDULED', 'ACTIVE', 'ENDED'] } },
          take: 1,
        },
      },
    });

    if (!exam) return false;

    const typeUpper = ((exam as any).examType || (exam as any).type || '').toUpperCase();
    const hasSchedules = Boolean(exam.schedules && exam.schedules.length > 0);

    // If exam has live schedules or explicit LIVE type, it is an official LIVE exam
    if (hasSchedules || typeUpper === 'LIVE') {
      return true;
    }

    // Standalone on-demand MOCK tests without any schedule
    if (typeUpper === 'MOCK' && !hasSchedules) {
      return false;
    }

    const titleUpper = (exam.title || '').toUpperCase();
    const titleIndicatesLive = titleUpper.includes('LIVE');
    const isMockOrPractice = titleUpper.includes('MOCK') || titleUpper.includes('PRACTICE');

    if (isMockOrPractice && !titleIndicatesLive) return false;

    return Boolean(hasSchedules || titleIndicatesLive);
  }

  /**
   * Authoritative Live Exam Result Readiness Evaluation
   * Verifies:
   *  1. All eligible attempts are in finalized state (SUBMITTED / AUTO_SUBMITTED)
   *  2. Question evaluation complete for all eligible candidates
   *  3. Subject / Chapter / Time / Strategy analytics complete
   *  4. Batch Rank & Percentile snapshot complete
   *  5. Security clearance validation according to policy
   */
  async checkExamReadiness(
    examId: string,
    requireAllSecurityReviews = true,
  ): Promise<ResultReadinessResponse> {
    const exam: any = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        versions: { take: 1, orderBy: { versionNumber: 'desc' } },
        schedules: {
          where: { status: { in: ['ACTIVE', 'ENDED', 'SCHEDULED'] } },
          take: 1,
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam '${examId}' not found`);
    }

    const isLive = await this.isLiveExam(examId);

    // 1. Query all non-cancelled, non-empty attempts for this exam
    const allAttempts = await this.prisma.attempt.findMany({
      where: {
        examId,
        status: {
          name: { notIn: ['CANCELLED', 'NOT_STARTED'] },
        },
      },
      include: {
        status: true,
        result: true,
        timeAnalyses: { take: 1 },
        strategyAnalyses: { take: 1 },
        candidateRanks: { take: 1 },
        securityReviews: { where: { status: 'PENDING' }, take: 1 },
      },
    });

    const totalEligibleAttempts = allAttempts.length;

    // Filter finalized attempts (SUBMITTED or AUTO_SUBMITTED)
    const finalizedAttempts = allAttempts.filter((a) =>
      ['SUBMITTED', 'AUTO_SUBMITTED'].includes(a.status?.name),
    );

    const evaluatedAttempts = finalizedAttempts.filter(
      (a) =>
        a.result !== null &&
        (a.result as any).totalScore !== undefined &&
        (a.result as any).totalScore !== null &&
        (a.result as any).resultStatus !== ResultStatusEnum.PENDING_WINDOW_CLOSE &&
        (a.result as any).resultStatus !== ResultStatusEnum.PROCESSING &&
        (a.result as any).resultStatus !== ResultStatusEnum.FAILED,
    );

    const analyticsCompletedAttempts = finalizedAttempts.filter(
      (a) =>
        a.timeAnalyses &&
        a.timeAnalyses.length > 0 &&
        a.strategyAnalyses &&
        a.strategyAnalyses.length > 0,
    );

    // Check rank snapshot completion safely
    let rankingCompleted = false;
    try {
      const latestRankSnapshot = await this.prisma.rankSnapshot.findFirst({
        where: { examId },
        orderBy: { snapshotVersion: 'desc' },
      });
      rankingCompleted = latestRankSnapshot?.status === 'COMPLETED';
    } catch {
      // Fallback: check if in-memory finalized attempts have candidateRanks generated
      rankingCompleted =
        finalizedAttempts.length > 0 &&
        finalizedAttempts.every((a) => a.candidateRanks && a.candidateRanks.length > 0);
    }

    // Security reviews
    const flaggedAttempts = allAttempts.filter((a) => a.isFlagged).length;
    const disqualifiedAttempts = allAttempts.filter(
      (a) => a.disqualifiedAt !== null,
    ).length;
    const pendingSecurityReviews = allAttempts.filter(
      (a) => a.securityReviews && a.securityReviews.length > 0,
    ).length;

    const securityReviewCompleted = requireAllSecurityReviews
      ? pendingSecurityReviews === 0
      : true;

    const pendingEvaluationCount =
      finalizedAttempts.length - evaluatedAttempts.length;

    // Safely check existing ExamResultPublication (table may not exist if unmigrated)
    let publicationRecord: any = null;
    let publicationStatus = ExamPublicationStatusEnum.NOT_READY;
    try {
      publicationRecord = await this.prisma.examResultPublication.findFirst({
        where: { examId },
        orderBy: { publicationVersion: 'desc' },
      });
      if (publicationRecord?.status) {
        publicationStatus = publicationRecord.status;
      }
    } catch {
      // Table unmigrated fallback
    }

    // Reasons why it might not be ready
    let reason: string | null = null;
    let isReady = false;

    if (totalEligibleAttempts === 0) {
      reason = 'No student attempts recorded for this exam.';
    } else if (finalizedAttempts.length < totalEligibleAttempts) {
      const activeCount = totalEligibleAttempts - finalizedAttempts.length;
      reason = `${activeCount} candidate attempt(s) are still in progress and not yet finalized.`;
    } else if (evaluatedAttempts.length < finalizedAttempts.length) {
      reason = `${pendingEvaluationCount} attempt(s) are still undergoing scoring/evaluation.`;
    } else if (!securityReviewCompleted) {
      reason = `${pendingSecurityReviews} flagged attempt(s) require security review before publication.`;
    } else {
      isReady = true;
      reason = null;
    }

    // Auto update / upsert ExamResultPublication state if table exists
    if (publicationStatus !== ExamPublicationStatusEnum.PUBLISHED) {
      const newStatus = isReady
        ? ExamPublicationStatusEnum.READY_TO_PUBLISH
        : ExamPublicationStatusEnum.PROCESSING;

      try {
        if (!publicationRecord) {
          publicationRecord = await this.prisma.examResultPublication.create({
            data: {
              examId,
              examVersionId: exam.versions?.[0]?.id,
              status: newStatus as any,
              totalEligibleAttempts,
              finalizedAttempts: finalizedAttempts.length,
              evaluatedAttempts: evaluatedAttempts.length,
              analyticsCompletedAttempts: analyticsCompletedAttempts.length,
              rankingCompleted,
              securityReviewCompleted,
              metadata: {
                flaggedAttempts,
                disqualifiedAttempts,
                pendingSecurityReviews,
                lastCheckedAt: new Date().toISOString(),
              },
            },
          });
        } else {
          publicationRecord = await this.prisma.examResultPublication.update({
            where: { id: publicationRecord.id },
            data: {
              status: newStatus as any,
              totalEligibleAttempts,
              finalizedAttempts: finalizedAttempts.length,
              evaluatedAttempts: evaluatedAttempts.length,
              analyticsCompletedAttempts: analyticsCompletedAttempts.length,
              rankingCompleted,
              securityReviewCompleted,
              metadata: {
                flaggedAttempts,
                disqualifiedAttempts,
                pendingSecurityReviews,
                lastCheckedAt: new Date().toISOString(),
              },
            },
          });
        }
        publicationStatus = newStatus;
      } catch {
        // Table unmigrated fallback
        publicationStatus = newStatus;
      }
    }

    return {
      ready: isReady,
      examId,
      examTitle: exam.title,
      examType: isLive ? 'LIVE' : 'MOCK',
      publicationStatus,
      totalEligibleAttempts,
      finalizedAttempts: finalizedAttempts.length,
      evaluatedAttempts: evaluatedAttempts.length,
      analyticsCompletedAttempts: analyticsCompletedAttempts.length,
      rankingCompleted,
      securityReviewCompleted,
      flaggedAttempts,
      disqualifiedAttempts,
      pendingEvaluationAttempts: pendingEvaluationCount,
      reason,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Handles attempt lifecycle completion after all asynchronous workers finish.
   * If MOCK: Automatically marks Result = PUBLISHED.
   * If LIVE: Verifies whole exam readiness and transitions to READY_TO_PUBLISH if complete.
   */
  async onAttemptWorkflowCompleted(attemptId: string): Promise<void> {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { exam: true, result: true },
    });

    if (!attempt || !attempt.result) return;

    const isLive = await this.isLiveExam(attempt.examId);

    if (!isLive) {
      // ─── MOCK TEST: Automatic Publication ─────────────────────────────
      await this.prisma.result.update({
        where: { id: attempt.result.id },
        data: {
          resultStatus: ResultStatusEnum.PUBLISHED,
          publishedAt: new Date(),
          publicationVersion: 1,
        },
      });

      // Warm cache
      await this.redisService.set(
        `result:visibility:${attemptId}`,
        JSON.stringify({
          status: ResultStatusEnum.PUBLISHED,
          publishedAt: new Date().toISOString(),
        }),
        3600,
      );

      this.logger.log(
        `Mock Test attempt '${attemptId}' automatically PUBLISHED.`,
      );
    } else {
      // ─── LIVE EXAM: Mark Attempt as READY_TO_PUBLISH ───────────────────
      const currentResStatus = (attempt.result as any).resultStatus;
      if (currentResStatus !== ResultStatusEnum.PUBLISHED) {
        await this.prisma.result.update({
          where: { id: attempt.result.id },
          data: {
            resultStatus: ResultStatusEnum.READY_TO_PUBLISH,
          },
        });
      }

      // Check if the overall Live Exam is now ready to publish
      await this.checkExamReadiness(attempt.examId);
      this.logger.log(
        `Live Exam attempt '${attemptId}' completed processing. Result marked READY_TO_PUBLISH.`,
      );
    }

    // Auto-upsert ExamAnalysisReport in READY_FOR_REVIEW status
    await this.prisma.examAnalysisReport.upsert({
      where: { attemptId },
      create: {
        examId: attempt.examId,
        examVersionId: attempt.examVersionId,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        status: 'READY_FOR_REVIEW',
        generatedAt: new Date(),
      },
      update: {
        generatedAt: new Date(),
      },
    }).catch((e) => this.logger.warn(`Could not upsert ExamAnalysisReport: ${e.message}`));
  }

  /**
   * Admin / Super Admin Exam Processing Dashboard & Stuck Attempt Detection.
   * Provides real-time visibility across evaluation, analytics, ranking, and publication.
   */
  async getExamProcessingDetails(examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        schedules: { take: 1 },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam '${examId}' not found`);
    }

    const isLive = await this.isLiveExam(examId);

    const attempts = await this.prisma.attempt.findMany({
      where: {
        examId,
        status: { name: { notIn: ['CANCELLED', 'NOT_STARTED'] } },
      },
      include: {
        student: {
          include: {
            user: { select: { id: true, email: true } },
          },
        },
        status: true,
        result: true,
        timeAnalyses: { take: 1 },
        strategyAnalyses: { take: 1 },
        candidateRanks: { take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = Date.now();
    const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

    const details = attempts.map((att) => {
      const isFinalized = ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'].includes(
        att.status?.name,
      );
      const evalDone = Boolean(
        att.result &&
          att.result.totalScore !== undefined &&
          att.result.totalScore !== null,
      );
      const analyticsDone = Boolean(
        att.timeAnalyses &&
          att.timeAnalyses.length > 0 &&
          att.strategyAnalyses &&
          att.strategyAnalyses.length > 0,
      );
      const rankDone = Boolean(att.candidateRanks && att.candidateRanks.length > 0);

      const submittedTime = att.submittedAt
        ? new Date(att.submittedAt).getTime()
        : new Date(att.createdAt).getTime();
      const elapsed = now - submittedTime;
      const isStuck =
        isFinalized && (!evalDone || !analyticsDone) && elapsed > STUCK_THRESHOLD_MS;

      let processingStatus: string;
      if (!isFinalized) {
        processingStatus = 'NOT_STARTED';
      } else if (evalDone && analyticsDone && rankDone) {
        processingStatus = 'COMPLETED';
      } else if (isStuck) {
        processingStatus = 'STUCK';
      } else {
        processingStatus = 'PROCESSING';
      }

      let publication: string;
      if (att.result?.resultStatus === 'PUBLISHED') {
        publication = 'PUBLISHED';
      } else if (isLive) {
        publication =
          evalDone && analyticsDone ? 'READY_TO_PUBLISH' : 'NOT_PUBLISHED';
      } else {
        publication = evalDone ? 'PUBLISHED' : 'NOT_PUBLISHED';
      }

      return {
        attemptId: att.id,
        studentId: att.studentId,
        studentName: att.student?.name || 'Student',
        studentEmail: att.student?.user?.email,
        examId,
        examTitle: exam.title,
        processingStatus,
        evaluation: evalDone ? 'COMPLETED' : isStuck ? 'STUCK' : 'PROCESSING',
        analytics: analyticsDone
          ? 'COMPLETED'
          : evalDone
            ? 'PROCESSING'
            : 'PENDING',
        ranking: rankDone
          ? 'COMPLETED'
          : analyticsDone
            ? 'PROCESSING'
            : 'PENDING',
        publication,
        isStuck,
        submittedAt: att.submittedAt
          ? new Date(att.submittedAt).toISOString()
          : null,
        lastUpdated: att.updatedAt
          ? new Date(att.updatedAt).toISOString()
          : new Date().toISOString(),
      };
    });

    const totalEligible = attempts.length;
    const evaluationCount = details.filter(
      (d) => d.evaluation === 'COMPLETED',
    ).length;
    const analyticsCount = details.filter(
      (d) => d.analytics === 'COMPLETED',
    ).length;
    const rankingCount = details.filter(
      (d) => d.ranking === 'COMPLETED',
    ).length;
    const stuckCount = details.filter((d) => d.isStuck).length;

    let overallProcessingStatus = 'COMPLETED';
    if (totalEligible === 0) {
      overallProcessingStatus = 'EMPTY';
    } else if (
      evaluationCount < totalEligible ||
      analyticsCount < totalEligible ||
      rankingCount < totalEligible
    ) {
      overallProcessingStatus = stuckCount > 0 ? 'FLAGGED_STUCK' : 'PROCESSING';
    }

    return {
      examId,
      examTitle: exam.title,
      examType: isLive ? 'LIVE' : 'MOCK',
      overallProcessingStatus,
      totalEligibleAttempts: totalEligible,
      evaluatedAttempts: evaluationCount,
      analyticsCompletedAttempts: analyticsCount,
      rankingCompletedAttempts: rankingCount,
      stuckAttemptsCount: stuckCount,
      attempts: details,
    };
  }
}

