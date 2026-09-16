import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PersonalizedRecommendation,
  RecommendationEngineOptions,
  RecommendationPriority,
  RecommendationConfidence,
} from '../interfaces/recommendation.interface';
import { resolveEligibleExamTypes } from '../../../common/constants/target-exam.constant';

const DEFAULT_OPTIONS: Required<RecommendationEngineOptions> = {
  lookbackAttempts: 5,
  minChapterQuestionsForHighConfidence: 5,
  minChapterQuestionsForAnalysis: 2,
  weakAccuracyThreshold: 55,
  criticalAccuracyThreshold: 40,
  strongAccuracyThreshold: 80,
  maxRecommendations: 4,
};

@Injectable()
export class RecommendationEngineService {
  private readonly logger = new Logger(RecommendationEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Main entrypoint: Generate prioritized, data-driven, personalized recommendations for a student
   */
  async generateStudentRecommendations(
    studentId: string,
    customOptions?: RecommendationEngineOptions,
  ): Promise<PersonalizedRecommendation[]> {
    const options: Required<RecommendationEngineOptions> = {
      ...DEFAULT_OPTIONS,
      ...customOptions,
    };

    // 1. Fetch student info and target exams
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        examTarget: true,
        studentExamTargets: { include: { examTarget: true } },
      },
    });

    if (!student) {
      return [];
    }

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

    // 2. Fetch completed evaluated attempts (latest N)
    const evaluatedAttempts: any[] = await this.prisma.attempt.findMany({
      where: {
        studentId,
        status: { name: 'COMPLETED' },
        result: { isNot: null },
      },
      include: {
        exam: {
          include: {
            examTarget: true,
            sections: { include: { subject: true } },
          },
        },
        result: {
          include: {
            subjectResults: { include: { subject: true } },
            chapterResults: { include: { chapter: { include: { subject: true } } } },
          },
        },
        answers: {
          include: {
            examQuestion: {
              include: {
                question: {
                  include: {
                    chapter: { include: { subject: true } },
                    options: true,
                  },
                },
              },
            },
          },
        },
        timeLogs: true,
      },
      orderBy: { submittedAt: 'desc' },
      take: options.lookbackAttempts,
    });

    if (evaluatedAttempts.length === 0) {
      return [];
    }

    const rawRecommendations: PersonalizedRecommendation[] = [];
    const latestAttempt = evaluatedAttempts[0];

    // 3. Subject-level Performance & Trend Extraction
    const subjectStatsMap = new Map<
      string,
      {
        subjectId: string;
        subjectName: string;
        totalQuestions: number;
        correctAnswers: number;
        wrongAnswers: number;
        accuracies: number[];
      }
    >();

    for (const att of evaluatedAttempts) {
      for (const sr of att.result?.subjectResults || []) {
        if (!sr.subject) continue;
        const sId = sr.subject.id;
        if (!subjectStatsMap.has(sId)) {
          subjectStatsMap.set(sId, {
            subjectId: sId,
            subjectName: sr.subject.name,
            totalQuestions: 0,
            correctAnswers: 0,
            wrongAnswers: 0,
            accuracies: [],
          });
        }
        const sEntry = subjectStatsMap.get(sId)!;
        sEntry.totalQuestions += sr.totalQuestions || 0;
        sEntry.correctAnswers += sr.correctAnswers || 0;
        sEntry.wrongAnswers += sr.wrongAnswers || 0;
        sEntry.accuracies.push(Number((sr.accuracy || 0).toFixed(1)));
      }
    }

    // 4. Chapter-level Performance Extraction across attempts
    const chapterStatsMap = new Map<
      string,
      {
        chapterId: string;
        chapterName: string;
        subjectId: string;
        subjectName: string;
        totalQuestions: number;
        correctAnswers: number;
        wrongAnswers: number;
        unattempted: number;
        recentAttemptCount: number;
      }
    >();

    for (const att of evaluatedAttempts) {
      // If ChapterResults exist on the Result
      if (att.result?.chapterResults && att.result.chapterResults.length > 0) {
        for (const cr of att.result.chapterResults) {
          if (!cr.chapter) continue;
          const cId = cr.chapter.id;
          if (!chapterStatsMap.has(cId)) {
            chapterStatsMap.set(cId, {
              chapterId: cId,
              chapterName: cr.chapter.name,
              subjectId: cr.chapter.subjectId,
              subjectName: cr.chapter.subject?.name || 'General',
              totalQuestions: 0,
              correctAnswers: 0,
              wrongAnswers: 0,
              unattempted: 0,
              recentAttemptCount: 0,
            });
          }
          const cEntry = chapterStatsMap.get(cId)!;
          cEntry.totalQuestions += cr.totalQuestions || 0;
          cEntry.correctAnswers += cr.correctAnswers || 0;
          cEntry.wrongAnswers += cr.wrongAnswers || 0;
          cEntry.unattempted += cr.unattempted || 0;
          cEntry.recentAttemptCount++;
        }
      } else {
        // Fallback: Group from student answers
        for (const ans of att.answers || []) {
          const q = ans.examQuestion?.question;
          const chap = q?.chapter;
          if (!chap) continue;
          const cId = chap.id;
          if (!chapterStatsMap.has(cId)) {
            chapterStatsMap.set(cId, {
              chapterId: cId,
              chapterName: chap.name,
              subjectId: chap.subjectId,
              subjectName: chap.subject?.name || 'General',
              totalQuestions: 0,
              correctAnswers: 0,
              wrongAnswers: 0,
              unattempted: 0,
              recentAttemptCount: 0,
            });
          }
          const cEntry = chapterStatsMap.get(cId)!;
          cEntry.totalQuestions++;
          const correctOpt = q.options?.find((o: any) => o.isCorrect);
          const isCorrect = ans.selectedOptionId && correctOpt && ans.selectedOptionId === correctOpt.id;
          if (isCorrect) {
            cEntry.correctAnswers++;
          } else if (ans.selectedOptionId || ans.numericalAnswer != null) {
            cEntry.wrongAnswers++;
          } else {
            cEntry.unattempted++;
          }
        }
      }
    }

    // 5. Generate Chapter-level Recommendations
    for (const chap of chapterStatsMap.values()) {
      if (chap.totalQuestions < options.minChapterQuestionsForAnalysis) {
        continue;
      }

      const accuracy =
        chap.totalQuestions > 0
          ? Math.round((chap.correctAnswers / chap.totalQuestions) * 100)
          : 0;

      if (accuracy < options.weakAccuracyThreshold) {
        const isCritical = accuracy < options.criticalAccuracyThreshold;
        const confidence: RecommendationConfidence =
          chap.totalQuestions >= options.minChapterQuestionsForHighConfidence
            ? 'HIGH'
            : chap.totalQuestions >= 3
              ? 'MEDIUM'
              : 'LOW';

        const priority: RecommendationPriority = isCritical
          ? confidence === 'HIGH'
            ? 'CRITICAL'
            : 'HIGH'
          : confidence === 'HIGH'
            ? 'HIGH'
            : 'MEDIUM';

        // Find matching subject mock test
        const mockTest = await this.findSubjectMockTest(chap.subjectId, targetIds);

        const potentialGain = chap.wrongAnswers * 4; // Standard 4 marks per question
        const priorityScore = this.calculatePriorityScore({
          severity: 100 - accuracy,
          sampleSize: chap.totalQuestions,
          potentialGain,
          isCritical,
          confidence,
        });

        const reason =
          confidence === 'LOW'
            ? `Preliminary data across ${chap.totalQuestions} questions indicates ${accuracy}% accuracy (${chap.wrongAnswers} incorrect). Reinforce core principles.`
            : `Your accuracy is ${accuracy}% across ${chap.totalQuestions} attempted questions with ${chap.wrongAnswers} incorrect. Immediate conceptual focus recommended.`;

        rawRecommendations.push({
          id: `rec-chap-${chap.chapterId}`,
          type: 'WEAK_CHAPTER',
          priority,
          priorityScore,
          confidence,
          title: `Focus on ${chap.chapterName}`,
          message: `Accuracy is ${accuracy}% in ${chap.chapterName} (${chap.subjectName}). Target this area with focused problem-solving.`,
          reason,
          subjectId: chap.subjectId,
          subjectName: chap.subjectName,
          chapterId: chap.chapterId,
          chapterName: chap.chapterName,
          metrics: {
            accuracy,
            sampleSize: chap.totalQuestions,
            wrongCount: chap.wrongAnswers,
            unattemptedCount: chap.unattempted,
            potentialScoreGain: potentialGain,
          },
          action: {
            type: 'PRACTICE_MOCK',
            label: mockTest
              ? `Practice ${chap.subjectName} Mock Test`
              : `Review ${chap.chapterName}`,
            targetUrl: mockTest
              ? `/student/mock-tests?mockTestId=${mockTest.id}`
              : `/student/mock-tests`,
            mockTestId: mockTest?.id || null,
            mockTestTitle: mockTest?.title || null,
          },
        });
      }
    }

    // 6. Generate Subject-level & Trend Recommendations
    const coveredSubjectIds = new Set(
      rawRecommendations.map((r) => r.subjectId).filter(Boolean),
    );

    for (const subj of subjectStatsMap.values()) {
      if (subj.totalQuestions < 5) continue;

      const overallAccuracy =
        subj.totalQuestions > 0
          ? Math.round((subj.correctAnswers / subj.totalQuestions) * 100)
          : 0;

      // Check Trend if >= 2 attempts exist
      if (subj.accuracies.length >= 2) {
        const firstAcc = subj.accuracies[subj.accuracies.length - 1]; // oldest in lookback
        const latestAcc = subj.accuracies[0]; // newest
        const delta = latestAcc - firstAcc;

        if (delta <= -12 && latestAcc < 70) {
          // Declining trend
          const mockTest = await this.findSubjectMockTest(subj.subjectId, targetIds);
          rawRecommendations.push({
            id: `rec-trend-decline-${subj.subjectId}`,
            type: 'DECLINING_SUBJECT',
            priority: 'HIGH',
            priorityScore: 88 + Math.abs(delta),
            confidence: 'HIGH',
            title: `Reverse Declining Trend in ${subj.subjectName}`,
            message: `${subj.subjectName} accuracy dropped by ${Math.abs(delta)}% (from ${firstAcc}% to ${latestAcc}%) across recent attempts.`,
            reason: `Recent test attempts reveal a downward trajectory in ${subj.subjectName}. Immediate revision of fundamental topics is needed.`,
            subjectId: subj.subjectId,
            subjectName: subj.subjectName,
            metrics: {
              accuracy: latestAcc,
              sampleSize: subj.totalQuestions,
              trendDelta: delta,
            },
            action: {
              type: 'PRACTICE_MOCK',
              label: mockTest
                ? `Take ${subj.subjectName} Diagnostic Mock`
                : `Practice ${subj.subjectName}`,
              targetUrl: mockTest
                ? `/student/mock-tests?mockTestId=${mockTest.id}`
                : `/student/mock-tests`,
              mockTestId: mockTest?.id || null,
              mockTestTitle: mockTest?.title || null,
            },
          });
          continue;
        } else if (delta >= 12 && latestAcc >= 70) {
          // Improving trend
          rawRecommendations.push({
            id: `rec-trend-improve-${subj.subjectId}`,
            type: 'IMPROVEMENT_TREND',
            priority: 'STRENGTH',
            priorityScore: 30,
            confidence: 'HIGH',
            title: `Excellent Progress in ${subj.subjectName}`,
            message: `${subj.subjectName} accuracy improved from ${firstAcc}% to ${latestAcc}% (+${delta}%). Keep maintaining momentum!`,
            reason: `Your disciplined practice in ${subj.subjectName} is reflecting in your recent test scores.`,
            subjectId: subj.subjectId,
            subjectName: subj.subjectName,
            metrics: {
              accuracy: latestAcc,
              sampleSize: subj.totalQuestions,
              trendDelta: delta,
            },
            action: {
              type: 'REVIEW_CONCEPTS',
              label: 'View Performance Trend',
              targetUrl: '/student/dashboard',
            },
          });
          continue;
        }
      }

      // If subject is weak and no specific chapter recommendation was already added
      if (
        overallAccuracy < options.weakAccuracyThreshold &&
        !coveredSubjectIds.has(subj.subjectId)
      ) {
        const mockTest = await this.findSubjectMockTest(subj.subjectId, targetIds);
        rawRecommendations.push({
          id: `rec-subj-weak-${subj.subjectId}`,
          type: 'WEAK_SUBJECT',
          priority: overallAccuracy < options.criticalAccuracyThreshold ? 'HIGH' : 'MEDIUM',
          priorityScore: 100 - overallAccuracy + 20,
          confidence: 'HIGH',
          title: `Boost ${subj.subjectName} Foundation`,
          message: `${subj.subjectName} overall accuracy is ${overallAccuracy}%. Target this subject with regular mock tests.`,
          reason: `Across ${subj.totalQuestions} questions, you achieved ${overallAccuracy}% accuracy with ${subj.wrongAnswers} errors.`,
          subjectId: subj.subjectId,
          subjectName: subj.subjectName,
          metrics: {
            accuracy: overallAccuracy,
            sampleSize: subj.totalQuestions,
            wrongCount: subj.wrongAnswers,
          },
          action: {
            type: 'PRACTICE_MOCK',
            label: mockTest
              ? `Practice ${subj.subjectName} Mock Test`
              : `Practice ${subj.subjectName}`,
            targetUrl: mockTest
              ? `/student/mock-tests?mockTestId=${mockTest.id}`
              : `/student/mock-tests`,
            mockTestId: mockTest?.id || null,
            mockTestTitle: mockTest?.title || null,
          },
        });
      }
    }

    // 7. Time Management & Pacing Diagnostics (from latest attempt)
    if (latestAttempt.timeLogs && latestAttempt.timeLogs.length > 0) {
      let correctTimeSum = 0;
      let correctCount = 0;
      let wrongTimeSum = 0;
      let wrongCount = 0;

      for (const log of latestAttempt.timeLogs) {
        const timeSec = log.timeSpentSeconds || 0;
        const answer = latestAttempt.answers?.find(
          (a: any) => a.examQuestionId === log.examQuestionId,
        );
        const q = answer?.examQuestion?.question;
        const correctOpt = q?.options?.find((o: any) => o.isCorrect);
        const isCorrect =
          answer?.selectedOptionId &&
          correctOpt &&
          answer.selectedOptionId === correctOpt.id;

        if (isCorrect) {
          correctTimeSum += timeSec;
          correctCount++;
        } else if (answer?.selectedOptionId || answer?.numericalAnswer != null) {
          wrongTimeSum += timeSec;
          wrongCount++;
        }
      }

      const avgTimeCorrect = correctCount > 0 ? correctTimeSum / correctCount : 0;
      const avgTimeWrong = wrongCount > 0 ? wrongTimeSum / wrongCount : 0;

      if (avgTimeWrong > avgTimeCorrect * 1.6 && avgTimeWrong > 75 && wrongCount >= 4) {
        rawRecommendations.push({
          id: 'rec-time-struggle',
          type: 'TIME_MANAGEMENT',
          priority: 'MEDIUM',
          priorityScore: 72,
          confidence: 'HIGH',
          title: 'Optimize Time Spent on Difficult Questions',
          message: `You spent ~${Math.round(avgTimeWrong)}s on incorrect questions vs ~${Math.round(avgTimeCorrect)}s on correct ones.`,
          reason: `Lingering too long on tricky questions drains time for easy scoring opportunities in later sections.`,
          metrics: {
            avgTimeSeconds: Math.round(avgTimeWrong),
          },
          action: {
            type: 'VIEW_ANALYSIS',
            label: 'View Time Analysis',
            targetUrl: `/exam/result/${latestAttempt.id}`,
          },
        });
      }
    }

    // 8. Negative Marking & Avoidable Penalty Check
    if (latestAttempt.result) {
      const res = latestAttempt.result;
      const wrongCount = res.wrongAnswers || 0;
      const defaultNegative = latestAttempt.exam?.defaultNegativeMarks ?? 1;
      const negativeLoss = wrongCount * defaultNegative;

      if (negativeLoss >= 12) {
        rawRecommendations.push({
          id: 'rec-negative-penalty',
          type: 'NEGATIVE_MARKING',
          priority: negativeLoss >= 20 ? 'HIGH' : 'MEDIUM',
          priorityScore: 75 + Math.min(25, negativeLoss),
          confidence: 'HIGH',
          title: `Curtail Avoidable Negative Marking (−${negativeLoss} Marks)`,
          message: `You lost ~${negativeLoss} marks to negative penalty across ${wrongCount} incorrect responses in your latest test.`,
          reason: `Eliminating uncalculated guessing on ambiguous questions will immediately elevate your rank and percentile.`,
          metrics: {
            negativeMarksLost: negativeLoss,
            wrongCount,
            potentialScoreGain: negativeLoss,
          },
          action: {
            type: 'VIEW_STRATEGY',
            label: 'View Attempt Strategy',
            targetUrl: `/exam/result/${latestAttempt.id}`,
          },
        });
      }
    }

    // 9. Sort by multi-factor Priority Score (descending) & limit count
    rawRecommendations.sort((a, b) => b.priorityScore - a.priorityScore);

    return rawRecommendations.slice(0, options.maxRecommendations);
  }

  /**
   * Multi-factor priority scoring formula:
   * (Severity * 0.35) + (SampleSizeFactor * 0.25) + (PotentialGain * 0.20) + (ConfidenceBonus)
   */
  private calculatePriorityScore(params: {
    severity: number;
    sampleSize: number;
    potentialGain: number;
    isCritical: boolean;
    confidence: RecommendationConfidence;
  }): number {
    const severityWeight = params.severity * 0.35;
    const sampleSizeWeight = Math.min(100, params.sampleSize * 7) * 0.25;
    const gainWeight = Math.min(100, params.potentialGain * 2) * 0.2;
    const confidenceBonus =
      params.confidence === 'HIGH' ? 20 : params.confidence === 'MEDIUM' ? 10 : 0;
    const criticalBonus = params.isCritical ? 15 : 0;

    return Number(
      (
        severityWeight +
        sampleSizeWeight +
        gainWeight +
        confidenceBonus +
        criticalBonus
      ).toFixed(1),
    );
  }

  /**
   * Helper: Resolve an active Subject-wise Mock Test matching subject and student target
   */
  private async findSubjectMockTest(subjectId: string, targetIds: string[]) {
    return this.prisma.exam.findFirst({
      where: {
        status: {
          name: { in: ['APPROVED', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'ENDED'] },
        },
        ...(targetIds.length > 0
          ? {
              OR: [
                { examTargetId: { in: targetIds } },
                { examTarget: { name: 'General' } },
              ],
            }
          : {}),
        sections: {
          some: {
            subjectId,
          },
        },
      },
      select: {
        id: true,
        title: true,
        totalQuestions: true,
        durationMinutes: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
