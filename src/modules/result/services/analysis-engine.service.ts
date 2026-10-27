import { Injectable, NotFoundException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GeminiExamAnalysisService,
  StudentExamAiContext,
  GeminiExamPredictionResult,
} from './gemini-exam-analysis.service';
import {
  PerformanceThresholds,
  DEFAULT_PERFORMANCE_THRESHOLDS,
  PerformanceStatus,
  FullAnalysisReport,
  OverallPerformanceMetrics,
  SubjectAnalyticsItem,
  ChapterAnalyticsItem,
  TimeAnalyticsReport,
  AttemptStrategyReport,
  ActionableRecommendation,
  QuestionTimeExtreme,
  SubjectBenchmarkComparison,
  StudentDetailsSection,
  OverallPerformanceSection,
  SubjectWiseAnalysisSection,
  SubjectPerformanceItem,
  TopicPerformanceRow,
  StrengthWeaknessSection,
  ErrorAnalysisSection,
  ErrorAnalysisCategory,
  TimeManagementSection,
  TimeManagementRow,
  PerformanceTrendSection,
  PerformanceTrendPoint,
  ExpectedPerformanceSection,
  FourteenDayImprovementPlanSection,
  FourteenDayPlanDayBlock,
  PersonalizedActionChecklistSection,
  ParentSummarySection,
  BrainrosPerformanceIndexSection,
  PerformanceIndexMetric,
  AiAnalysisMetadata,
} from '../interfaces/analysis.interface';

@Injectable()
export class AnalysisEngineService {
  private readonly logger = new Logger(AnalysisEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly geminiAnalysis?: GeminiExamAnalysisService,
  ) {}

  /**
   * Helper to determine status based on configurable thresholds
   */
  evaluateStatus(
    accuracy: number,
    totalAttempted: number,
    thresholds: PerformanceThresholds,
  ): PerformanceStatus {
    if (totalAttempted === 0) return 'NOT_ATTEMPTED';
    if (accuracy >= thresholds.excellent) return 'EXCELLENT';
    if (accuracy >= thresholds.strong) return 'STRONG';
    if (accuracy >= thresholds.good) return 'GOOD';
    if (accuracy >= thresholds.weak) return 'WEAK';
    return 'CRITICAL';
  }

  /**
   * Format performance level human readable label
   */
  getPerformanceLevelLabel(accuracy: number, percentage: number): string {
    const metric = Math.max(accuracy, percentage);
    if (metric >= 90) return 'Excellent';
    if (metric >= 75) return 'Very Good';
    if (metric >= 60) return 'Good';
    if (metric >= 45) return 'Needs Improvement';
    return 'Weak';
  }

