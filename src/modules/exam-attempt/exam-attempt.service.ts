import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExamService } from '../exam/exam.service';
import { ExamAccessService } from '../exam-scheduling/services/exam-access.service';
import { QuestionTimingService } from '../time-analysis/services/question-timing.service';
import { QuestionShuffleService } from './services/question-shuffle.service';
import { RedisService } from '../redis/redis.service';
import { ResultService } from '../result/result.service';
import { ResultReadinessService } from '../result/services/result-readiness.service';
import {
  StartAttemptDto,
  SaveAnswerDto,
  BulkSaveAnswersDto,
  SaveTimeLogDto,
} from './dto/attempt.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EVALUATION_QUEUE_NAME,
  ResultStatusEnum,
} from '../result/interfaces/result-lifecycle.interface';
import { ExamCacheService } from '../exam-cache/services/exam-cache.service';

@Injectable()
export class ExamAttemptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly examService: ExamService,
    private readonly examAccessService: ExamAccessService,
    private readonly questionTimingService: QuestionTimingService,
    private readonly resultService: ResultService,
    private readonly resultReadinessService: ResultReadinessService,
    private readonly questionShuffleService: QuestionShuffleService,
    private readonly redisService: RedisService,
    private readonly examCacheService: ExamCacheService,
    @InjectQueue(EVALUATION_QUEUE_NAME)
    private readonly evaluationQueue: Queue,
  ) {}

  /**
   * Start a new exam attempt for a student.
   *
   * Gate checks (in order):
   *   1. Exam existence & active status
   *   2. Validate student access window & eligibility
   *   3. Validate chosen language is active & allowed for this exam
   *   4. Duplicate-attempt guard (allow recovery for INTERRUPTED / IN_PROGRESS)
   *   5. Server-side random seed generation
   *   6. Deterministic question and option shuffle per student
   *   7. Atomic persistence in PostgreSQL (Attempt, AttemptQuestion, AttemptQuestionOption)
   *   8. Warm active state in Redis
   */
  async startAttempt(
    dto: StartAttemptDto,
    studentId: string,
    ipAddress?: string,
  ) {
    // ── 1. Validate access (scheduling window + lifecycle + eligibility) ──
    const access = await this.examAccessService.validateStudentAccess(
      dto.examId,
      studentId,
    );

    // ── 2. Fetch exam for duration ──────────────────────────────────────
    const exam = await this.prisma.exam.findUnique({
      where: { id: dto.examId },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    // ── 3. Validate chosen language ─────────────────────────────────────
    let resolvedLanguage = await this.prisma.preferredLanguage.findUnique({
      where: { id: dto.languageId },
    });
    if (!resolvedLanguage) {
      resolvedLanguage = await this.prisma.preferredLanguage.findFirst({
        where: {
          OR: [
            { code: dto.languageId.toLowerCase() },
            { code: dto.languageId.toUpperCase() },
          ],
        },
      });
    }
    if (!resolvedLanguage || !resolvedLanguage.isActive) {
      throw new BadRequestException(
        'Selected examination language is not valid or active.',
      );
    }

    if (typeof this.prisma.examLanguage?.findMany === 'function') {
      const examLanguages = await this.prisma.examLanguage.findMany({
        where: { examId: dto.examId },
      });
      if (examLanguages.length > 0) {
        const isAllowed = examLanguages.some((l) => l.languageId === resolvedLanguage.id);
        if (!isAllowed) {
          throw new BadRequestException(
            `Language '${resolvedLanguage.name}' is not configured for this exam.`,
          );
        }
      }
    } else {
      const examLangCount = await this.prisma.examLanguage.count({
        where: { examId: dto.examId },
      });
      if (examLangCount > 0) {
        const isAllowed = await this.prisma.examLanguage.findFirst({
          where: { examId: dto.examId, languageId: resolvedLanguage.id },
        });
        if (!isAllowed) {
          throw new BadRequestException(
            `Language '${resolvedLanguage.name}' is not configured for this exam.`,
          );
        }
      }
    }

    // ── 4a. Check for active attempts on other exams (One Active Attempt Rule) ──
    const now = new Date();
    const otherActiveAttempt = await this.prisma.attempt.findFirst({
      where: {
        studentId,
        examId: { not: dto.examId },
        status: { name: 'IN_PROGRESS' },
        serverEndTime: { gt: now },
      },
      include: { exam: { select: { title: true } } },
    });

    if (otherActiveAttempt) {
      throw new BadRequestException(
        `You already have an active exam in progress: "${otherActiveAttempt.exam.title}". You must finish or submit your active exam before starting another one.`,
      );
    }

    // ── 4b. Check for active (in-progress/interrupted) attempt to resume ───
    const activeAttempt = await this.prisma.attempt.findFirst({
      where: {
        studentId,
        examId: dto.examId,
        status: { name: { in: ['INTERRUPTED', 'IN_PROGRESS'] } },
      },
      include: { status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (activeAttempt) {
      // If serverEndTime has already passed, finalize immediately and do not resume
      if (
        activeAttempt.serverEndTime &&
        now.getTime() >= activeAttempt.serverEndTime.getTime()
      ) {
        await this.submitAttempt(
          activeAttempt.id,
          studentId,
          'AUTO_SUBMIT_EXPIRED',
        );
        throw new ForbiddenException({
          code: 'EXAM_ATTEMPT_EXPIRED',
          message: 'The examination time for this attempt has expired.',
        });
      }

      // Allow seamless recovery for interrupted/in-progress attempts
      const inProgressStatus = await this.getStatus('IN_PROGRESS');
      await this.prisma.attempt.update({
        where: { id: activeAttempt.id },
        data: {
          statusId: inProgressStatus.id,
          languageId: resolvedLanguage.id,
          displayLanguageId: resolvedLanguage.id,
          // Refresh schedule / version binding on recovery if exam was re-scheduled
          scheduleId: access.scheduleId ?? activeAttempt.scheduleId,
          examVersionId: access.examVersionId ?? activeAttempt.examVersionId,
        },
      });

      await this.ensureAttemptQuestionsInitialized(
        activeAttempt.id,
        activeAttempt.examId,
        activeAttempt.randomSeed || 'default_seed',
      );

      return this.loadAttempt(activeAttempt.id);
    }

    // ── 4c. Single Attempt Rule for Live Exams ───
    const isLive = await this.resultReadinessService.isLiveExam(dto.examId);
    if (isLive) {
      const priorAttempt = await this.prisma.attempt.findFirst({
        where: {
          studentId,
          examId: dto.examId,
          status: {
            name: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] },
          },
        },
      });

      if (priorAttempt) {
        throw new ForbiddenException({
          code: 'LIVE_EXAM_ALREADY_SUBMITTED',
          message:
            'You have already submitted this live examination. Multiple attempts are not permitted for live exams.',
        });
      }
    }

    // ── 5. Prepare Exam Questions & Deterministic Randomization ─────────
    const inProgressStatus = await this.getStatus('IN_PROGRESS');

    const durationEnd = new Date(
      now.getTime() + exam.durationMinutes * 60 * 1000,
    );
    const windowEnd = new Date(access.endTime);
    const serverEndTime = durationEnd < windowEnd ? durationEnd : windowEnd;

    // Pre-generate attempt ID and compute deterministic seed based on student, exam/version, and attempt ID
    const attemptId = randomUUID();
    const randomSeed = this.questionShuffleService.generateDeterministicSeed(
      studentId,
      access.examVersionId || dto.examId,
      attemptId,
    );

    const rawExamQuestions = await this.prisma.examQuestion.findMany({
      where: { examId: dto.examId },
      include: {
        section: true,
        question: {
          include: {
            options: { orderBy: { displayOrder: 'asc' } },
          },
        },
      },
      orderBy: { displayOrder: 'asc' },
    });

    if (rawExamQuestions.length === 0) {
      throw new BadRequestException('Exam has no questions configured.');
    }

    // Deterministically shuffle questions while preserving section order
    const shuffledQuestions = this.questionShuffleService.shuffleQuestions(
      rawExamQuestions,
      randomSeed,
      true,
    );

    // ── 6. Atomic Transaction: Persist Attempt & Personalized Order ───────
    let securityProfileId = exam.securityProfileId;
    let securityProfileVersion = 1;
    if (securityProfileId) {
      const sp = await this.prisma.examSecurityProfile.findUnique({
        where: { id: securityProfileId },
      });
      if (sp) securityProfileVersion = sp.version;
    } else {
      const standardProfile = await this.prisma.examSecurityProfile.findUnique({
        where: { code: 'STANDARD' },
      });
      if (standardProfile) {
        securityProfileId = standardProfile.id;
        securityProfileVersion = standardProfile.version;
      }
    }

    // Pre-allocate batch insert arrays for AttemptQuestion and AttemptQuestionOption
    const attemptQuestionsToInsert: {
      id: string;
      attemptId: string;
      examQuestionId: string;
      displayOrder: number;
      sectionId: string | null;
    }[] = [];

    const attemptQuestionOptionsToInsert: {
      id: string;
      attemptQuestionId: string;
      examQuestionOptionId: string;
      displayOrder: number;
    }[] = [];

    for (let qIdx = 0; qIdx < shuffledQuestions.length; qIdx++) {
      const sq = shuffledQuestions[qIdx];
      const aqId = randomUUID();

      attemptQuestionsToInsert.push({
        id: aqId,
        attemptId,
        examQuestionId: sq.id,
        displayOrder: qIdx + 1,
        sectionId: sq.sectionId ?? null,
      });

      const shuffledOpts = this.questionShuffleService.shuffleOptions(
        sq.question?.options || [],
        randomSeed,
        sq.id,
      );

      for (let optIdx = 0; optIdx < shuffledOpts.length; optIdx++) {
        const opt = shuffledOpts[optIdx];
        attemptQuestionOptionsToInsert.push({
          id: randomUUID(),
          attemptQuestionId: aqId,
          examQuestionOptionId: opt.id,
          displayOrder: optIdx + 1,
        });
      }
    }

    let versionToAssign = access.examVersionId ?? null;
    if (!versionToAssign) {
      const latestVersion = await this.prisma.examVersion.findFirst({
        where: { examId: dto.examId },
        orderBy: { versionNumber: 'desc' },
      });
      if (latestVersion) {
        versionToAssign = latestVersion.id;
      }
    }

    const attempt = await this.prisma.$transaction(
      async (tx) => {
        const newAttempt = await tx.attempt.create({
          data: {
            id: attemptId,
            studentId,
            examId: dto.examId,
            statusId: inProgressStatus.id,
            languageId: resolvedLanguage.id,
            displayLanguageId: resolvedLanguage.id,
            randomSeed,
            securityProfileId: securityProfileId || null,
            securityProfileVersion,
            riskScore: 0,
            riskLevel: 'LOW',
            isFlagged: false,
            startedAt: now,
            serverStartTime: now,
            serverEndTime,
            ipAddress,
            scheduleId: access.scheduleId ?? null,
            examVersionId: versionToAssign,
          },
        });

        if (attemptQuestionsToInsert.length > 0) {
          await tx.attemptQuestion.createMany({
            data: attemptQuestionsToInsert,
          });
        }

        if (attemptQuestionOptionsToInsert.length > 0) {
          await tx.attemptQuestionOption.createMany({
            data: attemptQuestionOptionsToInsert,
          });
        }

        return newAttempt;
      },
      {
        maxWait: 15000,
        timeout: 30000,
      },
    );

    // ── 7. Warm Active State Cache in Redis ──────────────────────────────
    try {
      await this.redisService.set(
        `attempt:${attempt.id}:state`,
        JSON.stringify({
          attemptId: attempt.id,
          examId: attempt.examId,
          languageId: resolvedLanguage.id,
          status: 'IN_PROGRESS',
          startedAt: now.toISOString(),
          serverEndTime: serverEndTime.toISOString(),
        }),
        86400,
      );
    } catch {
      // Non-blocking Redis fallback
    }

    return this.loadAttempt(attempt.id);
  }

  /**
   * Save a single answer (idempotent upsert).
   */
  async saveAnswer(attemptId: string, dto: SaveAnswerDto, studentId: string) {
    const attempt = await this.verifyAttemptOwnership(attemptId, studentId);
    this.verifyAttemptInProgress(attempt);
    this.checkTimeExpiry(attempt);

    await this.prisma.answer.upsert({
      where: {
        attemptId_examQuestionId: {
          attemptId,
          examQuestionId: dto.examQuestionId,
        },
      },
      update: {
        selectedOptionId: dto.selectedOptionId ?? null,
        numericalAnswer: dto.numericalAnswer ?? null,
        selectedOptions: dto.selectedOptions ?? Prisma.JsonNull,
        isMarkedForReview: dto.isMarkedForReview ?? false,
        answeredAt: new Date(),
      },
      create: {
        attemptId,
        examQuestionId: dto.examQuestionId,
        selectedOptionId: dto.selectedOptionId ?? null,
        numericalAnswer: dto.numericalAnswer ?? null,
        selectedOptions: dto.selectedOptions ?? Prisma.JsonNull,
        isMarkedForReview: dto.isMarkedForReview ?? false,
        answeredAt: new Date(),
      },
    });

    return { message: 'Answer saved' };
  }

  /**
   * Bulk save multiple answers at once (auto-save scenario).
   * Does NOT check time expiry — client handles timer; partial saves are fine.
   */
  async bulkSaveAnswers(
    attemptId: string,
    dto: BulkSaveAnswersDto,
    studentId: string,
  ) {
    const attempt = await this.verifyAttemptOwnership(attemptId, studentId);
    this.verifyAttemptInProgress(attempt);

    await Promise.all(
      dto.answers.map((answer) =>
        this.prisma.answer.upsert({
          where: {
            attemptId_examQuestionId: {
              attemptId,
              examQuestionId: answer.examQuestionId,
            },
          },
          update: {
            selectedOptionId: answer.selectedOptionId ?? null,
            numericalAnswer: answer.numericalAnswer ?? null,
            selectedOptions: answer.selectedOptions ?? Prisma.JsonNull,
            isMarkedForReview: answer.isMarkedForReview ?? false,
            answeredAt: new Date(),
          },
          create: {
            attemptId,
            examQuestionId: answer.examQuestionId,
            selectedOptionId: answer.selectedOptionId ?? null,
            numericalAnswer: answer.numericalAnswer ?? null,
            selectedOptions: answer.selectedOptions ?? Prisma.JsonNull,
            isMarkedForReview: answer.isMarkedForReview ?? false,
            answeredAt: new Date(),
          },
        }),
      ),
    );

    return { message: `${dto.answers.length} answers saved` };
  }

  /**
   * Save per-question time log (analytics).
   */
  async saveTimeLog(attemptId: string, dto: SaveTimeLogDto, studentId: string) {
    await this.verifyAttemptOwnership(attemptId, studentId);

    await this.prisma.questionTimeLog.create({
      data: {
        attemptId,
        examQuestionId: dto.examQuestionId,
        startTime: new Date(dto.startTime),
        endTime: dto.endTime ? new Date(dto.endTime) : null,
        timeSpentSeconds: dto.timeSpentSeconds ?? 0,
      },
    });

    return { message: 'Time log saved' };
  }

  /**
   * Student-initiated exam submission.
   * Lightweight API: Validates ownership, locks status, saves answers,
   * dispatches BullMQ evaluation job (if Mock) or defers until scheduled window ends (if Live).
   */
  async submitAttempt(attemptId: string, studentId: string, reason: string = 'USER_SUBMIT') {
    const attempt = await this.verifyAttemptOwnership(attemptId, studentId);
    this.verifyAttemptInProgress(attempt);

    const now = new Date();
    const [inProgressStatus, submittedStatus] = await Promise.all([
      this.getStatus('IN_PROGRESS'),
      this.getStatus('SUBMITTED'),
    ]);

    // Atomic compare-and-swap: only transition if status is currently IN_PROGRESS
    const updateResult = await this.prisma.attempt.updateMany({
      where: {
        id: attemptId,
        statusId: inProgressStatus.id,
      },
      data: {
        statusId: submittedStatus.id,
        submittedAt: now,
      },
    });

    if (updateResult.count === 0) {
      // Race condition handled: another request or auto-submit already finalized this attempt
      const existing = await this.prisma.attempt.findUnique({
        where: { id: attemptId },
        include: { status: true, result: true },
      });
      return {
        attemptId,
        status: existing?.status?.name || 'SUBMITTED',
        resultStatus: existing?.result?.resultStatus || 'PROCESSING',
        message: 'Attempt already finalized.',
        submittedAt: existing?.submittedAt?.toISOString() || now.toISOString(),
      };
    }

    // Finalize any open active timing interval
    await this.questionTimingService
      .finalizeActiveTiming(attemptId, 'SUBMIT', now)
      .catch(() => {});

    // Clean up Redis session cache
    try {
      await this.redisService.del(`exam:attempt:${attemptId}:session`);
      await this.redisService.del(`exam:attempt:${attemptId}:heartbeat`);
    } catch {
      // Non-blocking
    }

    const isLive = await this.resultReadinessService.isLiveExam(attempt.examId);

    if (isLive) {
      // For Live/Scheduled exams: DO NOT evaluate immediately.
      // Create/update Result placeholder with PENDING_WINDOW_CLOSE status.
      await this.prisma.result.upsert({
        where: { attemptId },
        update: {
          resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
        },
        create: {
          attemptId,
          resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
          totalQuestions: 0,
          correctAnswers: 0,
          wrongAnswers: 0,
          unattempted: 0,
          totalScore: 0,
          maxScore: 0,
          percentage: 0,
          accuracy: 0,
          metadata: {
            deferred: true,
            reason: 'Awaiting scheduled examination window end',
            submissionReason: reason,
            submittedAt: now.toISOString(),
          },
        },
      });

      return {
        attemptId,
        status: 'SUBMITTED',
        resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
        message:
          'Attempt submitted successfully. Evaluation and ranking will begin after the scheduled examination window ends.',
        submittedAt: now.toISOString(),
      };
    }

    // ─── MOCK TEST: Immediate BullMQ Evaluation ───
    const evalJobId = `eval_${attemptId}`;
    try {
      await this.evaluationQueue.add(
        'EVALUATE_ATTEMPT',
        { attemptId, triggeredAt: now.toISOString(), evaluationMode: 'IMMEDIATE' },
        {
          jobId: evalJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        },
      );
    } catch (queueErr) {
      // Fallback in case queue connection has transient glitch
      this.resultService.calculateResult(attemptId).catch(() => {});
    }

    return {
      attemptId,
      status: 'SUBMITTED',
      resultStatus: 'PROCESSING',
      message: 'Attempt submitted successfully and queued for evaluation.',
      submittedAt: now.toISOString(),
    };
  }

  /**
   * Auto-submit when timer expires (called by server or client).
   * Idempotent — safe to call multiple times.
   */
  async autoSubmitAttempt(attemptId: string) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { status: true },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');

    const now = new Date();
    const effectiveEndTime =
      attempt.serverEndTime && now > attempt.serverEndTime
        ? attempt.serverEndTime
        : now;

    const inProgressStatus = await this.getStatus('IN_PROGRESS');
    const autoSubmittedStatus = await this.getStatus('AUTO_SUBMITTED');

    // Atomic compare-and-swap
    const updateResult = await this.prisma.attempt.updateMany({
      where: {
        id: attemptId,
        statusId: inProgressStatus.id,
      },
      data: {
        statusId: autoSubmittedStatus.id,
        submittedAt: effectiveEndTime,
      },
    });

    if (updateResult.count === 0) {
      // Concurrently finalized by student submit or previous auto-submit
      return {
        attemptId,
        status: attempt.status.name,
        resultStatus: 'PROCESSING',
        message: 'Attempt already finalized.',
      };
    }

    // Finalize active timing interval up to expiration
    await this.questionTimingService
      .finalizeActiveTiming(attemptId, 'AUTO_SUBMIT', effectiveEndTime)
      .catch(() => {});

    // Clean up Redis session cache
    try {
      await this.redisService.del(`exam:attempt:${attemptId}:session`);
      await this.redisService.del(`exam:attempt:${attemptId}:heartbeat`);
    } catch {
      // Non-blocking
    }

    const isLive = await this.resultReadinessService.isLiveExam(attempt.examId);

    if (isLive) {
      // For Live/Scheduled exams: DO NOT evaluate immediately.
      // Create/update Result placeholder with PENDING_WINDOW_CLOSE status.
      await this.prisma.result.upsert({
        where: { attemptId },
        update: {
          resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
        },
        create: {
          attemptId,
          resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
          totalQuestions: 0,
          correctAnswers: 0,
          wrongAnswers: 0,
          unattempted: 0,
          totalScore: 0,
          maxScore: 0,
          percentage: 0,
          accuracy: 0,
          metadata: {
            deferred: true,
            autoSubmitted: true,
            reason: 'Awaiting scheduled examination window end',
            submittedAt: effectiveEndTime.toISOString(),
          },
        },
      });

      return {
        attemptId,
        status: 'AUTO_SUBMITTED',
        resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
        message:
          'Attempt auto-submitted. Evaluation and ranking will begin after the scheduled examination window ends.',
        submittedAt: effectiveEndTime.toISOString(),
      };
    }

    // ─── MOCK TEST: Immediate BullMQ Evaluation ───
    const evalJobId = `eval_${attemptId}`;
    try {
      await this.evaluationQueue.add(
        'EVALUATE_ATTEMPT',
        { attemptId, triggeredAt: effectiveEndTime.toISOString(), evaluationMode: 'IMMEDIATE' },
        {
          jobId: evalJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        },
      );
    } catch (queueErr) {
      this.resultService.calculateResult(attemptId).catch(() => {});
    }

    return {
      attemptId,
      status: 'AUTO_SUBMITTED',
      resultStatus: 'PROCESSING',
      message: 'Attempt auto-submitted and queued for evaluation.',
      submittedAt: effectiveEndTime.toISOString(),
    };
  }

  /**
   * Get attempt status + saved answers for the exam interface.
   */
  async getAttemptStatus(attemptId: string, studentId: string) {
    const attempt = await this.verifyAttemptOwnership(attemptId, studentId);

    const answers = await this.prisma.answer.findMany({
      where: { attemptId },
      select: {
        examQuestionId: true,
        selectedOptionId: true,
        numericalAnswer: true,
        selectedOptions: true,
        isMarkedForReview: true,
        answeredAt: true,
      },
    });

    return {
      attemptId: attempt.id,
      examId: attempt.examId,
      status: attempt.status.name,
      languageId: attempt.languageId,
      displayLanguageId: attempt.displayLanguageId || attempt.languageId,
      language: (attempt as any).language
        ? {
            id: (attempt as any).language.id,
            code: (attempt as any).language.code,
            name: (attempt as any).language.name,
            nativeName: (attempt as any).language.nativeName,
          }
        : null,
      startedAt: attempt.startedAt,
      serverEndTime: attempt.serverEndTime,
      scheduleId: attempt.scheduleId,
      examVersionId: attempt.examVersionId,
      answers,
    };
  }

  /**
   * Seamless in-flight language switch during an active exam attempt
   * (Zero reset of timer, answers, or attempt identity).
   */
  async switchAttemptLanguage(
    attemptId: string,
    languageIdOrCode: string,
    studentId: string,
  ) {
    const attempt = await this.verifyAttemptOwnership(attemptId, studentId);
    this.verifyAttemptInProgress(attempt);
    this.checkTimeExpiry(attempt);

    // 1. Verify language exists & is active (supports ID or code like 'hi', 'en', 'gu')
    let language = await this.prisma.preferredLanguage.findUnique({
      where: { id: languageIdOrCode },
    });
    if (!language) {
      language = await this.prisma.preferredLanguage.findFirst({
        where: {
          OR: [
            { code: languageIdOrCode.toLowerCase() },
            { code: languageIdOrCode.toUpperCase() },
          ],
        },
      });
    }
    if (!language || !language.isActive) {
      throw new BadRequestException(
        'The selected language is not active or available.',
      );
    }

    // 2. Verify language is allowed for this exam (if ExamLanguage configured)
    const examLanguageCount = await this.prisma.examLanguage.count({
      where: { examId: attempt.examId },
    });

    if (examLanguageCount > 0) {
      const isAllowed = await this.prisma.examLanguage.findFirst({
        where: { examId: attempt.examId, languageId: language.id },
      });
      if (!isAllowed) {
        throw new BadRequestException(
          `Language '${language.name}' is not enabled for this exam.`,
        );
      }
    }

    // 3. Atomically update selected language on Attempt record
    await this.prisma.attempt.update({
      where: { id: attemptId },
      data: {
        languageId: language.id,
        displayLanguageId: language.id,
      },
    });

    // 4. Update Redis active state
    try {
      const redisStateKey = `attempt:${attemptId}:state`;
      const cached = await this.redisService.get(redisStateKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.languageId = language.id;
        await this.redisService.set(redisStateKey, JSON.stringify(parsed), 86400);
      }
    } catch {
      // Non-blocking Redis fallback
    }

    return {
      attemptId,
      language: {
        id: language.id,
        code: language.code,
        name: language.name,
        nativeName: language.nativeName,
      },
    };
  }

  /**
   * Idempotently ensures that AttemptQuestion & AttemptQuestionOption records are persisted in DB.
   */
  async ensureAttemptQuestionsInitialized(
    attemptId: string,
    examId: string,
    randomSeed: string,
  ) {
    const existingCount = await this.prisma.attemptQuestion.count({
      where: { attemptId },
    });
    if (existingCount > 0) return;

    const rawExamQuestions = await this.prisma.examQuestion.findMany({
      where: { examId },
      include: {
        section: true,
        question: {
          include: {
            options: { orderBy: { displayOrder: 'asc' } },
          },
        },
      },
      orderBy: { displayOrder: 'asc' },
    });

    if (rawExamQuestions.length === 0) return;

    const shuffled = this.questionShuffleService.shuffleQuestions(
      rawExamQuestions,
      randomSeed,
      true,
    );

    const attemptQuestionsToInsert: any[] = [];
    const attemptQuestionOptionsToInsert: any[] = [];

    for (let qIdx = 0; qIdx < shuffled.length; qIdx++) {
      const sq = shuffled[qIdx];
      const aqId = randomUUID();
      attemptQuestionsToInsert.push({
        id: aqId,
        attemptId,
        examQuestionId: sq.id,
        displayOrder: qIdx + 1,
        sectionId: sq.sectionId ?? null,
      });

      const shuffledOpts = this.questionShuffleService.shuffleOptions(
        sq.question?.options || [],
        randomSeed,
        sq.id,
      );

      if (shuffledOpts.length > 0) {
        for (let optIdx = 0; optIdx < shuffledOpts.length; optIdx++) {
          attemptQuestionOptionsToInsert.push({
            id: randomUUID(),
            attemptQuestionId: aqId,
            examQuestionOptionId: shuffledOpts[optIdx].id,
            displayOrder: optIdx + 1,
          });
        }
      }
    }

    if (attemptQuestionsToInsert.length > 0) {
      await this.prisma.attemptQuestion.createMany({
        data: attemptQuestionsToInsert,
      });
    }

    if (attemptQuestionOptionsToInsert.length > 0) {
      await this.prisma.attemptQuestionOption.createMany({
        data: attemptQuestionOptionsToInsert,
      });
    }
  }

  /**
   * Get the exam questions for a specific attempt
   * (Returns student-specific deterministic question order & option order with localized language fallback & pagination).
   */
  async getAttemptQuestions(
    attemptId: string,
    studentId: string,
    query?: { page?: number; limit?: number; offset?: number },
  ) {
    const attempt = await this.verifyAttemptOwnership(attemptId, studentId);

    // 1. Compute deterministic seed fallback if missing
    const seedToUse =
      attempt.randomSeed && attempt.randomSeed !== 'default_seed'
        ? attempt.randomSeed
        : this.questionShuffleService.generateDeterministicSeed(
            attempt.studentId,
            attempt.examVersionId || attempt.examId,
            attempt.id,
          );

    // 2. Ensure AttemptQuestion & AttemptQuestionOption records exist for this attempt
    await this.ensureAttemptQuestionsInitialized(
      attempt.id,
      attempt.examId,
      seedToUse,
    );

    // 3. Handle pagination parameters if supplied
    const hasPagination =
      query?.page !== undefined ||
      query?.limit !== undefined ||
      query?.offset !== undefined;

    let take: number | undefined = undefined;
    let skip: number | undefined = undefined;

    let totalCount = 0;
    let limitNum = 50;
    let pageNum = 1;
    let offsetNum = 0;

    if (hasPagination) {
      totalCount = await this.prisma.attemptQuestion.count({
        where: { attemptId: attempt.id },
      });

      limitNum = query?.limit
        ? Math.min(Math.max(1, Number(query.limit)), 500)
        : 50;

      if (query?.offset !== undefined) {
        offsetNum = Math.max(0, Number(query.offset));
        pageNum = Math.floor(offsetNum / limitNum) + 1;
      } else if (query?.page !== undefined) {
        pageNum = Math.max(1, Number(query.page));
        offsetNum = (pageNum - 1) * limitNum;
      }

      take = limitNum;
      skip = offsetNum;
    }

    // 4. Check if Redis Exam Question Cache is available for this attempt's version
    let items: any[] = [];
    let usedCache = false;

    let examVersionId = attempt.examVersionId;
    if (!examVersionId) {
      const latestVersion = await this.prisma.examVersion.findFirst({
        where: { examId: attempt.examId },
        orderBy: { versionNumber: 'desc' },
      });
      if (latestVersion) {
        examVersionId = latestVersion.id;
      }
    }

    if (examVersionId) {
      try {
        const snapshot = await this.examCacheService.getExamSnapshot(
          attempt.examId,
          examVersionId,
        );

        if (snapshot && snapshot.questions && snapshot.questions.length > 0) {
          // Read ONLY the personalized student attempt mapping (lightweight indexed query)
          const attemptQuestions = await this.prisma.attemptQuestion.findMany({
            where: { attemptId: attempt.id },
            orderBy: { displayOrder: 'asc' },
            skip,
            take,
            select: {
              id: true,
              examQuestionId: true,
              displayOrder: true,
              sectionId: true,
              options: {
                select: {
                  id: true,
                  examQuestionOptionId: true,
                  displayOrder: true,
                },
                orderBy: { displayOrder: 'asc' },
              },
            },
          });

          const currentLanguageId =
            attempt.displayLanguageId || attempt.languageId;
          const defaultLangId = snapshot.languages?.find((l) => l.isDefault)?.id;

          items = attemptQuestions
            .map((aq) => {
              const qItem =
                snapshot.questionsById[aq.examQuestionId] ||
                snapshot.questions.find(
                  (q) =>
                    q.examQuestionId === aq.examQuestionId ||
                    q.sourceQuestionId === aq.examQuestionId,
                );

              if (!qItem) return null;

              // Translation resolution with fallback
              const matchedTranslation =
                qItem.translations[currentLanguageId] ||
                qItem.translations[currentLanguageId.toLowerCase()] ||
                qItem.translations[currentLanguageId.toUpperCase()] ||
                (defaultLangId ? qItem.translations[defaultLangId] : null) ||
                Object.values(qItem.translations)[0];

              let orderedOptions = aq.options
                .map((aqo) => {
                  const optItem = qItem.optionsById[aqo.examQuestionOptionId];
                  if (!optItem) return null;

                  const optTrans =
                    optItem.translations?.[currentLanguageId] ||
                    optItem.translations?.[currentLanguageId.toLowerCase()] ||
                    optItem.translations?.[currentLanguageId.toUpperCase()] ||
                    (defaultLangId ? optItem.translations?.[defaultLangId] : null);

                  const matchedOptText =
                    optTrans?.optionText ||
                    optItem.optionText ||
                    optItem.optionLabel ||
                    '';

                  const matchedOptContent =
                    optTrans?.optionContent ||
                    optItem.optionContent ||
                    null;

                  return {
                    id: optItem.id,
                    attemptQuestionOptionId: aqo.id,
                    displayOrder: aqo.displayOrder,
                    optionKey: optItem.optionKey,
                    optionLabel: optItem.optionLabel || optItem.optionKey || '',
                    optionText: matchedOptText,
                    optionContent: matchedOptContent,
                    translations: optItem.translations || {},
                  };
                })
                .filter(Boolean);

              // Strict Question-Option linking fallback: if personalized mapping is empty but question has options, map question's own options
              if (orderedOptions.length === 0 && qItem.options && qItem.options.length > 0) {
                orderedOptions = qItem.options.map((optItem: any, optIdx: number) => {
                  const optTrans =
                    optItem.translations?.[currentLanguageId] ||
                    optItem.translations?.[currentLanguageId.toLowerCase()] ||
                    optItem.translations?.[currentLanguageId.toUpperCase()] ||
                    (defaultLangId ? optItem.translations?.[defaultLangId] : null);
                  return {
                    id: optItem.id,
                    attemptQuestionOptionId: optItem.id,
                    displayOrder: optIdx + 1,
                    optionKey: optItem.optionKey,
                    optionLabel: optItem.optionLabel || optItem.optionKey || '',
                    optionText: optTrans?.optionText || optItem.optionText || optItem.optionLabel || '',
                    optionContent: optTrans?.optionContent || optItem.optionContent || null,
                    translations: optItem.translations || {},
                  };
                });
              }

              return {
                attemptQuestionId: aq.id,
                examQuestionId: qItem.examQuestionId,
                questionId: qItem.sourceQuestionId,
                displayOrder: aq.displayOrder,
                marks: qItem.marks,
                negativeMarks: qItem.negativeMarks,
                section: qItem.section,
                type: qItem.questionType,
                questionType: {
                  id: qItem.questionType,
                  name: qItem.questionType,
                  code: qItem.questionType,
                },
                passage: matchedTranslation?.passageText || qItem.passage || null,
                passageContent: matchedTranslation?.passageContent || qItem.passageContent || null,
                assertion: matchedTranslation?.assertionText || qItem.assertion || null,
                assertionContent: matchedTranslation?.assertionContent || qItem.assertionContent || null,
                reason: matchedTranslation?.reasonText || qItem.reason || null,
                reasonContent: matchedTranslation?.reasonContent || qItem.reasonContent || null,
                questionText:
                  matchedTranslation?.questionText || qItem.questionText || '',
                questionContent:
                  matchedTranslation?.questionContent || qItem.questionContent || null,
                translations: qItem.translations,
                options: orderedOptions,
              };
            })
            .filter(Boolean);

          usedCache = true;
        }
      } catch (cacheErr: any) {
        // Safe fallback to PostgreSQL path if cache unavailable
        usedCache = false;
      }
    }

    if (!usedCache) {
      // Fallback: Fetch personalized AttemptQuestion mappings from PostgreSQL
      const attemptQuestions = await this.prisma.attemptQuestion.findMany({
        where: { attemptId: attempt.id },
        orderBy: { displayOrder: 'asc' },
        skip,
        take,
        include: {
          options: {
            orderBy: { displayOrder: 'asc' },
          },
          examQuestion: {
            include: {
              section: { select: { id: true, name: true, subjectId: true } },
              question: {
                include: {
                  questionType: { select: { id: true, name: true, code: true } },
                  translations: {
                    include: {
                      language: { select: { id: true, code: true, name: true } },
                    },
                  },
                  options: {
                    include: {
                      translations: {
                        include: {
                          language: {
                            select: { id: true, code: true, name: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const examLanguages = await this.prisma.examLanguage.findMany({
        where: { examId: attempt.examId },
        orderBy: { isDefault: 'desc' },
      });
      const examDefaultLanguageId = examLanguages.find(
        (el) => el.isDefault,
      )?.languageId;
      const currentLanguageId =
        attempt.displayLanguageId || attempt.languageId;

      items = attemptQuestions.map((aq) => {
        const eq = aq.examQuestion;
        const q = eq.question;

        // 4-Tier Translation Fallback:
        // 1. Attempt Language
        // 2. Exam Default Language
        // 3. Question Default Language
        // 4. First Available Translation
        const matchedTranslation =
          q.translations.find(
            (t) =>
              t.languageId === currentLanguageId ||
              t.language?.code?.toLowerCase() === currentLanguageId.toLowerCase(),
          ) ||
          (examDefaultLanguageId
            ? q.translations.find((t) => t.languageId === examDefaultLanguageId)
            : null) ||
          q.translations.find((t) => t.languageId === q.defaultLanguageId) ||
          q.translations[0];

        // Build question translations map for instant client-side switching (indexed by ID & code)
        const qTranslationsMap: Record<
          string,
          {
            questionText: string;
            questionContent?: any;
            passageText?: string | null;
            passageContent?: any;
            assertionText?: string | null;
            assertionContent?: any;
            reasonText?: string | null;
            reasonContent?: any;
          }
        > = {};
        q.translations.forEach((t) => {
          const transObj = {
            questionText: t.questionText,
            questionContent: (t as any).questionContent || null,
            passageText: t.passageText || null,
            passageContent: (t as any).passageContent || null,
            assertionText: t.assertionText || null,
            assertionContent: (t as any).assertionContent || null,
            reasonText: t.reasonText || null,
            reasonContent: (t as any).reasonContent || null,
          };
          qTranslationsMap[t.languageId] = transObj;
          if (t.language?.code) {
            qTranslationsMap[t.language.code.toLowerCase()] = transObj;
          }
        });

        // Map options strictly according to AttemptQuestionOption.displayOrder
        const rawOptionsMap = new Map<string, any>(
          q.options.map((o) => [o.id, o]),
        );
        let orderedOptions = aq.options
          .map((aqo) => {
            const rawOpt = rawOptionsMap.get(aqo.examQuestionOptionId);
            if (!rawOpt) return null;

            const matchedOptTranslation =
              rawOpt.translations?.find(
                (ot: any) =>
                  ot.languageId === currentLanguageId ||
                  ot.language?.code?.toLowerCase() === currentLanguageId.toLowerCase(),
              ) ||
              (examDefaultLanguageId
                ? rawOpt.translations?.find(
                    (ot: any) => ot.languageId === examDefaultLanguageId,
                  )
                : null) ||
              rawOpt.translations?.find(
                (ot: any) => ot.languageId === q.defaultLanguageId,
              ) ||
              rawOpt.translations?.[0];

            const optTranslationsMap: Record<string, { optionText: string; optionContent?: any }> = {};
            (rawOpt.translations || []).forEach((ot: any) => {
              const optTransObj = {
                optionText:
                  ot.optionText || rawOpt.optionText || rawOpt.optionLabel || '',
                optionContent: ot.optionContent || (rawOpt as any).optionContent || null,
              };
              optTranslationsMap[ot.languageId] = optTransObj;
              if (ot.language?.code) {
                optTranslationsMap[ot.language.code.toLowerCase()] = optTransObj;
              }
            });

            return {
              id: rawOpt.id,
              attemptQuestionOptionId: aqo.id,
              displayOrder: aqo.displayOrder,
              optionKey: rawOpt.optionKey,
              optionLabel: rawOpt.optionLabel || rawOpt.optionKey || '',
              optionText:
                matchedOptTranslation?.optionText ||
                rawOpt.optionText ||
                rawOpt.optionLabel ||
                '',
              optionContent:
                (matchedOptTranslation as any)?.optionContent ||
                (rawOpt as any).optionContent ||
                null,
              translations: optTranslationsMap,
            };
          })
          .filter(Boolean);

        // Strict Question-Option linking fallback: if personalized mapping is empty but question has options, map question's own options
        if (orderedOptions.length === 0 && q.options && q.options.length > 0) {
          orderedOptions = q.options.map((rawOpt: any, optIdx: number) => {
            const matchedOptTranslation =
              rawOpt.translations?.find(
                (ot: any) =>
                  ot.languageId === currentLanguageId ||
                  ot.language?.code?.toLowerCase() === currentLanguageId.toLowerCase(),
              ) ||
              (examDefaultLanguageId
                ? rawOpt.translations?.find(
                    (ot: any) => ot.languageId === examDefaultLanguageId,
                  )
                : null) ||
              rawOpt.translations?.find(
                (ot: any) => ot.languageId === q.defaultLanguageId,
              ) ||
              rawOpt.translations?.[0];

            const optTranslationsMap: Record<string, { optionText: string; optionContent?: any }> = {};
            (rawOpt.translations || []).forEach((ot: any) => {
              const optTransObj = {
                optionText:
                  ot.optionText || rawOpt.optionText || rawOpt.optionLabel || '',
                optionContent: ot.optionContent || (rawOpt as any).optionContent || null,
              };
              optTranslationsMap[ot.languageId] = optTransObj;
              if (ot.language?.code) {
                optTranslationsMap[ot.language.code.toLowerCase()] = optTransObj;
              }
            });

            return {
              id: rawOpt.id,
              attemptQuestionOptionId: rawOpt.id,
              displayOrder: optIdx + 1,
              optionKey: rawOpt.optionKey,
              optionLabel: rawOpt.optionLabel || rawOpt.optionKey || '',
              optionText:
                matchedOptTranslation?.optionText ||
                rawOpt.optionText ||
                rawOpt.optionLabel ||
                '',
              optionContent:
                (matchedOptTranslation as any)?.optionContent ||
                (rawOpt as any).optionContent ||
                null,
              translations: optTranslationsMap,
            };
          });
        }

        return {
          attemptQuestionId: aq.id,
          examQuestionId: eq.id,
          questionId: q.id,
          displayOrder: aq.displayOrder,
          marks: eq.marks,
          negativeMarks: eq.negativeMarks,
          section: eq.section,
          type: q.type,
          questionType: q.questionType,
          passage: matchedTranslation?.passageText || q.passage || null,
          passageContent: (matchedTranslation as any)?.passageContent || (q as any).passageContent || null,
          assertion: matchedTranslation?.assertionText || q.assertion || null,
          assertionContent: (matchedTranslation as any)?.assertionContent || (q as any).assertionContent || null,
          reason: matchedTranslation?.reasonText || q.reason || null,
          reasonContent: (matchedTranslation as any)?.reasonContent || (q as any).reasonContent || null,
          questionText:
            matchedTranslation?.questionText || (q as any).questionText || '',
          questionContent:
            (matchedTranslation as any)?.questionContent || (q as any).questionContent || null,
          translations: qTranslationsMap,
          options: orderedOptions,
        };
      });
    }

    if (hasPagination) {
      return {
        items,
        pagination: {
          total: totalCount,
          page: pageNum,
          limit: limitNum,
          offset: offsetNum,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      };
    }

    return items;
  }

  /**
   * Get student's exam attempt history with server-side database pagination.
   */
  async getStudentAttempts(
    studentId?: string | null,
    userId?: string | null,
    query: any = {},
  ) {
    let resolvedStudentId = studentId;

    if (!resolvedStudentId && userId) {
      const student = await this.prisma.student.findUnique({
        where: { userId },
        select: { id: true },
      });
      resolvedStudentId = student?.id ?? null;
    }

    const page = Math.max(1, Number(query?.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(query?.limit) || 10));
    const skip = (page - 1) * limit;

    // If user has no associated student profile, return empty array cleanly
    if (!resolvedStudentId) {
      return {
        data: [],
        meta: {
          total: 0,
          page,
          limit,
          totalPages: 1,
        },
      };
    }

    const where: any = {
      studentId: resolvedStudentId,
    };

    if (query?.status && query.status !== 'ALL') {
      if (query.status === 'COMPLETED') {
        where.status = {
          name: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED', 'COMPLETED'] },
        };
      } else {
        where.status = { name: query.status };
      }
    }

    if (query?.targetId && query.targetId !== 'ALL') {
      where.exam = {
        ...(where.exam || {}),
        examTargetId: query.targetId,
      };
    }

    if (query?.search && query.search.trim()) {
      where.exam = {
        ...(where.exam || {}),
        title: { contains: query.search.trim(), mode: 'insensitive' },
      };
    }

    let orderBy: any = { createdAt: 'desc' };
    const sortBy = query?.sortBy || 'NEWEST';
    if (sortBy === 'NEWEST') {
      orderBy = { createdAt: 'desc' };
    } else if (sortBy === 'OLDEST') {
      orderBy = { createdAt: 'asc' };
    } else if (sortBy === 'SCORE_HIGH') {
      orderBy = { result: { totalScore: 'desc' } };
    } else if (sortBy === 'ACCURACY_HIGH') {
      orderBy = { result: { accuracy: 'desc' } };
    }

    const [attempts, total] = await Promise.all([
      this.prisma.attempt.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          exam: {
            select: {
              id: true,
              title: true,
              totalQuestions: true,
              totalMarks: true,
              durationMinutes: true,
              examTarget: { select: { id: true, name: true } },
              sections: {
                include: {
                  subject: { select: { id: true, name: true } },
                },
              },
            },
          },
          status: { select: { id: true, name: true } },
          result: {
            select: {
              id: true,
              totalScore: true,
              maxScore: true,
              percentage: true,
              accuracy: true,
              correctAnswers: true,
              wrongAnswers: true,
              unattempted: true,
              timeUsedSeconds: true,
              averageTimePerQuestion: true,
              resultStatus: true,
              subjectResults: {
                select: {
                  id: true,
                  subjectId: true,
                  subject: { select: { id: true, name: true } },
                  score: true,
                  maxScore: true,
                  accuracy: true,
                  correctAnswers: true,
                  wrongAnswers: true,
                  unattempted: true,
                },
              },
            },
          },
          candidateRanks: {
            select: {
              rank: true,
              totalCandidates: true,
              percentile: true,
              rankType: true,
            },
            orderBy: { createdAt: 'desc' },
          },
          timeAnalyses: {
            select: {
              averageTimePerQuestionSeconds: true,
              timeUtilizationPercentage: true,
              totalTimeUsedSeconds: true,
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
          strategyAnalyses: {
            select: {
              primaryClassification: true,
              avoidableNegativeMarks: true,
              projectedScore: true,
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      this.prisma.attempt.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      data: attempts,
      meta: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  private async verifyAttemptOwnership(
    attemptId: string,
    studentIdOrUserId: string,
  ) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        status: true,
        language: true,
        student: { select: { id: true, userId: true } },
      },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (
      attempt.studentId !== studentIdOrUserId &&
      attempt.student?.userId !== studentIdOrUserId
    ) {
      throw new ForbiddenException('You do not own this attempt');
    }
    return attempt;
  }

  private verifyAttemptInProgress(attempt: any) {
    if (attempt.status.name !== 'IN_PROGRESS') {
      throw new BadRequestException('This attempt is not in progress');
    }
  }

  private checkTimeExpiry(attempt: any) {
    if (attempt.serverEndTime && new Date() > attempt.serverEndTime) {
      // Lazy auto-submit on expiry
      this.autoSubmitAttempt(attempt.id).catch(() => {});
      throw new BadRequestException(
        'Exam time has expired. Your answers have been auto-submitted.',
      );
    }
  }

  private async getStatus(name: string) {
    let status = await this.prisma.attemptStatus.findUnique({
      where: { name },
    });
    if (!status) {
      status = await this.prisma.attemptStatus.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }
    return status;
  }

  private async loadAttempt(id: string) {
    return this.prisma.attempt.findUnique({
      where: { id },
      include: {
        exam: {
          select: {
            id: true,
            title: true,
            totalQuestions: true,
            totalMarks: true,
            durationMinutes: true,
          },
        },
        status: { select: { id: true, name: true } },
        language: { select: { id: true, name: true } },
        _count: { select: { answers: true } },
      },
    });
  }
}
