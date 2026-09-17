import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalysisEngineService } from './services/analysis-engine.service';
import { ResultAccessService } from './services/result-access.service';
import {
  DEFAULT_PERFORMANCE_THRESHOLDS,
  PerformanceThresholds,
} from './interfaces/analysis.interface';
import { ResultStatusEnum } from './interfaces/result-lifecycle.interface';
import { ExamReportPdfService, ExamReportPdfData } from '../admin/services/exam-report-pdf.service';
import { ResendEmailService } from '../admin/services/resend-email.service';

@Injectable()
export class ResultService {
  private readonly logger = new Logger(ResultService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisEngine: AnalysisEngineService,
    private readonly resultAccessService: ResultAccessService,
    private readonly pdfService: ExamReportPdfService,
    private readonly resendEmailService: ResendEmailService,
  ) {}

  /**
   * Calculate and persist results for a submitted attempt.
   * Runs as a single atomic transaction.
   * Strictly idempotent — safe to retry without duplicate records.
   */
  async calculateResult(attemptId: string) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        status: true,
        result: {
          include: {
            subjectResults: true,
            chapterResults: true,
          },
        },
        exam: {
          include: {
            scoringRules: { include: { questionType: true } },
          },
        },
        timeLogs: true,
      },
    });

    if (!attempt) throw new NotFoundException('Attempt not found');
    if (!['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'].includes(attempt.status.name)) {
      throw new BadRequestException(
        'Attempt must be submitted before calculating results',
      );
    }

    // Skip recalculation if complete result already exists
    if (
      attempt.result &&
      attempt.result.totalScore !== undefined &&
      attempt.result.totalScore !== null &&
      attempt.result.subjectResults?.length > 0
    ) {
      return attempt.result;
    }

    // Resolve configurable thresholds per exam
    let thresholds = DEFAULT_PERFORMANCE_THRESHOLDS;
    if (
      attempt.exam.performanceThresholds &&
      typeof attempt.exam.performanceThresholds === 'object'
    ) {
      const custom = attempt.exam
        .performanceThresholds as Partial<PerformanceThresholds>;
      thresholds = {
        excellent: custom.excellent ?? DEFAULT_PERFORMANCE_THRESHOLDS.excellent,
        strong: custom.strong ?? DEFAULT_PERFORMANCE_THRESHOLDS.strong,
        good: custom.good ?? DEFAULT_PERFORMANCE_THRESHOLDS.good,
        weak: custom.weak ?? DEFAULT_PERFORMANCE_THRESHOLDS.weak,
      };
    }

    // Fetch all exam questions with their correct answers
    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId: attempt.examId },
      include: {
        question: {
          include: {
            questionType: true,
            options: { select: { id: true, isCorrect: true } },
            answer: true,
          },
        },
        section: { select: { subjectId: true } },
      },
    });

    // Fetch student answers
    const answers = await this.prisma.answer.findMany({
      where: { attemptId },
    });
    const answerMap = new Map(answers.map((a) => [a.examQuestionId, a]));

    // Map time logs
    const questionTimeMap = new Map<string, number>();
    for (const log of attempt.timeLogs) {
      const prev = questionTimeMap.get(log.examQuestionId) || 0;
      questionTimeMap.set(log.examQuestionId, prev + log.timeSpentSeconds);
    }

    // Build scoring rules map: questionTypeId -> { marks, negativeMarks }
    const scoringRules = new Map<
      string,
      { marks: number; negativeMarks: number }
    >();
    for (const rule of attempt.exam.scoringRules) {
      if (rule.questionTypeId) {
        scoringRules.set(rule.questionTypeId, {
          marks: rule.marksPerQuestion,
          negativeMarks: rule.negativeMarksPerQuestion,
        });
      }
    }

    // ─── Score each question ───────────────────────────────────
    let totalCorrect = 0;
    let totalWrong = 0;
    let totalUnattempted = 0;
    let totalScore = 0;
    let maxScore = 0;

    // Subject-level accumulators
    const subjectMap = new Map<
      string,
      {
        totalQuestions: number;
        correct: number;
        wrong: number;
        unattempted: number;
        score: number;
        maxScore: number;
        timeSpent: number;
      }
    >();

    // Chapter-level accumulators
    const chapterMap = new Map<
      string,
      {
        totalQuestions: number;
        correct: number;
        wrong: number;
        unattempted: number;
        score: number;
        maxScore: number;
        timeSpent: number;
      }
    >();

    for (const eq of examQuestions) {
      const answer = answerMap.get(eq.id);
      const question = eq.question;
      const subjectId = eq.section.subjectId;
      const chapterId = question.chapterId;
      const timeSpent = questionTimeMap.get(eq.id) || 0;

      // Determine marks for this question
      const rule = question.questionTypeId
        ? scoringRules.get(question.questionTypeId)
        : undefined;
      const marksForCorrect =
        eq.marks ?? rule?.marks ?? attempt.exam.defaultMarksPerQuestion;
      const marksForWrong =
        eq.negativeMarks ??
        rule?.negativeMarks ??
        attempt.exam.defaultNegativeMarks;

      maxScore += marksForCorrect;

      // Init accumulators
      if (!subjectMap.has(subjectId)) {
        subjectMap.set(subjectId, {
          totalQuestions: 0,
          correct: 0,
          wrong: 0,
          unattempted: 0,
          score: 0,
          maxScore: 0,
          timeSpent: 0,
        });
      }
      if (!chapterMap.has(chapterId)) {
        chapterMap.set(chapterId, {
          totalQuestions: 0,
          correct: 0,
          wrong: 0,
          unattempted: 0,
          score: 0,
          maxScore: 0,
          timeSpent: 0,
        });
      }

      const subj = subjectMap.get(subjectId)!;
      const chap = chapterMap.get(chapterId)!;
      subj.totalQuestions++;
      subj.maxScore += marksForCorrect;
      subj.timeSpent += timeSpent;
      chap.totalQuestions++;
      chap.maxScore += marksForCorrect;
      chap.timeSpent += timeSpent;

      if (
        !answer ||
        (!answer.selectedOptionId &&
          answer.numericalAnswer === null &&
          !answer.selectedOptions)
      ) {
        totalUnattempted++;
        subj.unattempted++;
        chap.unattempted++;
        continue;
      }

      // Evaluate correctness
      const isCorrect = this.evaluateAnswer(question, answer);

      if (isCorrect) {
        totalCorrect++;
        totalScore += marksForCorrect;
        subj.correct++;
        subj.score += marksForCorrect;
        chap.correct++;
        chap.score += marksForCorrect;
      } else {
        totalWrong++;
        totalScore -= marksForWrong;
        subj.wrong++;
        subj.score -= marksForWrong;
        chap.wrong++;
        chap.score -= marksForWrong;
      }
    }

    const totalQuestions = examQuestions.length;
    const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
    const attempted = totalCorrect + totalWrong;
    const accuracy = attempted > 0 ? (totalCorrect / attempted) * 100 : 0;

    // Time calculations
    const startedAt = attempt.startedAt
      ? new Date(attempt.startedAt).getTime()
      : 0;
    const submittedAt = attempt.submittedAt
      ? new Date(attempt.submittedAt).getTime()
      : Date.now();
    const timeUsedSeconds = Math.max(
      0,
      Math.floor((submittedAt - startedAt) / 1000),
    );
    const averageTimePerQuestion =
      totalQuestions > 0
        ? Math.round((timeUsedSeconds / totalQuestions) * 10) / 10
        : 0;

    // ─── Persist results in atomic transaction ─────────────────
    await this.prisma.$transaction(
      async (tx) => {
        // Upsert Result to guarantee idempotency on retries
        const result = await tx.result.upsert({
          where: { attemptId },
          update: {
            resultStatus: ResultStatusEnum.EVALUATED,
            totalQuestions,
            correctAnswers: totalCorrect,
            wrongAnswers: totalWrong,
            unattempted: totalUnattempted,
            totalScore: Math.max(totalScore, 0),
            maxScore,
            percentage: Math.round(percentage * 100) / 100,
            accuracy: Math.round(accuracy * 100) / 100,
            timeUsedSeconds,
            averageTimePerQuestion,
            calculatedAt: new Date(),
          },
          create: {
            attemptId,
            resultStatus: ResultStatusEnum.EVALUATED,
            totalQuestions,
            correctAnswers: totalCorrect,
            wrongAnswers: totalWrong,
            unattempted: totalUnattempted,
            totalScore: Math.max(totalScore, 0),
            maxScore,
            percentage: Math.round(percentage * 100) / 100,
            accuracy: Math.round(accuracy * 100) / 100,
            timeUsedSeconds,
            averageTimePerQuestion,
            calculatedAt: new Date(),
          },
        });

        // Clean any existing subject/chapter results to prevent duplicate key errors on retry
        await tx.subjectResult.deleteMany({
          where: { resultId: result.id },
        });
        await tx.chapterResult.deleteMany({
          where: { resultId: result.id },
        });

        // Subject results
        const subjectResultsData: any[] = [];
        for (const [subjectId, data] of subjectMap.entries()) {
          const subjAttempted = data.correct + data.wrong;
          const subjAccuracy =
            subjAttempted > 0 ? (data.correct / subjAttempted) * 100 : 0;
          const subjPercentage =
            data.maxScore > 0
              ? Math.round((data.score / data.maxScore) * 10000) / 100
              : 0;
          const performanceStatus = this.analysisEngine.evaluateStatus(
            subjAccuracy,
            subjAttempted,
            thresholds,
          );

          subjectResultsData.push({
            resultId: result.id,
            subjectId,
            totalQuestions: data.totalQuestions,
            correctAnswers: data.correct,
            wrongAnswers: data.wrong,
            unattempted: data.unattempted,
            score: Math.max(data.score, 0),
            maxScore: data.maxScore,
            accuracy: subjAccuracy,
            percentage: subjPercentage,
            timeSpentSeconds: data.timeSpent,
            averageTimePerQuestion:
              data.totalQuestions > 0
                ? Math.round((data.timeSpent / data.totalQuestions) * 10) / 10
                : 0,
            performanceStatus,
          });
        }

        if (subjectResultsData.length > 0) {
          await tx.subjectResult.createMany({ data: subjectResultsData });
        }

        // Chapter results
        const chapterResultsData: any[] = [];
        for (const [chapterId, data] of chapterMap.entries()) {
          const chapAttempted = data.correct + data.wrong;
          const chapAccuracy =
            chapAttempted > 0 ? (data.correct / chapAttempted) * 100 : 0;
          const chapPercentage =
            data.maxScore > 0
              ? Math.round((data.score / data.maxScore) * 10000) / 100
              : 0;
          const performanceStatus = this.analysisEngine.evaluateStatus(
            chapAccuracy,
            chapAttempted,
            thresholds,
          );

          chapterResultsData.push({
            resultId: result.id,
            chapterId,
            totalQuestions: data.totalQuestions,
            correctAnswers: data.correct,
            wrongAnswers: data.wrong,
            unattempted: data.unattempted,
            score: Math.max(data.score, 0),
            maxScore: data.maxScore,
            accuracy: chapAccuracy,
            percentage: chapPercentage,
            timeSpentSeconds: data.timeSpent,
            averageTimePerQuestion:
              data.totalQuestions > 0
                ? Math.round((data.timeSpent / data.totalQuestions) * 10) / 10
                : 0,
            performanceStatus,
          });
        }

        if (chapterResultsData.length > 0) {
          await tx.chapterResult.createMany({ data: chapterResultsData });
        }
      },
      {
        maxWait: 15000,
        timeout: 30000,
      },
    );

    // Invalidate Redis caches after transaction commits
    await this.resultAccessService.invalidateResultCache(
      attemptId,
      attempt.studentId,
      attempt.examId,
    );

    return this.prisma.result.findUnique({
      where: { attemptId },
      include: {
        subjectResults: true,
        chapterResults: true,
      },
    });
  }

  /**
   * Get student attempt calculation and publication status.
   * Centralized via ResultAccessService.
   */
  async getAttemptResultStatus(attemptId: string, user?: any) {
    return this.resultAccessService.getResultStatus(user, attemptId);
  }

  /**
   * Get basic result for an attempt.
   * PURE READ-ONLY. Never recalculates or modifies results.
   */
  async getResult(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return this.resultAccessService.getResultStatus(user, attemptId);
      }
    }

    const result = await this.prisma.result.findUnique({
      where: { attemptId },
      include: {
        attempt: {
          select: {
            id: true,
            examId: true,
            startedAt: true,
            submittedAt: true,
            exam: {
              select: {
                id: true,
                title: true,
                totalQuestions: true,
                totalMarks: true,
                durationMinutes: true,
                performanceThresholds: true,
                examTarget: { select: { id: true, name: true } },
              },
            },
          },
        },
        subjectResults: { include: { subject: true } },
        chapterResults: { include: { chapter: { include: { subject: true } } } },
      },
    });

    if (!result) {
      throw new NotFoundException(
        'Result not found. Exam may not be submitted or evaluated yet.',
      );
    }
    return result;
  }

  /**
   * Get Full Comprehensive Brainros Analysis Report.
   * PURE READ-ONLY. Does not re-trigger calculation.
   */
  async getFullAnalysis(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return this.resultAccessService.getResultStatus(user, attemptId);
      }
    }

    const existingResult = await this.prisma.result.findUnique({
      where: { attemptId },
    });

    if (!existingResult) {
      throw new NotFoundException(
        'Analysis not available. Result has not been calculated yet.',
      );
    }

    return this.analysisEngine.generateFullAnalysis(attemptId);
  }

  /**
   * Deep Verification of Persisted Result.
   * Checks Attempt, Result, SubjectResult, ChapterResult, TimeAnalysis, StrategyAnalysis, CandidateRank.
   */
  async verifyResult(attemptId: string) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        status: true,
        exam: {
          include: {
            schedules: { take: 1 },
          },
        },
        result: {
          include: {
            subjectResults: true,
            chapterResults: true,
          },
        },
        answers: true,
        timeAnalyses: { take: 1 },
        strategyAnalyses: { take: 1 },
        candidateRanks: { take: 1 },
      },
    });

    if (!attempt) throw new NotFoundException(`Attempt '${attemptId}' not found`);

    const state = await this.resultAccessService.verifyResultState(attempt);
    const evaluationComplete = Boolean(
      attempt.result &&
      attempt.result.totalScore !== undefined &&
      attempt.result.subjectResults?.length > 0,
    );
    const analyticsComplete = Boolean(
      attempt.timeAnalyses?.length > 0 && attempt.strategyAnalyses?.length > 0,
    );
    const rankingComplete = Boolean(attempt.candidateRanks?.length > 0);

    return {
      attemptId,
      examId: attempt.examId,
      examTitle: attempt.exam?.title,
      examType: state.isLive ? 'LIVE' : 'MOCK',
      processingStatus: state.processingStatus,
      publicationStatus: state.publicationStatus,
      resultAvailable: state.resultCalculated,
      reportAvailable: state.reportAvailable,
      onlineReportAvailable: state.onlineReportAvailable,
      evaluationComplete,
      analyticsComplete,
      rankingComplete,
      totalQuestions: attempt.result?.totalQuestions || 0,
      totalScore: attempt.result?.totalScore || 0,
      maxScore: attempt.result?.maxScore || 0,
      percentage: attempt.result?.percentage || 0,
      accuracy: attempt.result?.accuracy || 0,
      answersCount: attempt.answers?.length || 0,
      subjectBreakdowns: attempt.result?.subjectResults?.length || 0,
      chapterBreakdowns: attempt.result?.chapterResults?.length || 0,
    };
  }

  /**
   * Controlled Recalculation for Admin / Super Admin
   */
  async recalculateResult(attemptId: string, user: any, newEvaluationVersion: number = 1) {
    const userRole = (user?.role || user?.roles?.[0] || '').toUpperCase();
    if (!['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      throw new ForbiddenException(
        'Only Administrators have permission to trigger result recalculation.',
      );
    }

    this.logger.log(
      `[Recalculation] Admin '${user.userId || user.id}' recalculating attempt '${attemptId}' (version ${newEvaluationVersion})`,
    );

    // Clean existing results to ensure full recalculation
    await this.prisma.subjectResult.deleteMany({
      where: { result: { attemptId } },
    });
    await this.prisma.chapterResult.deleteMany({
      where: { result: { attemptId } },
    });
    await this.prisma.result.deleteMany({
      where: { attemptId },
    });

    const result = await this.calculateResult(attemptId);

    // Audit trail
    try {
      await this.prisma.securityEvent.create({
        data: {
          userId: user.userId || user.id,
          eventType: 'ROLE_CHANGED' as any,
          ipAddress: 'admin-action',
          metadata: {
            action: 'RESULT_RECALCULATED',
            attemptId,
            newEvaluationVersion,
            score: result?.totalScore,
            recalculatedAt: new Date().toISOString(),
          },
        },
      });
    } catch {}

    return result;
  }

  /**
   * Get subject-wise breakdown
   */
  async getSubjectResults(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return [];
      }
    }

    const result = await this.prisma.result.findUnique({
      where: { attemptId },
    });
    if (!result) throw new NotFoundException('Result not found');

    return this.prisma.subjectResult.findMany({
      where: { resultId: result.id },
      include: {
        subject: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Get chapter-wise breakdown
   */
  async getChapterResults(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return [];
      }
    }

    const result = await this.prisma.result.findUnique({
      where: { attemptId },
    });
    if (!result) throw new NotFoundException('Result not found');

    return this.prisma.chapterResult.findMany({
      where: { resultId: result.id },
      include: {
        chapter: {
          select: {
            id: true,
            name: true,
            subject: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  /**
   * Get time analysis only
   */
  async getTimeAnalysis(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return null;
      }
    }

    const full = await this.analysisEngine.generateFullAnalysis(attemptId);
    return full.timeAnalysis;
  }

  /**
   * Get attempt strategy only
   */
  async getAttemptStrategy(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return null;
      }
    }

    const full = await this.analysisEngine.generateFullAnalysis(attemptId);
    return full.attemptStrategy;
  }

  /**
   * Get recommendations only
   */
  async getRecommendations(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return [];
      }
    }

    const full = await this.analysisEngine.generateFullAnalysis(attemptId);
    return full.recommendations;
  }

  /**
   * Get detailed answer review (shows correct answers after submission/publication)
   */
  async getAnswerReview(attemptId: string, user?: any) {
    if (user) {
      const canView = await this.resultAccessService.canViewReport(user, attemptId);
      if (!canView) {
        return [];
      }
    }

    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { status: true },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (!['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'].includes(attempt.status.name)) {
      throw new BadRequestException('Exam must be submitted to view review');
    }

    // 1. Check for personalized AttemptQuestion and AttemptQuestionOption ordering
    const attemptQuestions = await this.prisma.attemptQuestion.findMany({
      where: { attemptId },
      orderBy: { displayOrder: 'asc' },
      include: {
        options: {
          orderBy: { displayOrder: 'asc' },
          include: {
            examQuestionOption: {
              include: {
                translations: true,
              },
            },
          },
        },
        examQuestion: {
          include: {
            section: { select: { name: true } },
            question: {
              include: {
                questionType: { select: { name: true, code: true } },
                translations: true,
                answer: true,
                options: {
                  orderBy: { displayOrder: 'asc' },
                  include: {
                    translations: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const answers = await this.prisma.answer.findMany({
      where: { attemptId },
    });
    const answerMap = new Map(answers.map((a) => [a.examQuestionId, a]));

    if (attemptQuestions.length > 0) {
      return attemptQuestions.map((aq) => {
        const eq = aq.examQuestion;
        const answer = answerMap.get(eq.id);
        const qTrans =
          eq.question.translations.find((t) => t.languageId === attempt.languageId) ||
          eq.question.translations[0];

        // Format options using the attempt's specific randomized option sequence
        const options =
          aq.options && aq.options.length > 0
            ? aq.options.map((opt) => {
                const o = opt.examQuestionOption;
                const oTrans =
                  o.translations.find((t) => t.languageId === attempt.languageId) ||
                  o.translations[0];
                return {
                  id: o.id,
                  optionLabel: String.fromCharCode(64 + opt.displayOrder),
                  optionKey: o.optionKey || String.fromCharCode(64 + opt.displayOrder),
                  optionText: oTrans?.optionText || o.optionText || '',
                  isCorrect: o.isCorrect,
                };
              })
            : eq.question.options.map((o) => {
                const oTrans =
                  o.translations.find((t) => t.languageId === attempt.languageId) ||
                  o.translations[0];
                return {
                  id: o.id,
                  optionLabel: o.optionLabel || o.optionKey || '',
                  optionKey: o.optionKey || o.optionLabel || '',
                  optionText: oTrans?.optionText || o.optionText || '',
                  isCorrect: o.isCorrect,
                };
              });

        return {
          displayOrder: aq.displayOrder,
          sectionName: eq.section?.name || 'General',
          questionType: eq.question.questionType,
          questionText: qTrans?.questionText || (eq.question as any).passage || '',
          explanation: qTrans?.explanation || '',
          options,
          studentAnswer: answer
            ? {
                selectedOptionId: answer.selectedOptionId,
                numericalAnswer: answer.numericalAnswer,
                selectedOptions: answer.selectedOptions,
                isMarkedForReview: answer.isMarkedForReview,
              }
            : null,
          isCorrect: answer ? this.evaluateAnswer(eq.question, answer) : false,
          isAttempted:
            !!answer &&
            (!!answer.selectedOptionId ||
              answer.numericalAnswer !== null ||
              (Array.isArray(answer.selectedOptions) &&
                answer.selectedOptions.length > 0)),
        };
      });
    }

    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId: attempt.examId },
      orderBy: { displayOrder: 'asc' },
      include: {
        section: { select: { name: true } },
        question: {
          include: {
            questionType: { select: { name: true, code: true } },
            translations: true,
            answer: true,
            options: {
              orderBy: { displayOrder: 'asc' },
              include: {
                translations: true,
              },
            },
          },
        },
      },
    });

    return examQuestions.map((eq) => {
      const answer = answerMap.get(eq.id);
      const qTrans =
        eq.question.translations.find((t) => t.languageId === attempt.languageId) ||
        eq.question.translations[0];

      return {
        displayOrder: eq.displayOrder,
        sectionName: eq.section.name,
        questionType: eq.question.questionType,
        questionText: qTrans?.questionText || (eq.question as any).passage || '',
        explanation: qTrans?.explanation || '',
        options: eq.question.options.map((o) => {
          const oTrans =
            o.translations.find((t) => t.languageId === attempt.languageId) ||
            o.translations[0];
          return {
            id: o.id,
            optionLabel: o.optionLabel || o.optionKey || '',
            optionKey: o.optionKey || o.optionLabel || '',
            optionText: oTrans?.optionText || o.optionText || '',
            isCorrect: o.isCorrect,
          };
        }),
        studentAnswer: answer
          ? {
              selectedOptionId: answer.selectedOptionId,
              numericalAnswer: answer.numericalAnswer,
              selectedOptions: answer.selectedOptions,
              isMarkedForReview: answer.isMarkedForReview,
            }
          : null,
        isCorrect: answer ? this.evaluateAnswer(eq.question, answer) : false,
        isAttempted:
          !!answer &&
          (!!answer.selectedOptionId ||
            answer.numericalAnswer !== null ||
            (Array.isArray(answer.selectedOptions) &&
              answer.selectedOptions.length > 0)),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE: Answer Evaluation
  // ═══════════════════════════════════════════════════════════════

  private evaluateAnswer(question: any, answer: any): boolean {
    const rawType = (question.type || question.questionType?.code || '').toUpperCase();
    let normalized = 'SCQ';
    if (rawType === 'NUM' || rawType === 'NUMERICAL') normalized = 'NUM';
    else if (rawType === 'MCQ' || rawType === 'MULTIPLE_CORRECT') normalized = 'MCQ';
    else if (rawType === 'TF' || rawType === 'TRUE_FALSE') normalized = 'TF';
    else if (rawType === 'AR' || rawType === 'ASSERTION_REASON') normalized = 'AR';
    else if (rawType === 'MTF' || rawType === 'MATCH_FOLLOWING') normalized = 'MTF';
    else if (rawType === 'SCQ' || rawType === 'SINGLE_CORRECT' || rawType === 'CASE_BASED') normalized = 'SCQ';

    switch (normalized) {
      case 'SCQ':
      case 'TF':
      case 'AR':
      case 'MTF': {
        if (!answer.selectedOptionId) return false;
        const correctOption = question.options?.find((o: any) => o.isCorrect);
        return correctOption
          ? answer.selectedOptionId === correctOption.id
          : false;
      }
      case 'MCQ': {
        const selected = answer.selectedOptions as string[] | null;
        if (!selected || selected.length === 0) return false;
        const correctIds = new Set<string>(
          (question.options || [])
            .filter((o: any) => o.isCorrect)
            .map((o: any) => o.id),
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
        const correctValue = question.correctAnswer ?? question.answer?.numericalAnswer;
        if (correctValue === null || correctValue === undefined) return false;
        if (typeof correctValue === 'number') {
          return Math.abs(Number(answer.numericalAnswer) - correctValue) < 0.001;
        }
        if (typeof correctValue === 'string') {
          return Math.abs(Number(answer.numericalAnswer) - parseFloat(correctValue)) < 0.001;
        }
        if (
          typeof correctValue === 'object' &&
          correctValue.min !== undefined &&
          correctValue.max !== undefined
        ) {
          return (
            Number(answer.numericalAnswer) >= correctValue.min &&
            Number(answer.numericalAnswer) <= correctValue.max
          );
        }
        if (
          typeof correctValue === 'object' &&
          correctValue.numericalAnswer !== undefined
        ) {
          return Math.abs(Number(answer.numericalAnswer) - Number(correctValue.numericalAnswer)) < 0.001;
        }
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Generates a comprehensive 3-page PDF report for an attempt.
   * Includes overall score, accuracy, rank, percentile, subject breakdown,
   * chapter diagnosis, time pacing, attempt strategy, smart recommendations,
   * and full question response audit.
   */
  async generateResultPdf(attemptId: string, user?: any): Promise<Buffer> {
    if (user) {
      await this.resultAccessService.verifyAttemptAccess(user, attemptId);
    }

    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        exam: true,
        student: {
          include: {
            user: true,
          },
        },
        result: {
          include: {
            subjectResults: {
              include: {
                subject: true,
              },
            },
            chapterResults: {
              include: {
                chapter: {
                  include: {
                    subject: true,
                  },
                },
              },
            },
          },
        },
        candidateRanks: true,
        timeAnalyses: { take: 1, orderBy: { createdAt: 'desc' } },
        strategyAnalyses: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });

    if (!attempt) {
      throw new NotFoundException(`Attempt '${attemptId}' not found in database.`);
    }

    if (!attempt.result) {
      throw new BadRequestException(`Attempt '${attemptId}' does not have calculated results yet.`);
    }

    let fullAnalysis: any = null;
    let reviewData: any[] = [];
    try {
      fullAnalysis = await this.getFullAnalysis(attemptId);
      reviewData = await this.getAnswerReview(attemptId);
    } catch (e: any) {
      this.logger.warn(`Could not compute fullAnalysis for PDF '${attemptId}': ${e.message}`);
    }

    const overallRank = attempt.candidateRanks?.find((r) => r.rankType === 'OVERALL');
    const stateRank = attempt.candidateRanks?.find((r) => r.rankType === 'STATE');
    const districtRank = attempt.candidateRanks?.find((r) => r.rankType === 'DISTRICT');
    const schoolRank = attempt.candidateRanks?.find((r) => r.rankType === 'SCHOOL' || r.rankType === 'COLLEGE');
    const categoryRank = attempt.candidateRanks?.find((r) => r.rankType === 'CATEGORY');
    const fallbackTimeAnalysis = attempt.timeAnalyses[0];
    const fallbackStrategyAnalysis = attempt.strategyAnalyses[0];

    const pdfData: ExamReportPdfData = {
      student: {
        name: attempt.student?.name || 'Student',
        studentCode: attempt.student?.studentCode || attempt.student?.studentId || 'N/A',
        email: attempt.student?.user?.email || 'N/A',
      },
      exam: {
        title: attempt.exam?.title || 'Exam',
        examDate: attempt.exam?.examDate || attempt.startedAt || attempt.createdAt,
        totalMarks: attempt.exam?.totalMarks || attempt.result.maxScore,
        durationMinutes: attempt.exam?.durationMinutes || undefined,
        examTargetName: fullAnalysis?.examTargetName,
      },
      attempt: {
        id: attempt.id,
        submittedAt: attempt.submittedAt || attempt.updatedAt,
        score: attempt.result.totalScore,
        maxScore: attempt.result.maxScore,
        percentage: attempt.result.percentage,
        accuracy: attempt.result.accuracy,
        totalQuestions: attempt.result.totalQuestions,
        correctAnswers: attempt.result.correctAnswers,
        wrongAnswers: attempt.result.wrongAnswers,
        unattempted: attempt.result.unattempted,
        timeUsedSeconds: attempt.result.timeUsedSeconds ?? fullAnalysis?.overall?.timeUsedSeconds ?? undefined,
        formattedTimeUsed: fullAnalysis?.overall?.formattedTimeUsed,
        averageTimePerQuestion: attempt.result.averageTimePerQuestion ?? fullAnalysis?.overall?.averageTimePerQuestionSeconds ?? undefined,
        negativeMarksLost: fullAnalysis?.overall?.negativeMarksLost ?? (attempt.result.wrongAnswers * 1),
        potentialMarks: fullAnalysis?.overall?.potentialMarks,
        overallStatus: fullAnalysis?.overall?.overallStatus,
        speedAccuracyQuadrant: fullAnalysis?.overall?.speedAccuracyQuadrant,
        strongestSubject: fullAnalysis?.overall?.strongestSubject
          ? {
              name: fullAnalysis.overall.strongestSubject.name || fullAnalysis.overall.strongestSubject.subjectName,
              accuracy: fullAnalysis.overall.strongestSubject.accuracy,
              score: fullAnalysis.overall.strongestSubject.score,
              maxScore: fullAnalysis.overall.strongestSubject.maxScore,
              correct: fullAnalysis.overall.strongestSubject.correct,
              wrong: fullAnalysis.overall.strongestSubject.wrong,
              timeSpentSeconds: fullAnalysis.overall.strongestSubject.timeSpentSeconds,
              avgSpeedSeconds: fullAnalysis.overall.strongestSubject.avgSpeedSeconds,
            }
          : undefined,
        weakestSubject: fullAnalysis?.overall?.weakestSubject
          ? {
              name: fullAnalysis.overall.weakestSubject.name || fullAnalysis.overall.weakestSubject.subjectName,
              accuracy: fullAnalysis.overall.weakestSubject.accuracy,
              score: fullAnalysis.overall.weakestSubject.score,
              maxScore: fullAnalysis.overall.weakestSubject.maxScore,
              correct: fullAnalysis.overall.weakestSubject.correct,
              wrong: fullAnalysis.overall.weakestSubject.wrong,
              timeSpentSeconds: fullAnalysis.overall.weakestSubject.timeSpentSeconds,
              avgSpeedSeconds: fullAnalysis.overall.weakestSubject.avgSpeedSeconds,
            }
          : undefined,
      },
      rank: overallRank
        ? {
            rank: overallRank.rank,
            totalCandidates: overallRank.totalCandidates,
            percentile: overallRank.percentile ? Number(overallRank.percentile) : undefined,
          }
        : undefined,
      ranks: {
        overall: overallRank
          ? {
              rank: overallRank.rank,
              totalCandidates: overallRank.totalCandidates,
              percentile: overallRank.percentile ? Number(overallRank.percentile) : undefined,
            }
          : undefined,
        state: stateRank
          ? {
              rank: stateRank.rank,
              totalCandidates: stateRank.totalCandidates,
              percentile: stateRank.percentile ? Number(stateRank.percentile) : undefined,
              scopeName: stateRank.scopeName || undefined,
            }
          : undefined,
        district: districtRank
          ? {
              rank: districtRank.rank,
              totalCandidates: districtRank.totalCandidates,
              percentile: districtRank.percentile ? Number(districtRank.percentile) : undefined,
              scopeName: districtRank.scopeName || undefined,
            }
          : undefined,
        school: schoolRank
          ? {
              rank: schoolRank.rank,
              totalCandidates: schoolRank.totalCandidates,
              percentile: schoolRank.percentile ? Number(schoolRank.percentile) : undefined,
              scopeName: schoolRank.scopeName || undefined,
            }
          : undefined,
        category: categoryRank
          ? {
              rank: categoryRank.rank,
              totalCandidates: categoryRank.totalCandidates,
              percentile: categoryRank.percentile ? Number(categoryRank.percentile) : undefined,
              scopeName: categoryRank.scopeName || undefined,
            }
          : undefined,
        predictedRank: overallRank?.predictedRankMin
          ? {
              min: overallRank.predictedRankMin,
              max: overallRank.predictedRankMax || overallRank.predictedRankMin,
              confidence: overallRank.predictionConfidence || 'MEDIUM',
            }
          : undefined,
      },
      subjects: fullAnalysis?.subjects?.items?.length
        ? fullAnalysis.subjects.items.map((sub: any) => ({
            name: sub.subjectName || sub.name || 'Subject',
            score: sub.score,
            maxScore: sub.maxScore,
            accuracy: sub.accuracy,
            percentage: sub.percentage,
            correct: sub.correct,
            wrong: sub.wrong,
            unattempted: sub.unattempted,
            timeSpentSeconds: sub.timeSpentSeconds,
            avgTimePerQuestionSeconds: sub.avgTimePerQuestionSeconds,
            performanceStatus: sub.status,
            isStrongest: sub.isStrongest,
            isWeakest: sub.isWeakest,
          }))
        : attempt.result.subjectResults?.map((sr) => ({
            name: sr.subject?.name || 'Subject',
            score: sr.score,
            maxScore: sr.maxScore,
            accuracy: sr.accuracy,
            correct: sr.correctAnswers,
            wrong: sr.wrongAnswers,
            unattempted: sr.unattempted,
            performanceStatus: sr.performanceStatus || undefined,
          })),
      chapters: {
        mastered: fullAnalysis?.chapters?.mastered?.map((ch: any) => ({
          name: ch.chapterName || ch.name,
          subjectName: ch.subjectName,
          accuracy: ch.accuracy,
          totalQuestions: ch.totalQuestions,
          performanceStatus: ch.status,
        })),
        revisionNeeded: fullAnalysis?.chapters?.revisionNeeded?.map((ch: any) => ({
          name: ch.chapterName || ch.name,
          subjectName: ch.subjectName,
          accuracy: ch.accuracy,
          totalQuestions: ch.totalQuestions,
          performanceStatus: ch.status,
        })),
        criticalFocus: fullAnalysis?.chapters?.criticalFocus?.map((ch: any) => ({
          name: ch.chapterName || ch.name,
          subjectName: ch.subjectName,
          accuracy: ch.accuracy,
          totalQuestions: ch.totalQuestions,
          performanceStatus: ch.status,
        })),
      },
      timeAnalysis: fullAnalysis?.timeAnalysis
        ? {
            totalExamDurationMinutes: fullAnalysis.timeAnalysis.totalExamDurationMinutes,
            totalTimeUsedSeconds: fullAnalysis.timeAnalysis.totalTimeUsedSeconds,
            averageTimePerQuestionSeconds: fullAnalysis.timeAnalysis.averageTimePerQuestionSeconds,
            timeOnCorrectSeconds: fullAnalysis.timeAnalysis.timeOnCorrectQuestionsSeconds,
            timeOnWrongSeconds: fullAnalysis.timeAnalysis.timeOnWrongQuestionsSeconds,
            timeOnUnattemptedSeconds: fullAnalysis.timeAnalysis.timeOnUnattemptedQuestionsSeconds,
            timeWastedSeconds: fullAnalysis.timeAnalysis.timeWastedSeconds,
            fastestQuestionSeconds: fullAnalysis.timeAnalysis.fastestQuestion?.timeSeconds,
            slowestQuestionSeconds: fullAnalysis.timeAnalysis.slowestQuestion?.timeSeconds,
            pacingMetrics: fullAnalysis.timeAnalysis.pacingMetrics,
          }
        : fallbackTimeAnalysis
        ? {
            averageTimePerQuestionSeconds: (fallbackTimeAnalysis.data as any)?.avgTimePerQuestion,
            fastestQuestionSeconds: (fallbackTimeAnalysis.data as any)?.fastestQuestionTimeSeconds,
            slowestQuestionSeconds: (fallbackTimeAnalysis.data as any)?.slowestQuestionTimeSeconds,
          }
        : undefined,
      strategy: fullAnalysis?.attemptStrategy
        ? {
            negativeMarkingPenalty: fullAnalysis.attemptStrategy.negativeMarkingPenalty,
            marksLostToGuessing: fullAnalysis.attemptStrategy.marksLostToGuessing,
            scoreWithoutNegativeMarking: fullAnalysis.attemptStrategy.scoreWithoutNegativeMarking,
            attemptRatio: fullAnalysis.attemptStrategy.attemptRatio,
            accuracyVsSpeedProfile: fullAnalysis.attemptStrategy.accuracyVsSpeedProfile,
            strategicTakeaways: fullAnalysis.attemptStrategy.strategicTakeaways,
            potentialScoreGainMessage: fullAnalysis.attemptStrategy.potentialScoreGainMessage,
          }
        : fallbackStrategyAnalysis
        ? {
            overAttemptingScore: (fallbackStrategyAnalysis.data as any)?.overAttemptCount || 0,
            avoidableLossMarks: fallbackStrategyAnalysis.avoidableNegativeMarks,
            riskCategory: fallbackStrategyAnalysis.primaryClassification,
            recommendations: Array.isArray(fallbackStrategyAnalysis.recommendations)
              ? (fallbackStrategyAnalysis.recommendations as any[]).map((r: any) => typeof r === 'string' ? r : r.title || r.description || JSON.stringify(r))
              : [],
          }
        : undefined,
      recommendations: fullAnalysis?.recommendations?.map((rec: any) => ({
        category: rec.category,
        priority: rec.priority,
        title: rec.title,
        description: rec.description,
        actionStep: rec.actionStep,
        impactScore: rec.impactScore,
      })),
      questionsReview: reviewData?.map((q: any) => {
        const studentChosenOpt = q.options?.find(
          (o: any) => o.id === q.studentAnswer?.selectedOptionId,
        );
        const correctOpt = q.options?.find((o: any) => o.isCorrect);

        return {
          displayOrder: q.displayOrder,
          sectionName: q.sectionName,
          questionText: q.questionText,
          questionType:
            q.questionType?.name ||
            q.questionType?.code ||
            (typeof q.questionType === 'string' ? q.questionType : undefined),
          isAttempted: q.isAttempted,
          isCorrect: q.isCorrect,
          marksAwarded: q.marksAwarded ?? (q.isCorrect ? 4 : 0),
          negativeMarks: q.negativeMarks ?? 1,
          timeSpentSeconds: q.timeSpentSeconds,
          explanation: q.explanation,
          options:
            q.options?.map((opt: any) => ({
              id: opt.id,
              optionLabel: opt.optionLabel,
              optionKey: opt.optionKey,
              optionText: opt.optionText,
              isCorrect: opt.isCorrect,
            })) || [],
          studentAnswer: q.studentAnswer
            ? {
                selectedOptionId: q.studentAnswer.selectedOptionId,
                selectedOptionLabel: studentChosenOpt?.optionLabel,
                selectedOptionText: studentChosenOpt?.optionText,
                numericalAnswer: q.studentAnswer.numericalAnswer,
              }
            : undefined,
          correctAnswer: correctOpt
            ? {
                optionLabel: correctOpt.optionLabel,
                optionText: correctOpt.optionText,
              }
            : undefined,
        };
      }),
    };

    return await this.pdfService.generateReportPdf(pdfData);
  }

  /**
   * Dispatches the comprehensive exam performance analysis report PDF directly to the student's email.
   * Can be triggered by Admin, Super Admin, or student.
   */
  async sendReportEmail(attemptId: string, user?: any) {
    if (user) {
      await this.resultAccessService.verifyAttemptAccess(user, attemptId);
    }

    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        exam: true,
        student: {
          include: {
            user: true,
          },
        },
        result: true,
        candidateRanks: {
          where: { rankType: 'OVERALL' },
          take: 1,
        },
      },
    });

    if (!attempt) throw new NotFoundException(`Attempt '${attemptId}' not found.`);
    if (!attempt.result) throw new BadRequestException('Result has not been calculated yet.');

    const recipientEmail = attempt.student?.user?.email;
    if (!recipientEmail || !recipientEmail.includes('@')) {
      throw new BadRequestException(`Student '${attempt.student?.name}' does not have a registered email address.`);
    }

    this.logger.log(`[ResultService] Generating full PDF report to send via email for attempt '${attemptId}' to ${recipientEmail}...`);
    const pdfBuffer = await this.generateResultPdf(attemptId);

    const safeExam = attempt.exam.title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    const safeName = attempt.student.name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    const attachmentFilename = `Brainros_${safeExam}_${safeName}_Report.pdf`;

    const examDateStr = attempt.exam.examDate
      ? new Date(attempt.exam.examDate).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : 'Recently';

    const rankRow = attempt.candidateRanks?.[0];
    const rankText = rankRow?.rank ? `#${rankRow.rank.toLocaleString()}` : 'N/A';

    const emailSubject = `Brainros Exam Report - ${attempt.exam.title}`;
    const htmlBody = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.6;">
        <div style="background-color: #0f172a; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">BRAINROS</h1>
          <p style="color: #94a3b8; margin: 6px 0 0 0; font-size: 13px;">Official Live Exam Performance Report</p>
        </div>
        
        <div style="background-color: #ffffff; padding: 28px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
          <h2 style="color: #0f172a; margin-top: 0;">Hello ${attempt.student.name},</h2>
          <p>Your comprehensive performance analysis report for <strong>${attempt.exam.title}</strong> conducted on <strong>${examDateStr}</strong> is ready and attached to this email as a PDF.</p>
          
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #4f46e5; font-size: 15px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">Performance Summary</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Total Score:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #0f172a; text-align: right;">${attempt.result.totalScore} / ${attempt.result.maxScore} (${Number(attempt.result.percentage).toFixed(1)}%)</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Accuracy:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #10b981; text-align: right;">${Number(attempt.result.accuracy).toFixed(1)}%</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Overall Rank:</td>
                <td style="padding: 6px 0; font-weight: bold; color: #4f46e5; text-align: right;">${rankText}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Questions:</td>
                <td style="padding: 6px 0; color: #0f172a; text-align: right;">${attempt.result.correctAnswers} Correct, ${attempt.result.wrongAnswers} Wrong, ${attempt.result.unattempted} Skipped</td>
              </tr>
            </table>
          </div>

          <p style="font-size: 13px; color: #64748b;">The attached PDF contains complete details including subject breakdown, chapter diagnosis, time management analytics, strategy assessment, and complete question-by-question solution audit.</p>
          
          <div style="margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 18px; font-size: 12px; color: #94a3b8;">
            <p style="margin: 0;">Regards,</p>
            <p style="margin: 4px 0 0 0; font-weight: bold; color: #0f172a;">Brainros Assessment Team</p>
          </div>
        </div>
      </div>
    `;

    const sendResult = await this.resendEmailService.sendEmail({
      to: recipientEmail,
      subject: emailSubject,
      html: htmlBody,
      attachments: [
        {
          filename: attachmentFilename,
          content: pdfBuffer,
        },
      ],
    });

    if (!sendResult.success) {
      throw new BadRequestException(sendResult.error || 'Failed to dispatch report email via email provider.');
    }

    await this.prisma.examAnalysisReport.upsert({
      where: { attemptId },
      create: {
        examId: attempt.examId,
        examVersionId: attempt.examVersionId,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        status: 'EMAILED',
        emailStatus: 'SENT',
        pdfGeneratedAt: new Date(),
      },
      update: {
        status: 'EMAILED',
        emailStatus: 'SENT',
        pdfGeneratedAt: new Date(),
      },
    }).catch(() => {});

    return {
      success: true,
      message: `Detailed exam report sent to ${recipientEmail}`,
      recipientEmail,
      messageId: sendResult.messageId,
    };
  }
}