  /**
   * Format seconds to human-readable string (e.g. "48m 20s", "1h 15m 30s")
   */
  formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '0s';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (hrs > 0) parts.push(`${hrs}h`);
    if (mins > 0) parts.push(`${mins}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    return parts.join(' ');
  }

  /**
   * Generate Full Comprehensive Analysis Report for an attempt
   */
  async generateFullAnalysis(attemptId: string): Promise<FullAnalysisReport> {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        student: {
          include: {
            user: true,
            studentClass: true,
            preferredLanguage: true,
          },
        },
        exam: {
          include: {
            examTarget: true,
            scoringRules: true,
          },
        },
        result: {
          include: {
            subjectResults: { include: { subject: true } },
            chapterResults: {
              include: { chapter: { include: { subject: true } } },
            },
          },
        },
        answers: {
          include: {
            selectedOption: true,
            examQuestion: {
              include: {
                question: {
                  include: {
                    questionType: true,
                    chapter: { include: { subject: true } },
                    options: true,
                  },
                },
                section: true,
              },
            },
          },
        },
        timeLogs: true,
        candidateRanks: true,
      },
    });

    if (!attempt) {
      throw new NotFoundException(`Attempt with ID '${attemptId}' not found`);
    }

    if (!attempt.result) {
      throw new NotFoundException(
        `Result has not been calculated yet for attempt '${attemptId}'`,
      );
    }

    const exam = attempt.exam;
    const result = attempt.result;

    // ── 1. Resolve Configurable Performance Thresholds ──────────────────────
    let thresholds = DEFAULT_PERFORMANCE_THRESHOLDS;
    if (
      exam.performanceThresholds &&
      typeof exam.performanceThresholds === 'object'
    ) {
      const custom =
        exam.performanceThresholds as Partial<PerformanceThresholds>;
      thresholds = {
        excellent: custom.excellent ?? DEFAULT_PERFORMANCE_THRESHOLDS.excellent,
        strong: custom.strong ?? DEFAULT_PERFORMANCE_THRESHOLDS.strong,
        good: custom.good ?? DEFAULT_PERFORMANCE_THRESHOLDS.good,
        weak: custom.weak ?? DEFAULT_PERFORMANCE_THRESHOLDS.weak,
      };
    }

    // ── 2. Time Used & Per-Question Analytics ──────────────────────────────
    const startedAt = attempt.startedAt
      ? new Date(attempt.startedAt).getTime()
      : 0;
    const submittedAt = attempt.submittedAt
      ? new Date(attempt.submittedAt).getTime()
      : Date.now();
    const totalTimeUsedSeconds = Math.max(
      0,
      Math.floor((submittedAt - startedAt) / 1000),
    );
    const avgTimePerQuestion =
      result.totalQuestions > 0
        ? Math.round((totalTimeUsedSeconds / result.totalQuestions) * 10) / 10
        : 0;

    // Build map of timeLogs: examQuestionId -> totalSeconds
    const questionTimeMap = new Map<string, number>();
    for (const log of attempt.timeLogs) {
      const prev = questionTimeMap.get(log.examQuestionId) || 0;
      questionTimeMap.set(log.examQuestionId, prev + log.timeSpentSeconds);
    }

    // Fetch all exam questions for complete coverage
    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId: exam.id },
      include: {
        question: {
          include: {
            questionType: true,
            chapter: { include: { subject: true } },
            options: true,
          },
        },
        section: true,
      },
    });

    // Classify each question attempt
    let totalNegativeMarksLost = 0;
    let correctTimeSum = 0;
    let correctCountForTime = 0;
    let wrongTimeSum = 0;
    let wrongCountForTime = 0;
    let unattemptedTimeSum = 0;
    let unattemptedCountForTime = 0;

    let rushedCount = 0;
    let optimalPaceCount = 0;
    let overthoughtCount = 0;

    let markedForReviewCount = 0;
    let markedAndAnsweredCount = 0;
    let markedAndCorrectCount = 0;
    let markedAndWrongCount = 0;

    const answerMap = new Map(
      attempt.answers.map((a) => [a.examQuestionId, a]),
    );

    const subjectTimeMap = new Map<string, number>();
    const chapterTimeMap = new Map<string, number>();
    const subjectQuestionCountMap = new Map<string, number>();

    // Fastest & slowest question tracking
    let fastestQ: QuestionTimeExtreme | null = null;
    let slowestQ: QuestionTimeExtreme | null = null;
    let displayOrderCounter = 0;

    // Error classification structures
    const classifiedErrors = {
      conceptual: 0,
      calculation: 0,
      silly: 0,
      misreading: 0,
      guessing: 0,
    };

    for (const eq of examQuestions) {
      const ans = answerMap.get(eq.id);
      const q = eq.question;
      const subjectName =
        eq.section?.name || q.chapter?.subject?.name || 'General';
      const chapterId = q.chapterId;
      const timeSpent =
        questionTimeMap.get(eq.id) || (ans ? avgTimePerQuestion : 0);
      displayOrderCounter++;

      // Accumulate subject and chapter times
      subjectTimeMap.set(
        subjectName,
        (subjectTimeMap.get(subjectName) || 0) + timeSpent,
      );
      subjectQuestionCountMap.set(
        subjectName,
        (subjectQuestionCountMap.get(subjectName) || 0) + 1,
      );
      if (chapterId) {
        chapterTimeMap.set(
          chapterId,
          (chapterTimeMap.get(chapterId) || 0) + timeSpent,
        );
      }

      // Track fastest & slowest attempted questions
      const isAttemptedForTime =
        !!ans &&
        (!!ans.selectedOptionId ||
          ans.numericalAnswer !== null ||
          !!ans.selectedOptions);
      const isCorrect = this.isAnswerCorrect(q, ans);

      if (isAttemptedForTime && timeSpent > 0) {
        const sectionName = eq.section?.name || subjectName;
        const extremeEntry: QuestionTimeExtreme = {
          questionId: q.id,
          examQuestionId: eq.id,
          displayOrder: eq.displayOrder ?? displayOrderCounter,
          timeSeconds: timeSpent,
          sectionName,
          isCorrect,
        };

        if (!fastestQ || timeSpent < fastestQ.timeSeconds) {
          fastestQ = extremeEntry;
        }
        if (!slowestQ || timeSpent > slowestQ.timeSeconds) {
          slowestQ = extremeEntry;
        }
      }

      // Check pacing
      if (isAttemptedForTime) {
        if (timeSpent > 0 && timeSpent < 20) {
          rushedCount++;
        } else if (timeSpent > avgTimePerQuestion * 2.5 && timeSpent > 45) {
          overthoughtCount++;
        } else {
          optimalPaceCount++;
        }
      }

      // Review behavior
      if (ans?.isMarkedForReview) {
        markedForReviewCount++;
        if (isAttemptedForTime) {
          markedAndAnsweredCount++;
          if (isCorrect) {
            markedAndCorrectCount++;
          } else {
            markedAndWrongCount++;
          }
        }
      }

      // Accumulate timing breakdown
      if (!isAttemptedForTime) {
        unattemptedTimeSum += timeSpent;
        unattemptedCountForTime++;
      } else if (isCorrect) {
        correctTimeSum += timeSpent;
        correctCountForTime++;
      } else {
        wrongTimeSum += timeSpent;
        wrongCountForTime++;
        const negPerQ = exam.scoringRules?.[0]?.negativeMarksPerQuestion ?? 1;
        totalNegativeMarksLost += Math.abs(negPerQ);

        // Error Analysis Classification
        const isNumerical = q.questionType?.code === 'NUM';
        const isHardOrMedium = q.difficultyLevel === 'HARD' || q.difficultyLevel === 'MEDIUM';
        if (timeSpent < 15) {
          classifiedErrors.guessing++;
        } else if (timeSpent < 30) {
          classifiedErrors.misreading++;
        } else if (isNumerical || (timeSpent >= avgTimePerQuestion && isHardOrMedium)) {
          if (isNumerical || timeSpent < avgTimePerQuestion * 1.8) {
            classifiedErrors.calculation++;
          } else {
            classifiedErrors.conceptual++;
          }
        } else if (q.difficultyLevel === 'EASY') {
          classifiedErrors.silly++;
        } else {
          classifiedErrors.conceptual++;
        }
      }
    }

    // Benchmark time calculations
    const subjectBenchmarkComparisons: SubjectBenchmarkComparison[] = [];
    const totalQuestionsCount = Math.max(1, examQuestions.length);
    for (const [sName, qCount] of subjectQuestionCountMap.entries()) {
      const actualSec = subjectTimeMap.get(sName) || 0;
      const proportion = qCount / totalQuestionsCount;
      const recommendedSec = Math.round(
        (exam.durationMinutes || 180) * 60 * proportion,
      );
      const deltaPercent =
        recommendedSec > 0
          ? Math.round(((actualSec - recommendedSec) / recommendedSec) * 100)
          : 0;

      let observation = 'Balanced time spent';
      if (deltaPercent > 20)
        observation = `Over-invested time (+${deltaPercent}%)`;
      if (deltaPercent < -20)
        observation = `Rushed through subject (${deltaPercent}%)`;

      subjectBenchmarkComparisons.push({
        subjectName: sName,
        actualSeconds: actualSec,
        recommendedSeconds: recommendedSec,
        deltaPercent,
        observation,
      });
    }

    // ── 3. Subject Analytics & Identification ───────────────────────────────
    const subjectItems: SubjectAnalyticsItem[] = [];
    for (const sr of result.subjectResults) {
      const sAccuracy = sr.accuracy;
      const sTimeSpent = subjectTimeMap.get(sr.subject.name) || 0;
      const sAvgTime =
        sr.totalQuestions > 0
          ? Math.round((sTimeSpent / sr.totalQuestions) * 10) / 10
          : 0;
      const sStatus = this.evaluateStatus(
        sAccuracy,
        sr.correctAnswers + sr.wrongAnswers,
        thresholds,
      );

      subjectItems.push({
        subjectId: sr.subjectId,
        subjectName: sr.subject.name,
        totalQuestions: sr.totalQuestions,
        correct: sr.correctAnswers,
        wrong: sr.wrongAnswers,
        unattempted: sr.unattempted,
        score: sr.score,
        maxScore: sr.maxScore,
        accuracy: sAccuracy,
        percentage: sr.percentage ?? 0,
        timeSpentSeconds: sTimeSpent,
        avgTimePerQuestionSeconds: sAvgTime,
        status: sStatus,
        isStrongest: false,
        isWeakest: false,
      });
    }

    if (subjectItems.length > 0) {
      let strongest = subjectItems[0];
      let weakest = subjectItems[0];
      for (const item of subjectItems) {
        if (item.accuracy > strongest.accuracy) strongest = item;
        if (item.accuracy < weakest.accuracy) weakest = item;
      }
      strongest.isStrongest = true;
      weakest.isWeakest = true;
    }

    const strongestSubject = subjectItems.find((s) => s.isStrongest) || null;
    const weakestSubject = subjectItems.find((s) => s.isWeakest) || null;

    // ── 4. Chapter Analytics & Categorization ───────────────────────────────
    const chapterItems: ChapterAnalyticsItem[] = [];
    const masteredChapters: ChapterAnalyticsItem[] = [];
    const revisionNeededChapters: ChapterAnalyticsItem[] = [];
    const criticalFocusChapters: ChapterAnalyticsItem[] = [];

    for (const cr of result.chapterResults) {
      const cAccuracy = cr.accuracy;
      const cTimeSpent = chapterTimeMap.get(cr.chapterId) || 0;
      const cAvgTime =
        cr.totalQuestions > 0
          ? Math.round((cTimeSpent / cr.totalQuestions) * 10) / 10
          : 0;
      const cStatus = this.evaluateStatus(
        cAccuracy,
        cr.correctAnswers + cr.wrongAnswers,
        thresholds,
      );

      const item: ChapterAnalyticsItem = {
        chapterId: cr.chapterId,
        chapterName: cr.chapter.name,
        subjectId: cr.chapter.subjectId,
        subjectName: cr.chapter.subject.name,
        totalQuestions: cr.totalQuestions,
        correct: cr.correctAnswers,
        wrong: cr.wrongAnswers,
        unattempted: cr.unattempted,
        score: cr.score,
        maxScore: cr.maxScore ?? 0,
        accuracy: cAccuracy,
        percentage: cr.percentage ?? 0,
        timeSpentSeconds: cTimeSpent,
        avgTimePerQuestionSeconds: cAvgTime,
        status: cStatus,
      };

      chapterItems.push(item);
      if (cStatus === 'EXCELLENT' || cStatus === 'STRONG') {
        masteredChapters.push(item);
      } else if (cStatus === 'GOOD' || cStatus === 'WEAK') {
        revisionNeededChapters.push(item);
      } else {
        criticalFocusChapters.push(item);
      }
    }

    // ── 5. Overall Performance Metrics ─────────────────────────────────────
    const overallStatus = this.evaluateStatus(
      result.accuracy,
      result.correctAnswers + result.wrongAnswers,
      thresholds,
    );
    const speedAccuracyQuadrant = this.determineQuadrant(
      result.accuracy,
      avgTimePerQuestion,
      (exam.durationMinutes * 60) / Math.max(1, result.totalQuestions),
    );

    const overall: OverallPerformanceMetrics = {
      totalMarks: result.maxScore,
      obtainedMarks: result.totalScore,
      percentage: result.percentage,
      accuracy: result.accuracy,
      correctCount: result.correctAnswers,
      wrongCount: result.wrongAnswers,
      unattemptedCount: result.unattempted,
      totalQuestions: result.totalQuestions,
      timeUsedSeconds: totalTimeUsedSeconds,
      formattedTimeUsed: this.formatDuration(totalTimeUsedSeconds),
      averageTimePerQuestionSeconds: avgTimePerQuestion,
      negativeMarksLost: totalNegativeMarksLost,
      potentialMarks: result.totalScore + totalNegativeMarksLost,
      overallStatus,
      speedAccuracyQuadrant,
    };

    // ── 6. Time Analytics Report ───────────────────────────────────────────
    const timeWastedSeconds = Math.round(
      wrongTimeSum * 0.7 + unattemptedTimeSum * 0.5,
    );
    const timeAnalysis: TimeAnalyticsReport = {
      totalExamDurationMinutes: exam.durationMinutes,
      totalTimeUsedSeconds,
      timeRemainingSeconds: Math.max(
        0,
        exam.durationMinutes * 60 - totalTimeUsedSeconds,
      ),
      averageTimePerQuestionSeconds: avgTimePerQuestion,
      timeOnCorrectQuestionsSeconds: correctTimeSum,
      avgTimeOnCorrectSeconds:
        correctCountForTime > 0
          ? Math.round(correctTimeSum / correctCountForTime)
          : 0,
      timeOnWrongQuestionsSeconds: wrongTimeSum,
      avgTimeOnWrongSeconds:
        wrongCountForTime > 0
          ? Math.round(wrongTimeSum / wrongCountForTime)
          : 0,
      timeOnUnattemptedQuestionsSeconds: unattemptedTimeSum,
      avgTimeOnUnattemptedSeconds:
        unattemptedCountForTime > 0
          ? Math.round(unattemptedTimeSum / unattemptedCountForTime)
          : 0,
      timeWastedSeconds,
      fastestQuestion: fastestQ,
      slowestQuestion: slowestQ,
      pacingMetrics: {
        rushedCount,
        optimalPaceCount,
        overthoughtCount,
      },
      subjectTimeDistribution: Array.from(subjectTimeMap.entries()).map(
        ([name, seconds]) => ({
          subjectName: name,
          timeSpentSeconds: seconds,
          percentageOfTotalTime:
            totalTimeUsedSeconds > 0
              ? Math.round((seconds / totalTimeUsedSeconds) * 100)
              : 0,
        }),
      ),
      subjectBenchmarkComparisons,
    };

    // ── 7. Attempt Strategy Report ─────────────────────────────────────────
    const attemptRatio =
      result.totalQuestions > 0
        ? Math.round(
            ((result.correctAnswers + result.wrongAnswers) /
              result.totalQuestions) *
              100,
          )
        : 0;

    const strategicTakeaways: string[] = [];
    if (totalNegativeMarksLost >= 8) {
      strategicTakeaways.push(
        `High negative marking penalty: You lost ${totalNegativeMarksLost} marks due to wrong attempts.`,
      );
    }
    if (rushedCount >= 5) {
      strategicTakeaways.push(
        `${rushedCount} questions were answered in under 20 seconds. Ensure you read all options carefully.`,
      );
    }
    if (overthoughtCount >= 4) {
      strategicTakeaways.push(
        `${overthoughtCount} questions took over 2.5x the average time. Practice strategic skipping.`,
      );
    }
    if (
      markedAndCorrectCount > markedAndWrongCount &&
      markedForReviewCount > 0
    ) {
      strategicTakeaways.push(
        `Reviewing marked questions proved beneficial: ${markedAndCorrectCount} of ${markedAndAnsweredCount} marked questions were correct.`,
      );
    }
    if (strategicTakeaways.length === 0) {
      strategicTakeaways.push(
        'Balanced attempt pattern observed with steady pacing and good accuracy.',
      );
    }

    const wrongRatio =
      result.correctAnswers + result.wrongAnswers > 0
        ? (result.wrongAnswers / (result.correctAnswers + result.wrongAnswers)) *
          100
        : 0;
    const unattemptedRatio =
      result.totalQuestions > 0
        ? (result.unattempted / result.totalQuestions) * 100
        : 0;

    let overAttemptingWarning: string | null = null;
    if (wrongRatio > 40 && result.wrongAnswers >= 10) {
      overAttemptingWarning = `Over-attempting detected: ${result.wrongAnswers} wrong answers (${Math.round(wrongRatio)}% error rate). You attempted high-risk questions without sufficient confidence, losing ${Math.round(totalNegativeMarksLost)} marks to negative marking.`;
    }

    let underAttemptingWarning: string | null = null;
    if (unattemptedRatio > 30 && result.unattempted >= 15) {
      underAttemptingWarning = `Under-attempting detected: ${result.unattempted} questions (${Math.round(unattemptedRatio)}%) were left unanswered. Some of these may have been easy/medium difficulty questions worth attempting.`;
    }

    const potentialScoreGainMessage =
      totalNegativeMarksLost >= 4
        ? `Score could improve by ~${Math.round(totalNegativeMarksLost)} marks by eliminating low-confidence wrong guesses. Your potential score without negative marking: ${Math.round(result.totalScore + totalNegativeMarksLost)}/${result.maxScore}.`
        : `Good negative marking discipline. Only ${Math.round(totalNegativeMarksLost)} marks lost to wrong attempts.`;

    const attemptStrategy: AttemptStrategyReport = {
      negativeMarkingPenalty: totalNegativeMarksLost,
      marksLostToGuessing: totalNegativeMarksLost,
      scoreWithoutNegativeMarking: result.totalScore + totalNegativeMarksLost,
      reviewBehavior: {
        markedForReviewCount,
        markedAndAnsweredCount,
        markedAndCorrectCount,
        markedAndWrongCount,
      },
      attemptRatio,
      accuracyVsSpeedProfile: speedAccuracyQuadrant.replace(/_/g, ' '),
      strategicTakeaways,
      overAttemptingWarning,
      underAttemptingWarning,
      potentialScoreGainMessage,
    };

    // ── 8. Actionable Personalized Recommendations ────────────────────────
    const recommendations: ActionableRecommendation[] =
      this.generateRecommendations({
        criticalFocusChapters,
        revisionNeededChapters,
        weakestSubject,
        totalNegativeMarksLost,
        timeAnalysis,
        examTargetName: exam.examTarget.name,
        defaultMarks: exam.defaultMarksPerQuestion,
      });

    // ── 9. Fetch Historical Attempts for Trend Analysis ────────────────────
    const previousAttempts = await this.prisma.attempt.findMany({
      where: {
        studentId: attempt.studentId,
        status: { name: 'COMPLETED' },
        result: { isNot: null },
      },
      include: {
        exam: true,
        result: true,
        candidateRanks: true,
      },
      orderBy: { submittedAt: 'asc' },
      take: 10,
    });

    // ── 10. Extract Rank / Percentile ──────────────────────────────────────
    const overallRankRecord = attempt.candidateRanks?.find(
      (r) => r.rankType === 'OVERALL',
    ) || attempt.candidateRanks?.[0];

    const overallPercentile = overallRankRecord?.percentile !== undefined
      ? Math.round(overallRankRecord.percentile * 100) / 100
      : null;
    const estimatedRank = overallRankRecord?.rank ?? null;

    // ── 11. Run / Fetch Gemini AI Predictive Analysis ─────────────────────
    const existingMetadata = (result.metadata as any) || {};
    let aiPredictions: GeminiExamPredictionResult;

    if (
      existingMetadata.aiAnalysis &&
      existingMetadata.aiAnalysis.errorAnalysis &&
      existingMetadata.aiAnalysis.fourteenDayPlan
    ) {
      aiPredictions = existingMetadata.aiAnalysis;
    } else {
      const sampleWrongQuestions = examQuestions
        .filter((eq) => {
          const a = answerMap.get(eq.id);
          return a && !this.isAnswerCorrect(eq.question, a);
        })
        .slice(0, 8)
        .map((eq, idx) => {
          const a = answerMap.get(eq.id);
          const correctOpt = eq.question?.options?.find((o: any) => o.isCorrect);
          return {
            questionNumber: idx + 1,
            subjectName: eq.section?.name || eq.question?.chapter?.subject?.name || 'General',
            chapterName: eq.question?.chapter?.name,
            questionText: (eq.question as any)?.plainText || (eq.question as any)?.stemText || '',
            studentAnswer: a?.selectedOption?.optionText || a?.numericalAnswer?.toString() || 'Selected option',
            correctAnswer: correctOpt?.optionText || 'Correct Option',
            timeSpentSeconds: questionTimeMap.get(eq.id) || 0,
          };
        });

      const aiContext: StudentExamAiContext = {
        student: {
          id: attempt.studentId,
          name: attempt.student?.name || attempt.student?.user?.name || 'Student',
          studentCode: attempt.student?.studentCode || 'BR26-STU-001',
          className: attempt.student?.studentClass?.name,
          targetExam: exam.examTarget?.name,
        },
        exam: {
          id: exam.id,
          title: exam.title,
          durationMinutes: exam.durationMinutes,
          totalQuestions: result.totalQuestions,
          maxScore: result.maxScore,
          defaultMarksPerQuestion: exam.defaultMarksPerQuestion || 4,
          negativeMarksPerQuestion: (exam.scoringRules?.[0] as any)?.negativeMarks || 1,
        },
        overall: {
          score: result.totalScore,
          maxScore: result.maxScore,
          percentage: result.percentage,
          accuracy: result.accuracy,
          correctCount: result.correctAnswers,
          wrongCount: result.wrongAnswers,
          unattemptedCount: result.unattempted,
          negativeMarksLost: totalNegativeMarksLost,
          totalTimeUsedSeconds,
          averageTimePerQuestionSeconds: avgTimePerQuestion,
        },
        subjects: subjectItems.map((s) => ({
          subjectName: s.subjectName,
          score: s.score,
          maxScore: s.maxScore,
          accuracy: s.accuracy,
          percentage: s.percentage,
          correct: s.correct,
          wrong: s.wrong,
          unattempted: s.unattempted,
          timeSpentSeconds: s.timeSpentSeconds,
        })),
        chapters: chapterItems.map((c) => ({
          chapterName: c.chapterName,
          subjectName: c.subjectName,
          totalQuestions: c.totalQuestions,
          correct: c.correct,
          wrong: c.wrong,
          unattempted: c.unattempted,
          accuracy: c.accuracy,
          status: c.status,
        })),
        sampleWrongQuestions,
        previousAttempts: previousAttempts.map((pa) => ({
          testTitle: pa.exam?.title || 'Mock Test',
          date: (pa.submittedAt || pa.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
          score: pa.result?.totalScore ?? 0,
          maxScore: pa.result?.maxScore ?? exam.totalMarks,
          percentile: pa.candidateRanks?.[0]?.percentile ?? null,
        })),
      };

      if (this.geminiAnalysis) {
        aiPredictions = await this.geminiAnalysis.predictExamInsights(aiContext);
      } else {
        // Fallback generator when service is not injected
        const fallbackService = new GeminiExamAnalysisService(new ConfigService());
        aiPredictions = fallbackService.generateHeuristicFallback(aiContext);
      }

      // Persist AI predictions to Result.metadata asynchronously
      if (this.prisma.result?.update) {
        this.prisma.result
          .update({
            where: { id: result.id },
            data: {
              metadata: {
                ...existingMetadata,
                aiAnalysis: aiPredictions,
              },
            },
          })
          .catch((saveErr: any) => {
            this.logger.warn(`Failed to persist AI analysis to metadata: ${saveErr.message}`);
          });
      }
    }

    // Override heuristic attempt strategy metrics with Gemini predictions if present
    if (aiPredictions.speedAccuracyQuadrant) {
      overall.speedAccuracyQuadrant = aiPredictions.speedAccuracyQuadrant;
      attemptStrategy.accuracyVsSpeedProfile = aiPredictions.speedAccuracyQuadrant.replace(/_/g, ' ');
    }
    if (aiPredictions.strategicTakeaways?.length) {
      attemptStrategy.strategicTakeaways = aiPredictions.strategicTakeaways;
    }
    if (aiPredictions.overAttemptingWarning !== undefined) {
      attemptStrategy.overAttemptingWarning = aiPredictions.overAttemptingWarning;
    }
    if (aiPredictions.underAttemptingWarning !== undefined) {
      attemptStrategy.underAttemptingWarning = aiPredictions.underAttemptingWarning;
    }
    if (aiPredictions.potentialScoreGainMessage) {
      attemptStrategy.potentialScoreGainMessage = aiPredictions.potentialScoreGainMessage;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // BUILD ALL 14 CANONICAL SECTIONS MATCHING THE REFERENCE REPORT SPEC
    // ═════════════════════════════════════════════════════════════════════════

    // SECTION 1: Student Details
    const student = attempt.student;
    const testDateFormatted = (attempt.submittedAt || attempt.createdAt).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    const section1StudentDetails: StudentDetailsSection = {
      studentName: student?.name || student?.user?.name || 'Student',
      studentId: student?.studentCode || student?.studentId || 'BR26-STU-001',
      examination: exam.examTarget?.name ? `${exam.examTarget.name} Mock Test` : exam.title,
      className: student?.studentClass?.name || '12th / 2nd PUC',
      testNumber: (exam as any).code || exam.title,
      testDate: testDateFormatted,
      testMode: 'Online',
      totalQuestions: result.totalQuestions,
      maximumMarks: result.maxScore,
    };

    // SECTION 2: Overall Performance
    const section2OverallPerformance: OverallPerformanceSection = {
      totalMarks: result.totalScore,
      maximumMarks: result.maxScore,
      percentage: Math.round(result.percentage * 100) / 100,
      correctAnswers: result.correctAnswers,
      incorrectAnswers: result.wrongAnswers,
      unattempted: result.unattempted,
      accuracy: Math.round(result.accuracy * 100) / 100,
      overallPercentile,
      estimatedRank,
      performanceLevel: this.getPerformanceLevelLabel(result.accuracy, result.percentage),
    };

    // SECTION 3: Subject-Wise Analysis
    const subjectWiseRows = subjectItems.map((s) => ({
      subject: s.subjectName,
      max: s.maxScore,
      score: s.score,
      percentage: Math.round(s.percentage * 10) / 10,
      correct: s.correct,
      wrong: s.wrong,
      unattempted: s.unattempted,
      accuracy: Math.round(s.accuracy * 100) / 100,
    }));

    const section3SubjectWiseAnalysis: SubjectWiseAnalysisSection = {
      rows: subjectWiseRows,
      total: {
        subject: 'TOTAL',
        max: result.maxScore,
        score: result.totalScore,
        percentage: Math.round(result.percentage * 10) / 10,
        correct: result.correctAnswers,
        wrong: result.wrongAnswers,
        unattempted: result.unattempted,
        accuracy: Math.round(result.accuracy * 100) / 100,
      },
    };

    // SECTION 4: Subject Performance (Per-Subject Diagnosis)
    const section4SubjectPerformance: SubjectPerformanceItem[] = subjectItems.map((s) => {
      const subjectChapters = chapterItems.filter((c) => c.subjectId === s.subjectId || c.subjectName === s.subjectName);
      const strongChapters = subjectChapters
        .filter((c) => c.accuracy >= 75)
        .map((c) => c.chapterName);
      const weakChapters = subjectChapters
        .filter((c) => c.accuracy < 70)
        .map((c) => c.chapterName);

      const strongAreas = strongChapters.length > 0
        ? strongChapters.slice(0, 4)
        : subjectChapters.sort((a, b) => b.accuracy - a.accuracy).slice(0, 2).map((c) => c.chapterName);

      const areasRequiringImprovement = weakChapters.length > 0
        ? weakChapters.slice(0, 4)
        : ['Advanced problem solving & numerical precision'];

      let recommendation = `Maintain steady consistency in ${s.subjectName}. Target: ${Math.min(s.maxScore, Math.round(s.score + (s.maxScore - s.score) * 0.5))}+ marks.`;
      if (s.accuracy < 65) {
        recommendation = `Focus on concept application, formula derivation, and high-frequency numerical practice in ${s.subjectName}. Target: ${Math.min(s.maxScore, Math.round(s.score + 25))}+.`;
      } else if (s.accuracy >= 85) {
        recommendation = `Outstanding performance in ${s.subjectName}. Continue rigorous mock tests to sustain speed and maintain 90%+ accuracy.`;
      }

      return {
        subjectName: s.subjectName,
        score: s.score,
        maxScore: s.maxScore,
        performanceLevel: this.getPerformanceLevelLabel(s.accuracy, s.percentage),
        strongAreas,
        areasRequiringImprovement,
        recommendation,
      };
    });

    // SECTION 5: Topic-Wise Performance
    const section5TopicWisePerformance: TopicPerformanceRow[] = chapterItems.map((c) => {
      let status: 'Excellent' | 'Strong' | 'Needs Improvement' | 'Weak' = 'Needs Improvement';
      if (c.accuracy >= 90) status = 'Excellent';
      else if (c.accuracy >= 75) status = 'Strong';
      else if (c.accuracy >= 60) status = 'Needs Improvement';
      else status = 'Weak';

      return {
        topic: c.chapterName,
        subjectName: c.subjectName,
        accuracy: Math.round(c.accuracy * 100) / 100,
        status,
        totalQuestions: c.totalQuestions,
        correct: c.correct,
        wrong: c.wrong,
      };
    }).sort((a, b) => b.accuracy - a.accuracy);

    // SECTION 6: Strength & Weakness Analysis
    const topStrengths: string[] = [];
    if (strongestSubject && strongestSubject.accuracy >= 75) {
      topStrengths.push(`${strongestSubject.subjectName} conceptual mastery & accuracy (${strongestSubject.accuracy}%)`);
    }
    if (masteredChapters.length > 0) {
      const topChaps = masteredChapters.slice(0, 3).map((c) => c.chapterName).join(', ');
      topStrengths.push(`High accuracy in core chapters: ${topChaps}`);
    }
    if (totalNegativeMarksLost <= 6) {
      topStrengths.push('Disciplined question selection with controlled negative marking loss');
    }
    if (speedAccuracyQuadrant === 'FAST_AND_ACCURATE' || speedAccuracyQuadrant === 'SLOW_AND_ACCURATE') {
      topStrengths.push('Consistent problem-solving accuracy across standard question formats');
    }
    if (topStrengths.length < 3) {
      topStrengths.push('Strong foundational attempt commitment across scheduled test duration');
    }

    const priorityWeaknesses: string[] = [];
    if (weakestSubject && weakestSubject.accuracy < 70) {
      priorityWeaknesses.push(`${weakestSubject.subjectName} problem-solving depth (${weakestSubject.accuracy}% accuracy)`);
    }
    if (criticalFocusChapters.length > 0) {
      const critChaps = criticalFocusChapters.slice(0, 3).map((c) => c.chapterName).join(', ');
      priorityWeaknesses.push(`Underperforming chapters requiring revision: ${critChaps}`);
    }
    if (totalNegativeMarksLost >= 8) {
      priorityWeaknesses.push(`Avoidable negative marking penalty (−${totalNegativeMarksLost} marks lost)`);
    }
    if (classifiedErrors.calculation >= 3) {
      priorityWeaknesses.push('Calculation precision and multi-step algebraic simplification');
    }
    if (result.unattempted >= 15) {
      priorityWeaknesses.push('Time allocation & question scanning speed for unattempted questions');
    }
    if (priorityWeaknesses.length < 3) {
      priorityWeaknesses.push('Final review round discipline and option elimination technique');
    }

    const section6StrengthWeakness: StrengthWeaknessSection =
      aiPredictions?.strengthWeakness?.topStrengths?.length &&
      aiPredictions?.strengthWeakness?.priorityWeaknesses?.length
        ? aiPredictions.strengthWeakness
        : {
            topStrengths: topStrengths.slice(0, 4),
            priorityWeaknesses: priorityWeaknesses.slice(0, 4),
          };

    // SECTION 7: Error Analysis
    const totalWrongCount = result.wrongAnswers;
    const errorCategories: ErrorAnalysisCategory[] = [
      {
        errorType: 'Conceptual Error',
        questionCount: Math.max(0, classifiedErrors.conceptual),
        impact: classifiedErrors.conceptual >= 5 ? 'High' : 'Medium',
        description: 'Gap in underlying theoretical fundamentals or principle application',
      },
      {
        errorType: 'Calculation Error',
        questionCount: Math.max(0, classifiedErrors.calculation),
        impact: classifiedErrors.calculation >= 4 ? 'High' : 'Medium',
        description: 'Arithmetic slips, unit conversion errors, or formula simplification slips',
      },
      {
        errorType: 'Silly Mistake',
        questionCount: Math.max(0, classifiedErrors.silly),
        impact: classifiedErrors.silly >= 3 ? 'Medium' : 'Low',
        description: 'Overlooking given values or bubbling wrong option on straightforward questions',
      },
      {
        errorType: 'Misreading Question',
        questionCount: Math.max(0, classifiedErrors.misreading),
        impact: classifiedErrors.misreading >= 3 ? 'Medium' : 'Low',
        description: 'Missed keywords such as "INCORRECT", "EXCEPT", or "NOT TRUE"',
      },
      {
        errorType: 'Guessing',
        questionCount: Math.max(0, classifiedErrors.guessing),
        impact: classifiedErrors.guessing >= 3 ? 'Medium' : 'Low',
        description: 'Low-confidence attempts made under rushed time pressure',
      },
    ];

    // If total wrong has questions not yet assigned, allocate remainder proportionally
    const assignedErrors = errorCategories.reduce((acc, c) => acc + c.questionCount, 0);
    if (totalWrongCount > assignedErrors && errorCategories.length > 0) {
      errorCategories[0].questionCount += totalWrongCount - assignedErrors;
    }

    const recoverableMistakes = (classifiedErrors.calculation + classifiedErrors.silly + classifiedErrors.misreading + classifiedErrors.guessing);
    const potentialRecoverableMarks = Math.round(
      recoverableMistakes * (exam.defaultMarksPerQuestion || 4) + totalNegativeMarksLost * 0.75,
    );

    const section7ErrorAnalysis: ErrorAnalysisSection =
      aiPredictions?.errorAnalysis?.categories?.length
        ? aiPredictions.errorAnalysis
        : {
            categories: errorCategories,
            totalWrong: totalWrongCount,
            potentialRecoverableMarks: Math.max(0, potentialRecoverableMarks),
            narrative: potentialRecoverableMarks > 0
              ? `Approximately ${potentialRecoverableMarks} marks could potentially be recovered by reducing avoidable calculation, reading, and silly mistakes. Maintain an Error Notebook after every BRAINROS test.`
              : 'Excellent accuracy discipline observed with minimal avoidable errors. Keep maintaining precision during mock testing.',
          };

    // SECTION 8: Time Management
    const timeRows: TimeManagementRow[] = subjectBenchmarkComparisons.map((b) => ({
      section: b.subjectName,
      recommendedMinutes: Math.round(b.recommendedSeconds / 60),
      studentMinutes: Math.round(b.actualSeconds / 60),
      status: b.deltaPercent > 20 ? 'Slow' : b.deltaPercent < -20 ? 'Fast' : 'Optimal',
    }));

    const section8TimeManagement: TimeManagementSection = {
      rows: timeRows,
      reviewMinutes: {
        recommended: 20,
        actual: Math.max(0, Math.round(exam.durationMinutes - totalTimeUsedSeconds / 60)),
      },
      roundsStrategy:
        aiPredictions?.pacingRounds?.length
          ? aiPredictions.pacingRounds
          : [
              {
                round: 'Round 1 (First 50–60 mins)',
                title: 'Direct & Easy Questions',
                description: 'Solve all 100% confident, single-step questions instantly across all subjects.',
              },
              {
                round: 'Round 2 (Next 60–70 mins)',
                title: 'Moderate & Standard Problems',
                description: 'Tackle multi-step conceptual problems requiring standard formulas and derivations.',
              },
              {
                round: 'Round 3 (Next 25–30 mins)',
                title: 'Difficult / Lengthy Numericals',
                description: 'Attempt challenging calculations and complex assertion-reason questions.',
              },
              {
                round: 'Final 15–20 minutes',
                title: 'Verification & Review',
                description: 'Review marked questions, check calculations, and confirm no answers were skipped accidentally.',
              },
            ],
    };

    // SECTION 9: Performance Trend
    const historyPoints: PerformanceTrendPoint[] = previousAttempts.map((pa, idx) => {
      const pScore = pa.result?.totalScore ?? 0;
      const pMax = pa.result?.maxScore ?? exam.totalMarks;
      const pRankRec = pa.candidateRanks?.[0];
      const pPercentile = pRankRec?.percentile ? Math.round(pRankRec.percentile * 100) / 100 : null;

      return {
        testNumber: `Test 0${idx + 1}`,
        testTitle: pa.exam?.title || `BRAINROS Mock Test - ${idx + 1}`,
        date: (pa.submittedAt || pa.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        score: pScore,
        maxScore: pMax,
        percentile: pPercentile,
        rank: pRankRec?.rank ?? null,
      };
    });

    // Ensure current test is included if not already in history
    if (!historyPoints.some((p) => p.testTitle === exam.title)) {
      historyPoints.push({
        testNumber: `Test 0${historyPoints.length + 1}`,
        testTitle: exam.title,
        date: (attempt.submittedAt || attempt.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        score: result.totalScore,
        maxScore: result.maxScore,
        percentile: overallPercentile,
        rank: estimatedRank,
      });
    }

    let trajectory: 'UPWARD' | 'STABLE' | 'FLUCTUATING' | 'INSUFFICIENT_DATA' = 'INSUFFICIENT_DATA';
    let trendSummary = `Baseline performance recorded at ${result.totalScore}/${result.maxScore} marks.`;
    if (historyPoints.length >= 2) {
      const scores = historyPoints.map((h) => h.score);
      const isAscending = scores.every((val, i, arr) => i === 0 || val >= arr[i - 1]);
      const isDescending = scores.every((val, i, arr) => i === 0 || val <= arr[i - 1]);

      if (isAscending) {
        trajectory = 'UPWARD';
        trendSummary = `Trend: ${scores.join(' → ')}. Consistent upward performance trend across mock tests.`;
      } else if (isDescending) {
        trajectory = 'FLUCTUATING';
        trendSummary = `Trend: ${scores.join(' → ')}. Score dip observed. Prioritize high-yield revision and error analysis.`;
      } else {
        trajectory = 'STABLE';
        trendSummary = `Trend: ${scores.join(' → ')}. Steady preparation level maintained with opportunities for score breakout.`;
      }
    }

    const section9PerformanceTrend: PerformanceTrendSection = {
      history: historyPoints,
      trendSummary,
      trajectory,
    };

    // SECTION 10: Expected Performance Targets
    const currScore = result.totalScore;
    const maxScore = result.maxScore;
    const shortTerm = Math.min(maxScore, currScore + Math.max(20, Math.round((maxScore - currScore) * 0.25)));
    const strongTarget = Math.min(maxScore, currScore + Math.max(45, Math.round((maxScore - currScore) * 0.5)));
    const excellentTarget = Math.min(maxScore, Math.max(strongTarget + 20, Math.round(maxScore * 0.92)));

    const section10ExpectedPerformance: ExpectedPerformanceSection =
      aiPredictions?.expectedPerformance?.shortTermTarget
        ? aiPredictions.expectedPerformance
        : {
            currentScore: currScore,
            maxScore,
            shortTermTarget: shortTerm,
            strongTarget: strongTarget,
            excellentTarget: excellentTarget,
            actionableMessage: 'Focus on accuracy, revision of priority weak chapters, and elimination of avoidable calculation mistakes to move to the next competitive bracket.',
          };

    // SECTION 11: 14-Day Improvement Plan
    const sortedWeakChapters = [...criticalFocusChapters, ...revisionNeededChapters, ...chapterItems]
      .filter((v, i, a) => a.findIndex((t) => t.chapterId === v.chapterId) === i)
      .sort((a, b) => a.accuracy - b.accuracy);

    const s1Chaps = sortedWeakChapters.filter((c) => c.subjectName === (subjectItems[0]?.subjectName || 'Physics')).slice(0, 3).map((c) => c.chapterName);
    const s2Chaps = sortedWeakChapters.filter((c) => c.subjectName === (subjectItems[1]?.subjectName || 'Chemistry')).slice(0, 3).map((c) => c.chapterName);
    const s3Chaps = sortedWeakChapters.filter((c) => c.subjectName === (subjectItems[2]?.subjectName || 'Biology') || c.subjectName === (subjectItems[2]?.subjectName || 'Mathematics')).slice(0, 3).map((c) => c.chapterName);

    const blocks: FourteenDayPlanDayBlock[] = [
      {
        period: 'Days 1–3',
        title: `${subjectItems[0]?.subjectName || 'Physics'} Focus & Numerical Drilling`,
        subject: subjectItems[0]?.subjectName || 'Physics',
        focusChapters: s1Chaps.length > 0 ? s1Chaps : ['Mechanics', 'Electrostatics', 'Optics'],
        activities: [
          'Core formula derivation and concept reinforcement',
          'Solve 50–75 standard numerical problems daily',
          'Review previous mistakes and note key traps',
        ],
        practiceVolume: '50–75 questions/day',
      },
      {
        period: 'Days 4–6',
        title: `${subjectItems[1]?.subjectName || 'Chemistry'} High-Yield & Physical Chemistry`,
        subject: subjectItems[1]?.subjectName || 'Chemistry',
        focusChapters: s2Chaps.length > 0 ? s2Chaps : ['Equilibrium', 'Electrochemistry', 'Organic Mechanisms'],
        activities: [
          'Physical Chemistry calculation drills & formula sheet revision',
          'NCERT line-by-line reading for Inorganic reactions',
          'Reaction mechanisms and reagent charts for Organic chemistry',
        ],
        practiceVolume: '60–80 questions/day',
      },
      {
        period: 'Days 7–9',
        title: `${subjectItems[2]?.subjectName || 'Biology / Math'} Intensive Theory & Problem Solving`,
        subject: subjectItems[2]?.subjectName || 'Biology',
        focusChapters: s3Chaps.length > 0 ? s3Chaps : ['Physiology', 'Genetics', 'Calculus'],
        activities: [
          'NCERT diagram review and factual memorization drills',
          'High-frequency PYQ (Previous Year Questions) practice',
          'Timed section drills under 45 minutes',
        ],
        practiceVolume: '70–90 questions/day',
      },
      {
        period: 'Days 10–11',
        title: 'Mixed Practice & Error Notebook Remediation',
        focusChapters: ['All Priority Weak Areas', 'Error Notebook Questions'],
        activities: [
          'Solve 100+ mixed-subject questions from previous mistakes',
          'Re-attempt all incorrect questions from this BRAINROS test',
          'Speed drilling with 60-second time limits per question',
        ],
        practiceVolume: '100 questions/day',
      },
      {
        period: 'Day 12',
        title: 'Full-Length BRAINROS Mock Test',
        focusChapters: ['Full Exam Syllabus'],
        activities: [
          'Take full-length 3-hour timed exam under strict exam conditions',
          'Execute Round 1, Round 2, Round 3 time management strategy',
          'Strictly adhere to 50-50 elimination rule to minimize guessing',
        ],
        practiceVolume: 'Full Length Test',
      },
      {
        period: 'Day 13',
        title: 'Deep Error Audit & Root-Cause Analysis',
        focusChapters: ['Mock Test Errors', 'Calculation Slips'],
        activities: [
          'Audit every wrong and unattempted question from Day 12 test',
          'Classify errors into Conceptual, Calculation, and Silly mistakes',
          'Update Error Notebook with corrected solutions and derivations',
        ],
        practiceVolume: 'Comprehensive Review',
      },
      {
        period: 'Day 14',
        title: 'Final Rapid Revision & Formula Sheets',
        focusChapters: ['High-Weightage Formulas', 'NCERT Highlights'],
        activities: [
          'Rapid flashcard and formula handbook revision across all subjects',
          'Review summary tables, named reactions, and physical constants',
          'Mental preparation, relaxation, and exam pacing review',
        ],
        practiceVolume: 'Rapid Recall',
      },
    ];

    const section11FourteenDayPlan: FourteenDayImprovementPlanSection =
      aiPredictions?.fourteenDayPlan?.blocks?.length
        ? aiPredictions.fourteenDayPlan
        : { blocks };

    // SECTION 12: Personalized Action Checklist
    const section12ActionChecklist: PersonalizedActionChecklistSection =
      aiPredictions?.actionChecklist?.items?.length
        ? aiPredictions.actionChecklist
        : {
            items: [
              {
                id: 'act-1',
                text: `Revise weak chapters (${priorityWeaknesses[0] || 'core concepts'}) every 3 days without fail.`,
                category: 'Revision',
                isKeyAction: true,
              },
              {
                id: 'act-2',
                text: 'Maintain an Error Notebook and log every incorrect question immediately.',
                category: 'Error Reduction',
                isKeyAction: true,
              },
              {
                id: 'act-3',
                text: `Practise at least 50 ${subjectItems[0]?.subjectName || 'Physics'} numerical problems daily.`,
                category: 'Practice',
                isKeyAction: true,
              },
              {
                id: 'act-4',
                text: 'Revise NCERT textbook line-by-line and review all highlighted summaries.',
                category: 'Theory',
                isKeyAction: false,
              },
              {
                id: 'act-5',
                text: 'Analyse root causes of every incorrect question before moving to the next chapter.',
                category: 'Error Reduction',
                isKeyAction: true,
              },
              {
                id: 'act-6',
                text: 'Avoid blind guessing and strictly apply the 50-50 elimination rule during tests.',
                category: 'Strategy',
                isKeyAction: true,
              },
              {
                id: 'act-7',
                text: 'Improve calculation speed by doing scratch-pad arithmetic neatly in designated columns.',
                category: 'Speed',
                isKeyAction: false,
              },
              {
                id: 'act-8',
                text: 'Take every BRAINROS mock exam under actual, uninterrupted examination conditions.',
                category: 'Discipline',
                isKeyAction: true,
              },
            ],
          };

    // SECTION 13: Parent Summary
    const strongSubjectNames = subjectItems.filter((s) => s.accuracy >= 75).map((s) => s.subjectName).join(' and ') || subjectItems[0]?.subjectName || 'Core Subjects';
    const weakSubjectNames = subjectItems.filter((s) => s.accuracy < 70).map((s) => s.subjectName).join(' and ') || 'analytical problem solving';

    const percentileStr = overallPercentile !== null ? `with a ${overallPercentile} percentile` : '';
    const parentParagraph = `Your ward ${student?.name || 'the student'} has achieved ${result.totalScore}/${result.maxScore} marks (${Math.round(result.percentage * 10) / 10}%) ${percentileStr}, demonstrating a ${section2OverallPerformance.performanceLevel.toLowerCase()} level of preparation. The student performed particularly well in ${strongSubjectNames}, while the major opportunity for score gain is in ${weakSubjectNames}, along with reducing avoidable calculation and silly mistakes. With focused chapter revision and regular analysis of BRAINROS mock tests, the student has the potential to move towards the ${shortTerm}–${strongTarget}+ score range. The objective is not simply taking more tests, but analysing every test and converting mistakes into marks.`;

    const section13ParentSummary: ParentSummarySection =
      aiPredictions?.parentSummary?.summaryParagraph
        ? aiPredictions.parentSummary
        : {
            summaryParagraph: parentParagraph,
            keyHighlights: [
              `Scored ${result.totalScore}/${result.maxScore} (${Math.round(result.percentage * 10) / 10}%) with ${Math.round(result.accuracy * 10) / 10}% accuracy.`,
              `Solid performance in ${strongSubjectNames}.`,
              `Immediate score gain opportunity of ~${Math.max(10, potentialRecoverableMarks)} marks in ${weakSubjectNames}.`,
            ],
            potentialScoreRange: `${shortTerm}–${strongTarget}+`,
          };

    // SECTION 14: BRAINROS Performance Index
    const academicStrengthStars = Math.min(5, Math.max(1, Math.round((result.percentage / 20) * 10) / 10));
    const conceptualStars = Math.min(5, Math.max(1, Math.round((result.accuracy / 20) * 10) / 10));
    const accuracyStars = Math.min(5, Math.max(1, Math.round((result.accuracy / 20) * 10) / 10));
    const timeMgmtStars = Math.min(5, Math.max(1, Math.round((optimalPaceCount / Math.max(1, optimalPaceCount + rushedCount + overthoughtCount)) * 5 * 10) / 10));
    const revisionLevelStars = Math.min(5, Math.max(1, Math.round(((masteredChapters.length + revisionNeededChapters.length * 0.5) / Math.max(1, chapterItems.length)) * 5 * 10) / 10));
    const examReadinessStars = Math.min(5, Math.max(1, Math.round(((academicStrengthStars + accuracyStars + timeMgmtStars) / 3) * 10) / 10));

    const performanceMetrics: PerformanceIndexMetric[] = [
      { dimension: 'Academic Strength', ratingStars: academicStrengthStars, ratingLabel: `${academicStrengthStars.toFixed(1)}/5.0` },
      { dimension: 'Conceptual Understanding', ratingStars: conceptualStars, ratingLabel: `${conceptualStars.toFixed(1)}/5.0` },
      { dimension: 'Accuracy', ratingStars: accuracyStars, ratingLabel: `${accuracyStars.toFixed(1)}/5.0` },
      { dimension: 'Time Management', ratingStars: timeMgmtStars, ratingLabel: `${timeMgmtStars.toFixed(1)}/5.0` },
      { dimension: 'Revision Level', ratingStars: revisionLevelStars, ratingLabel: `${revisionLevelStars.toFixed(1)}/5.0` },
      { dimension: 'Exam Readiness', ratingStars: examReadinessStars, ratingLabel: `${examReadinessStars.toFixed(1)}/5.0` },
    ];

    const overallRatingStr = (result.percentage >= 85 || result.accuracy >= 85)
      ? 'EXCELLENT'
      : (result.percentage >= 70 || result.accuracy >= 75)
      ? 'VERY GOOD'
      : result.percentage >= 55
      ? 'GOOD'
      : 'NEEDS ATTENTION';

    const section14PerformanceIndex: BrainrosPerformanceIndexSection =
      aiPredictions?.performanceIndex?.metrics?.length
        ? aiPredictions.performanceIndex
        : {
            metrics: performanceMetrics,
            overallRating: overallRatingStr,
          };

    return {
      attemptId,
      examId: exam.id,
      examTitle: exam.title,
      examTargetName: exam.examTarget.name,
      calculatedAt: result.calculatedAt,
      thresholdsUsed: thresholds,
      aiMetadata: aiPredictions?.metadata,
      overall,
      subjects: {
        items: subjectItems,
        strongestSubject,
        weakestSubject,
      },
      chapters: {
        items: chapterItems,
        mastered: masteredChapters,
        revisionNeeded: revisionNeededChapters,
        criticalFocus: criticalFocusChapters,
      },
      timeAnalysis,
      attemptStrategy,
      recommendations,

      // 14 Canonical Sections (with direct and section-numbered aliases)
      studentDetails: section1StudentDetails,
      overallPerformance: section2OverallPerformance,
      subjectWiseAnalysis: section3SubjectWiseAnalysis,
      subjectPerformance: section4SubjectPerformance,
      topicWisePerformance: section5TopicWisePerformance,
      strengthWeaknessAnalysis: section6StrengthWeakness,
      errorAnalysis: section7ErrorAnalysis,
      timeManagement: section8TimeManagement,
      performanceTrend: section9PerformanceTrend,
      expectedPerformance: section10ExpectedPerformance,
      improvementPlan: section11FourteenDayPlan,
      actionChecklist: section12ActionChecklist,
      parentSummary: section13ParentSummary,
      performanceIndex: section14PerformanceIndex,

      // Section numbered keys for backward compatibility
      section1StudentDetails,
      section2OverallPerformance,
      section3SubjectWiseAnalysis,
      section4SubjectPerformance,
      section5TopicWisePerformance,
      section6StrengthWeakness,
      section7ErrorAnalysis,
      section8TimeManagement,
      section9PerformanceTrend,
      section10ExpectedPerformance,
      section11FourteenDayPlan,
      section12ActionChecklist,
      section13ParentSummary,
      section14PerformanceIndex,
    };
  }

  // ── Helper: Evaluate answer correctness ─────────────────────────────────
  private isAnswerCorrect(question: any, answer: any): boolean {
    const code = question.questionType?.code;
    if (!answer) return false;

    switch (code) {
      case 'SCQ':
      case 'TF':
      case 'AR': {
        if (!answer.selectedOptionId) return false;
        const correctOpt = question.options?.find((o: any) => o.isCorrect);
        return correctOpt ? answer.selectedOptionId === correctOpt.id : false;
      }
      case 'MCQ': {
        const selected = answer.selectedOptions as string[] | null;
        if (!selected || selected.length === 0) return false;
        const correctIds = new Set<string>(
          question.options
            ?.filter((o: any) => o.isCorrect)
            .map((o: any) => o.id) || [],
        );
        const selectedSet = new Set<string>(selected);
        if (correctIds.size !== selectedSet.size) return false;
        for (const id of correctIds) {
          if (!selectedSet.has(id)) return false;
        }
        return true;
      }
      case 'NUM': {
        if (
          answer.numericalAnswer === null ||
          answer.numericalAnswer === undefined
        )
          return false;
        const correctVal = question.correctAnswer;
        if (correctVal === null || correctVal === undefined) return false;
        if (typeof correctVal === 'number') {
          return Math.abs(answer.numericalAnswer - correctVal) < 0.001;
        }
        if (
          typeof correctVal === 'object' &&
          correctVal.min !== undefined &&
          correctVal.max !== undefined
        ) {
          return (
            answer.numericalAnswer >= correctVal.min &&
            answer.numericalAnswer <= correctVal.max
          );
        }
        return false;
      }
      default:
        return false;
    }
  }

  // ── Helper: Determine speed-accuracy quadrant ───────────────────────────
  private determineQuadrant(
    accuracy: number,
    avgTime: number,
    benchmarkTime: number,
  ):
    | 'FAST_AND_ACCURATE'
    | 'SLOW_AND_ACCURATE'
    | 'RUSHED_AND_INACCURATE'
    | 'SLOW_AND_STRUGGLING' {
    const isAccurate = accuracy >= 70;
    const isFast = avgTime <= benchmarkTime;

    if (isAccurate && isFast) return 'FAST_AND_ACCURATE';
    if (isAccurate && !isFast) return 'SLOW_AND_ACCURATE';
    if (!isAccurate && isFast) return 'RUSHED_AND_INACCURATE';
    return 'SLOW_AND_STRUGGLING';
  }

  // ── Helper: Generate prioritized actionable recommendations ─────────────
  private generateRecommendations(params: {
    criticalFocusChapters: ChapterAnalyticsItem[];
    revisionNeededChapters: ChapterAnalyticsItem[];
    weakestSubject: SubjectAnalyticsItem | null;
    totalNegativeMarksLost: number;
    timeAnalysis: TimeAnalyticsReport;
    examTargetName: string;
    defaultMarks: number;
  }): ActionableRecommendation[] {
    const recs: ActionableRecommendation[] = [];
    let idCounter = 1;

    // 1. Critical chapters
    const validCritical = params.criticalFocusChapters.filter(
      (c) => c.totalQuestions >= 2,
    );
    for (const chap of validCritical.slice(0, 3)) {
      const potentialGain =
        (chap.wrong + chap.unattempted) * params.defaultMarks;
      const isLowSample = chap.totalQuestions < 4;
      recs.push({
        id: `rec-${idCounter++}`,
        category: 'CHAPTER_REVISION',
        priority: isLowSample ? 'MEDIUM' : 'HIGH',
        title: `Master ${chap.chapterName} (${chap.subjectName})`,
        description: isLowSample
          ? `Current test data indicates ${chap.accuracy}% accuracy (${chap.wrong} incorrect out of ${chap.totalQuestions} questions). Review key concepts.`
          : `Accuracy is currently ${chap.accuracy}% across ${chap.totalQuestions} questions (${chap.wrong} incorrect). Immediate conceptual revision required.`,
        impactScore: potentialGain,
        actionStep: `Solve 25+ practice problems from ${chap.chapterName} focusing on core formulas and high-yield questions.`,
      });
    }

    // 2. Negative marking reduction
    if (params.totalNegativeMarksLost >= 4) {
      recs.push({
        id: `rec-${idCounter++}`,
        category: 'NEGATIVE_MARKING',
        priority: params.totalNegativeMarksLost >= 8 ? 'HIGH' : 'MEDIUM',
        title: `Curtail Uncalculated Guessing (−${params.totalNegativeMarksLost} Marks)`,
        description: `You lost ${params.totalNegativeMarksLost} marks to negative penalty. Eliminating blind guesses will instantly boost your net score.`,
        impactScore: params.totalNegativeMarksLost,
        actionStep: `Apply the 50-50 elimination rule: Only attempt questions where you can eliminate at least 2 options with certainty.`,
      });
    }

    // 3. Time management / pacing advice
    if (
      params.timeAnalysis.avgTimeOnWrongSeconds >
        params.timeAnalysis.avgTimeOnCorrectSeconds * 1.5 &&
      params.timeAnalysis.avgTimeOnWrongSeconds > 60
    ) {
      recs.push({
        id: `rec-${idCounter++}`,
        category: 'TIME_MANAGEMENT',
        priority: 'MEDIUM',
        title: `Optimize Time on Difficult Questions`,
        description: `You spent an average of ${params.timeAnalysis.avgTimeOnWrongSeconds}s on wrong answers vs ${params.timeAnalysis.avgTimeOnCorrectSeconds}s on correct answers.`,
        impactScore: 6,
        actionStep: `Set a 90-second cut-off: If you cannot find a clear approach within 90 seconds, mark for review and move on.`,
      });
    }

    // 4. Weakest subject intervention
    if (params.weakestSubject && params.weakestSubject.accuracy < 60) {
      recs.push({
        id: `rec-${idCounter++}`,
        category: 'ATTEMPT_STRATEGY',
        priority: 'MEDIUM',
        title: `Boost ${params.weakestSubject.subjectName} Foundation`,
        description: `${params.weakestSubject.subjectName} is your lowest-scoring subject at ${params.weakestSubject.accuracy}% accuracy (${params.weakestSubject.score}/${params.weakestSubject.maxScore} marks).`,
        impactScore: 12,
        actionStep: `Dedicate 45 minutes daily to ${params.weakestSubject.subjectName} chapter summaries and standard mock problems.`,
      });
    }

    // 5. Revision needed chapters
    for (const chap of params.revisionNeededChapters.slice(0, 2)) {
      recs.push({
        id: `rec-${idCounter++}`,
        category: 'CHAPTER_REVISION',
        priority: 'LOW',
        title: `Polish ${chap.chapterName} (${chap.accuracy}%)`,
        description: `Good foundation, but accuracy can be pushed from ${chap.accuracy}% to 90%+ with targeted question drills.`,
        impactScore: chap.wrong * params.defaultMarks,
        actionStep: `Review incorrect questions from this test and note down mistake patterns in your revision notebook.`,
      });
    }

    return recs;
  }
}
