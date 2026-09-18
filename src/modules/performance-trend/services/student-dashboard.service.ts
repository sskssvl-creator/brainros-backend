import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  StudentDashboardResponse,
  NextExamWidget,
  ActiveAttemptWidget,
  PerformanceSummaryWidget,
  RankSummaryWidget,
  PredictedRankWidget,
  SubjectSummaryItem,
  WeakAreaItem,
  DashboardRecommendationItem,
  TimeManagementWidget,
  AttemptStrategyWidget,
  RecentResultItem,
} from '../interfaces/student-dashboard.interface';

import { RecommendationEngineService } from '../../recommendation/services/recommendation-engine.service';
import { StudentTargetPredictionService } from '../../predicted-rank/services/student-target-prediction.service';
import { resolveEligibleExamTypes } from '../../../common/constants/target-exam.constant';

@Injectable()
export class StudentDashboardService {
  private readonly logger = new Logger(StudentDashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly recommendationEngine: RecommendationEngineService,
    private readonly targetPredictionService: StudentTargetPredictionService,
  ) {}

  /**
   * Aggregate complete Student Dashboard data in an optimized single entry point
   */
  async getStudentDashboard(userId: string, page: number = 1, limit: number = 5): Promise<StudentDashboardResponse> {
    const cacheKey = `student:${userId}:dashboard:page:${page}:limit:${limit}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Ignore cache failure, proceed with DB query
    }

    // 1. Fetch Student Profile with Target, Class, and Language
    const student: any = await this.prisma.student.findFirst({
      where: { OR: [{ userId }, { id: userId }] },
      include: {
        user: { select: { id: true, email: true, mobileNumber: true } },
        examTarget: { select: { id: true, name: true } },
        studentExamTargets: { include: { examTarget: true } },
        studentClass: { select: { id: true, name: true } },
        preferredLanguage: { select: { id: true, name: true } },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student profile not found for user '${userId}'`);
    }

    const studentId = student.id;
    const now = new Date();

    // 2. Fetch Active/Ongoing Attempt (if student has an in-progress exam)
    const activeAttemptRecord = await this.prisma.attempt.findFirst({
      where: {
        studentId,
        status: { name: 'IN_PROGRESS' },
      },
      include: {
        exam: { select: { id: true, title: true, durationMinutes: true, totalQuestions: true } },
        answers: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    let activeAttempt: ActiveAttemptWidget | null = null;
    if (activeAttemptRecord) {
      const startedAt = activeAttemptRecord.startedAt || activeAttemptRecord.createdAt;
      const durationMs = (activeAttemptRecord.exam.durationMinutes || 180) * 60 * 1000;
      const expectedEnd = activeAttemptRecord.serverEndTime
        ? new Date(activeAttemptRecord.serverEndTime).getTime()
        : new Date(startedAt).getTime() + durationMs;

      const remainingSec = Math.max(0, Math.ceil((expectedEnd - now.getTime()) / 1000));

      activeAttempt = {
        attemptId: activeAttemptRecord.id,
        examId: activeAttemptRecord.exam.id,
        examTitle: activeAttemptRecord.exam.title,
        startedAt: startedAt.toISOString(),
        serverEndTime: activeAttemptRecord.serverEndTime
          ? new Date(activeAttemptRecord.serverEndTime).toISOString()
          : new Date(expectedEnd).toISOString(),
        timeRemainingSeconds: remainingSec,
        currentQuestionNumber: (activeAttemptRecord.answers?.length || 0) + 1,
        totalQuestions: activeAttemptRecord.exam.totalQuestions || 180,
        answeredCount: activeAttemptRecord.answers?.length || 0,
      };
    }

    // Resolve eligible actual exam target IDs
    const rawTargetNames: string[] = [];
    if (student.examTarget?.name) rawTargetNames.push(student.examTarget.name);
    if (Array.isArray(student.studentExamTargets)) {
      student.studentExamTargets.forEach((st: any) => {
        if (st.examTarget?.name) rawTargetNames.push(st.examTarget.name);
      });
    }

    const eligibleExamTypeNames = new Set<string>();
    for (const name of rawTargetNames) {
      const resolved = resolveEligibleExamTypes(name);
      resolved.forEach((t) => eligibleExamTypeNames.add(t));
    }

    const directIds = [
      ...(student.examTargetId ? [student.examTargetId] : []),
      ...(student.studentExamTargets?.map((st: any) => st.examTargetId) || []),
    ];

    const matchingTargets = await this.prisma.examTarget.findMany({
      where: {
        OR: [
          { name: { in: Array.from(eligibleExamTypeNames) } },
          { id: { in: directIds } },
        ],
      },
      select: { id: true },
    });

    const targetIds = Array.from(
      new Set([...matchingTargets.map((t) => t.id), ...directIds]),
    );

    // 3. Fetch Upcoming / Live Exams for Student's Target
    const upcomingExamRecords = await this.prisma.exam.findMany({
      where: {
        status: { name: { in: ['SCHEDULED', 'ACTIVE'] } },
        ...(targetIds.length > 0
          ? {
              OR: [
                { examTargetId: { in: targetIds } },
                { examTarget: { name: 'General' } },
              ],
            }
          : {}),
        // Filter out expired exams so upcoming and live exams are prioritized
        AND: [
          {
            OR: [
              { endTime: { gt: now } },
              { schedules: { some: { status: { in: ['SCHEDULED', 'ACTIVE'] }, endTime: { gt: now } } } },
            ],
          },
        ],
        NOT: {
          attempts: {
            some: {
              studentId,
              status: { name: { in: ['EVALUATED', 'SUBMITTED', 'AUTO_SUBMITTED'] } },
            },
          },
        },
      },
      include: {
        examTarget: { select: { id: true, name: true } },
        status: { select: { id: true, name: true } },
        schedules: {
          where: { status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED'] }, endTime: { gt: now } },
          orderBy: [{ updatedAt: 'desc' }, { startTime: 'asc' }],
          take: 1,
        },
      },
      orderBy: [{ startTime: 'asc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });

    const upcomingExams: NextExamWidget[] = upcomingExamRecords
      .map((rec) => {
        const schedule = rec.schedules?.[0];
        const startTime = schedule?.startTime || rec.startTime || rec.examDate;
        const endTime = schedule?.endTime || rec.endTime;

        let canStart = false;
        let waitSeconds = 0;
        let accessStatus = 'AVAILABLE';
        let message = 'Exam is ready to attempt.';
        let calculatedStatus: 'UPCOMING' | 'LIVE' | 'COMPLETED' = 'UPCOMING';

        if (startTime && now.getTime() < new Date(startTime).getTime()) {
          accessStatus = 'NOT_YET_STARTED';
          calculatedStatus = 'UPCOMING';
          waitSeconds = Math.ceil((new Date(startTime).getTime() - now.getTime()) / 1000);
          message = `Starts in ${Math.floor(waitSeconds / 3600)}h ${Math.floor((waitSeconds % 3600) / 60)}m`;
        } else if (endTime && now.getTime() >= new Date(endTime).getTime()) {
          accessStatus = 'ENDED';
          calculatedStatus = 'COMPLETED';
          canStart = false;
          message = 'Exam window closed.';
        } else {
          // startAt <= currentTime < endAt
          accessStatus = 'AVAILABLE';
          calculatedStatus = 'LIVE';
          canStart = true;
          message = 'Exam is live now!';
        }

        return {
          examId: rec.id,
          title: rec.title,
          examTarget: rec.examTarget?.name || student.examTarget?.name || 'General',
          durationMinutes: rec.durationMinutes,
          totalQuestions: rec.totalQuestions,
          totalMarks: rec.totalMarks,
          startTime: startTime ? new Date(startTime).toISOString() : null,
          endTime: endTime ? new Date(endTime).toISOString() : null,
          status: calculatedStatus,
          canStart,
          waitSeconds,
          accessStatus,
          message,
        };
      })
      // Only keep UPCOMING or LIVE exams in upcoming & live widget (do not show expired exams as live/upcoming)
      .filter((e) => e.accessStatus !== 'ENDED' && e.status !== 'COMPLETED');

    const nextExam = upcomingExams[0] || null;

    // 4. Fetch Evaluated Mocks (Latest 10 for trends & performance)
    const evaluatedAttempts: any[] = await this.prisma.attempt.findMany({
      where: {
        studentId,
        result: { isNot: null },
        status: { name: { in: ['EVALUATED', 'SUBMITTED', 'AUTO_SUBMITTED'] } },
      },
      include: {
        exam: { select: { id: true, title: true, totalMarks: true, examTarget: true } },
        result: {
          include: {
            subjectResults: {
              include: { subject: true },
            },
            chapterResults: {
              include: { chapter: { include: { subject: true } } },
            },
          },
        },
        candidateRanks: {
          orderBy: { createdAt: 'desc' },
        },
        timeAnalyses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        strategyAnalyses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' }, // Oldest to newest
    });

    const totalEvaluatedCount = evaluatedAttempts.length;
    const latestAttempt = totalEvaluatedCount > 0 ? evaluatedAttempts[totalEvaluatedCount - 1] : null;
    const previousAttempt = totalEvaluatedCount > 1 ? evaluatedAttempts[totalEvaluatedCount - 2] : null;

    // 5. Performance Summary
    let latestPerformance: PerformanceSummaryWidget | null = null;
    if (latestAttempt && latestAttempt.result) {
      const res = latestAttempt.result;
      latestPerformance = {
        latestScore: res.totalScore,
        maxScore: res.maxScore || latestAttempt.exam.totalMarks || 720,
        percentage: Math.round(Number(res.percentage || 0) * 100) / 100,
        accuracy: Math.round(Number(res.accuracy || 0) * 100) / 100,
        totalAttempts: totalEvaluatedCount,
        timeSpentSeconds: res.timeUsedSeconds || 0,
        correctCount: res.correctCount,
        incorrectCount: res.incorrectCount,
        unattemptedCount: res.unattemptedCount,
      };
    }

    // 6. Rank & Predicted Rank
    let rank: RankSummaryWidget | null = null;
    let predictedRank: PredictedRankWidget | null = null;

    if (latestAttempt) {
      const overallRank = latestAttempt.candidateRanks?.find((r) => r.rankType === 'OVERALL') || latestAttempt.candidateRanks?.[0];
      const stateRankRecord = latestAttempt.candidateRanks?.find((r) => r.rankType === 'STATE');
      const categoryRankRecord = latestAttempt.candidateRanks?.find((r) => r.rankType === 'CATEGORY');

      if (overallRank) {
        rank = {
          rank: overallRank.rank,
          totalCandidates: overallRank.totalCandidates,
          percentile: overallRank.percentile,
          stateRank: stateRankRecord ? stateRankRecord.rank : null,
          categoryRank: categoryRankRecord ? categoryRankRecord.rank : null,
        };
      }
    }

    // Fetch target-based predicted rank
    try {
      const targetPred = await this.targetPredictionService.getStudentTargetPrediction(userId);
      predictedRank = {
        available: targetPred.available,
        reason: targetPred.reason || null,
        targetExam: targetPred.targetExam || null,
        targetExamName: targetPred.targetExamName || null,
        predictedRank: targetPred.predictedRank || null,
        predictedRankMin: targetPred.rankRange?.min || null,
        predictedRankMax: targetPred.rankRange?.max || null,
        confidence: targetPred.confidence || null,
        confidenceScore: targetPred.confidenceScore || null,
        scoreUsed: targetPred.scoreUsed || null,
        normalizedPercentage: targetPred.normalizedPercentage || null,
        attemptsUsed: targetPred.attemptsUsed || 0,
        trend: targetPred.trend || null,
        modelVersion: targetPred.modelVersion || 'v1.0.0',
        explanation: targetPred.explanation || null,
        isEstimated: true,
      };
    } catch (err) {
      this.logger.warn(`Failed to get student target predicted rank: ${err.message}`);
      predictedRank = {
        available: false,
        reason: 'INSUFFICIENT_DATA',
        predictedRankMin: null,
        predictedRankMax: null,
        confidence: null,
        isEstimated: true,
      };
    }

    // 7. Subject Performance & Subject Trends
    const subjects: SubjectSummaryItem[] = [];
    if (latestAttempt && latestAttempt.result?.subjectResults) {
      const prevSubjectMap = new Map<string, number>();
      if (previousAttempt && previousAttempt.result?.subjectResults) {
        previousAttempt.result.subjectResults.forEach((sr) => {
          prevSubjectMap.set(sr.subject.name.toLowerCase(), sr.accuracy);
        });
      }

      latestAttempt.result.subjectResults.forEach((sr) => {
        const accuracy = sr.accuracy;
        const status: 'EXCELLENT' | 'GOOD' | 'WEAK' =
          accuracy >= 80 ? 'EXCELLENT' : accuracy >= 65 ? 'GOOD' : 'WEAK';

        const prevAcc = prevSubjectMap.get(sr.subject.name.toLowerCase());
        const trendDelta = prevAcc !== undefined ? Math.round((accuracy - prevAcc) * 10) / 10 : null;

        subjects.push({
          subjectId: sr.subjectId,
          subjectName: sr.subject.name,
          score: sr.score,
          maxScore: sr.maxScore,
          accuracy: Math.round(Number(accuracy || 0) * 100) / 100,
          status,
          trendDelta,
        });
      });
    }

    // 8. Weak Areas (Chapters/Topics with lowest accuracy < 70%)
    const weakAreas: WeakAreaItem[] = [];
    if (latestAttempt && latestAttempt.result?.chapterResults) {
      const allChapters: Array<{ subject: string; name: string; accuracy: number; total: number }> =
        latestAttempt.result.chapterResults.map((cr: any) => ({
          subject: cr.chapter?.subject?.name || 'General',
          name: cr.chapter?.name || 'Chapter',
          accuracy: Math.round(Number(cr.accuracy || 0) * 100) / 100,
          total: cr.totalQuestions,
        }));

      allChapters
        .filter((c) => c.accuracy < 70)
        .sort((a, b) => a.accuracy - b.accuracy)
        .slice(0, 4)
        .forEach((c) => {
          weakAreas.push({
            subjectName: c.subject,
            chapterName: c.name,
            accuracy: Math.round(Number(c.accuracy || 0) * 100) / 100,
            totalQuestions: c.total,
            status: c.accuracy < 50 ? 'WEAK' : 'NEEDS_FOCUS',
          });
        });
    }

    // 9. Time Management Widget
    let timeManagement: TimeManagementWidget | null = null;
    if (latestAttempt && latestAttempt.timeAnalyses?.[0]) {
      const ta = latestAttempt.timeAnalyses[0];
      timeManagement = {
        averageTimePerQuestionSeconds: ta.averageTimePerQuestionSeconds,
        timeUtilizationPercentage: ta.timeUtilizationPercentage,
        totalTimeUsedSeconds: ta.totalTimeUsedSeconds,
        status:
          ta.averageTimePerQuestionSeconds <= 60
            ? 'OPTIMAL'
            : ta.averageTimePerQuestionSeconds <= 85
              ? 'NEEDS_IMPROVEMENT'
              : 'SLOW',
      };
    } else if (latestAttempt && latestAttempt.result) {
      const res = latestAttempt.result;
      const avg = res.totalQuestions > 0 ? Math.round((res.timeUsedSeconds || 0) / res.totalQuestions) : 60;
      timeManagement = {
        averageTimePerQuestionSeconds: avg,
        timeUtilizationPercentage: 90,
        totalTimeUsedSeconds: res.timeUsedSeconds || 0,
        status: avg <= 65 ? 'OPTIMAL' : 'NEEDS_IMPROVEMENT',
      };
    }

    // 10. Attempt Strategy Widget
    let attemptStrategy: AttemptStrategyWidget | null = null;
    if (latestAttempt && latestAttempt.strategyAnalyses?.[0]) {
      const sa = latestAttempt.strategyAnalyses[0];
      attemptStrategy = {
        riskLevel: (sa.riskProfile as any) || 'MODERATE',
        highRiskAttemptsCount: sa.highRiskAttemptsCount || 0,
        avoidableNegativeMarks: sa.avoidableNegativeMarks || 0,
        scoreGainOpportunity: sa.scoreGainOpportunity || 0,
      };
    } else if (latestAttempt && latestAttempt.result) {
      const res = latestAttempt.result;
      const avoidable = (res.incorrectCount || 0) * (latestAttempt.exam.totalMarks > 300 ? 1 : 0.5);
      attemptStrategy = {
        riskLevel: res.accuracy >= 80 ? 'LOW' : res.accuracy >= 65 ? 'MODERATE' : 'HIGH',
        highRiskAttemptsCount: Math.round((res.incorrectCount || 0) * 0.6),
        avoidableNegativeMarks: Math.round(avoidable),
        scoreGainOpportunity: Math.round(avoidable * 1.5),
      };
    }

    // 11. Trend Summary & Chart Points
    const recentScores: Array<{ mockLabel: string; score: number; accuracy: number; rank: number | null; percentile: number | null }> = [];
    evaluatedAttempts.forEach((att, idx) => {
      const res = att.result;
      const r = att.candidateRanks?.find((x) => x.rankType === 'OVERALL') || att.candidateRanks?.[0];
      recentScores.push({
        mockLabel: `Mock ${idx + 1}`,
        score: res?.totalScore || 0,
        accuracy: Math.round(Number(res?.accuracy || 0) * 100) / 100,
        rank: r ? r.rank : null,
        percentile: r ? r.percentile : null,
      });
    });

    const calculateDirection = (arr: number[], lowerIsBetter = false) => {
      if (arr.length < 2) return 'INSUFFICIENT_DATA';
      const first = arr[0];
      const last = arr[arr.length - 1];
      if (lowerIsBetter) {
        return last < first ? 'IMPROVING' : last > first ? 'DECLINING' : 'STABLE';
      }
      return last > first ? 'IMPROVING' : last < first ? 'DECLINING' : 'STABLE';
    };

    const scoreArr = recentScores.map((s) => s.score);
    const accArr = recentScores.map((s) => s.accuracy);
    const rankArr = recentScores.filter((s) => s.rank !== null).map((s) => s.rank as number);
    const percArr = recentScores.filter((s) => s.percentile !== null).map((s) => s.percentile as number);

    const trendSummary = {
      scoreTrend: calculateDirection(scoreArr) as any,
      accuracyTrend: calculateDirection(accArr) as any,
      rankTrend: calculateDirection(rankArr, true) as any, // lower rank is better
      percentileTrend: calculateDirection(percArr) as any,
      recentScores,
    };

    // 12. Contextual Recommendations generated via RecommendationEngineService
    const engineRecs = await this.recommendationEngine.generateStudentRecommendations(
      student.id,
      {
        lookbackAttempts: 5,
        maxRecommendations: 4,
      },
    );

    const recommendations: DashboardRecommendationItem[] = engineRecs.map((rec) => {
      let uiType: 'WARNING' | 'OPPORTUNITY' | 'STRENGTH' | 'TIP' = 'WARNING';
      if (rec.type === 'STRONG_SUBJECT' || rec.type === 'IMPROVEMENT_TREND') {
        uiType = 'STRENGTH';
      } else if (rec.type === 'NEGATIVE_MARKING' || rec.type === 'OVER_ATTEMPTING' || rec.type === 'UNDER_ATTEMPTING') {
        uiType = 'OPPORTUNITY';
      } else if (rec.type === 'TIME_MANAGEMENT') {
        uiType = 'TIP';
      }

      return {
        id: rec.id,
        type: uiType,
        title: rec.title,
        message: rec.message,
        reason: rec.reason,
        priority: rec.priority,
        priorityScore: rec.priorityScore,
        confidence: rec.confidence,
        actionLabel: rec.action.label,
        actionType: rec.action.type,
        targetUrl: rec.action.targetUrl,
        mockTestId: rec.action.mockTestId,
        mockTestName: rec.action.mockTestTitle,
        subjectId: rec.subjectId,
        subjectName: rec.subjectName,
        chapterId: rec.chapterId,
        chapterName: rec.chapterName,
        metrics: rec.metrics,
      };
    });

    // 13. Recent Results Table (Paginated)
    const recentResultsData: RecentResultItem[] = [];
    const reversedEvaluated = [...evaluatedAttempts].reverse();
    const totalCompleted = reversedEvaluated.length;
    const startIndex = (page - 1) * limit;
    const paginatedEvaluated = reversedEvaluated.slice(startIndex, startIndex + limit);

    paginatedEvaluated.forEach((att) => {
      const res = att.result;
      const rankRecord = att.candidateRanks?.find((r) => r.rankType === 'OVERALL') || att.candidateRanks?.[0];
      recentResultsData.push({
        attemptId: att.id,
        examId: att.exam.id,
        examTitle: att.exam.title,
        examType: att.exam.examTarget?.name || student.examTarget?.name || 'NEET',
        date: att.serverEndTime
          ? new Date(att.serverEndTime).toISOString().split('T')[0]
          : new Date(att.createdAt).toISOString().split('T')[0],
        score: res?.totalScore || 0,
        maxScore: res?.maxScore || att.exam.totalMarks || 720,
        percentage: Math.round(Number(res?.percentage || 0) * 100) / 100,
        accuracy: Math.round(Number(res?.accuracy || 0) * 100) / 100,
        rank: rankRecord ? rankRecord.rank : null,
        totalCandidates: rankRecord ? rankRecord.totalCandidates : null,
        percentile: rankRecord ? rankRecord.percentile : null,
      });
    });

    const recentResults = {
      data: recentResultsData,
      meta: {
        total: totalCompleted,
        page,
        limit,
        totalPages: Math.ceil(totalCompleted / limit),
      },
    };

    // 14. Unread Notification Count
    const unreadCount = await this.prisma.notification.count({
      where: {
        OR: [{ userId }, { recipientUserId: userId }],
        isRead: false,
      },
    });

    const response: StudentDashboardResponse = {
      student: {
        studentId: student.studentId || student.studentCode || `BRN-${student.id.substring(0, 8).toUpperCase()}`,
        studentCode: student.studentCode,
        name: student.name || student.user?.name || 'Student',
        class: student.studentClass?.name || 'Class 12',
        examTarget: student.examTarget?.name || 'NEET',
        preferredLanguage: student.preferredLanguage?.name || 'English',
        email: student.user?.email,
        avatar: student.user?.avatarUrl,
      },
      nextExam,
      upcomingExams,
      activeAttempt,
      latestPerformance,
      rank,
      predictedRank,
      subjects,
      trendSummary,
      weakAreas,
      recommendations,
      timeManagement,
      attemptStrategy,
      recentResults,
      unreadNotificationCount: unreadCount,
    };

    // Cache in Redis for 5 seconds
    try {
      await this.redis.set(cacheKey, JSON.stringify(response), 5);
    } catch {
      // Ignore cache write error
    }

    return response;
  }
}
