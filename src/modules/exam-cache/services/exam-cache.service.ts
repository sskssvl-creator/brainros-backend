import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ExamRedisKeys } from '../constants/exam-redis-keys';
import {
  ExamQuestionPaperSnapshot,
  ExamQuestionSnapshotItem,
  ExamOptionSnapshotItem,
  ExamCacheMeta,
  ExamCacheVerificationResult,
  PrepareExamCacheParams,
} from '../interfaces/exam-cache.interface';

@Injectable()
export class ExamCacheService {
  private readonly logger = new Logger(ExamCacheService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Configurable cache safety buffer in minutes past official exam end time.
   * Default: 30 minutes. Configurable via EXAM_REDIS_CACHE_BUFFER_MINUTES.
   */
  public getSafetyBufferMinutes(): number {
    const configured =
      this.configService.get<string>('EXAM_REDIS_CACHE_BUFFER_MINUTES') ||
      process.env.EXAM_REDIS_CACHE_BUFFER_MINUTES;
    const parsed = configured ? parseInt(configured, 10) : 30;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
  }

  /**
   * Invalidate student dashboard cached snapshots when exams/schedules change
   */
  public async invalidateStudentDashboards(): Promise<void> {
    try {
      await this.redisService.delByPattern('student:*:dashboard');
    } catch (err: any) {
      this.logger.warn(`Failed to invalidate student dashboards: ${err.message}`);
    }
  }

  /**
   * Calculates Redis TTL in seconds:
   * TTL = (officialExamEndTime - currentTime) + safetyBuffer
   */
  public calculateTTLSeconds(officialEndTime: Date): number {
    const bufferMinutes = this.getSafetyBufferMinutes();
    const bufferMs = bufferMinutes * 60 * 1000;
    const expiryTimestamp = officialEndTime.getTime() + bufferMs;
    const diffMs = expiryTimestamp - Date.now();

    // Minimum TTL: 60 seconds to prevent immediate eviction during processing
    return Math.max(Math.ceil(diffMs / 1000), 60);
  }

  /**
   * Builds the complete immutable question-paper snapshot from PostgreSQL
   */
  async buildQuestionPaperSnapshot(
    examId: string,
    examVersionId: string,
    officialEndTime?: Date,
  ): Promise<ExamQuestionPaperSnapshot> {
    // 1. Fetch ExamVersion header
    const version = await this.prisma.examVersion.findUnique({
      where: { id: examVersionId },
      include: {
        exam: {
          include: {
            sections: { orderBy: { displayOrder: 'asc' } },
            languages: {
              include: { language: true },
              orderBy: { displayOrder: 'asc' },
            },
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException(
        `ExamVersion '${examVersionId}' not found for exam '${examId}'`,
      );
    }

    const exam = version.exam;
    if (!exam) {
      throw new NotFoundException(`Exam '${examId}' not found`);
    }

    // 2. Fetch existing ExamQuestions to map IDs used by AttemptQuestion
    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { examId },
      include: {
        section: true,
        question: {
          include: {
            questionType: true,
            translations: { include: { language: true } },
            options: {
              include: { translations: { include: { language: true } } },
              orderBy: { displayOrder: 'asc' },
            },
          },
        },
      },
      orderBy: { displayOrder: 'asc' },
    });

    const examQuestionBySourceId = new Map<string, any>();
    for (const eq of examQuestions) {
      examQuestionBySourceId.set(eq.questionId, eq);
    }

    // 3. Fetch ExamVersionQuestions (if populated via blueprint generator)
    const versionQuestions = await this.prisma.examVersionQuestion.findMany({
      where: { examVersionId },
      include: {
        options: {
          include: { translations: true },
          orderBy: { displayOrder: 'asc' },
        },
        translations: true,
      },
      orderBy: { sequenceNumber: 'asc' },
    });

    const snapshotQuestions: ExamQuestionSnapshotItem[] = [];
    const snapshotQuestionsById: Record<string, ExamQuestionSnapshotItem> = {};

    if (versionQuestions.length > 0) {
      // 3A. Source from immutable ExamVersionQuestions
      for (const vq of versionQuestions) {
        const matchingEq = examQuestionBySourceId.get(vq.sourceQuestionId);
        const examQuestionId = matchingEq?.id || vq.id;

        // Build translations map (by language ID & language Code)
        const qTranslationsMap: Record<
          string,
          {
            questionText: string;
            passageText?: string | null;
            assertionText?: string | null;
            reasonText?: string | null;
          }
        > = {};

        for (const tr of vq.translations) {
          const transData = {
            questionText: tr.questionText,
            passageText: tr.passageText || null,
            assertionText: tr.assertionText || null,
            reasonText: tr.reasonText || null,
          };
          qTranslationsMap[tr.languageId] = transData;
          if (tr.languageCode) {
            qTranslationsMap[tr.languageCode.toLowerCase()] = transData;
          }
        }

        // Build options array & optionsById
        const optionsList: ExamOptionSnapshotItem[] = [];
        const optionsById: Record<string, ExamOptionSnapshotItem> = {};

        for (const vo of vq.options) {
          const optId = vo.sourceOptionId || vo.id;
          const optTranslationsMap: Record<string, { optionText: string }> = {};

          for (const ot of vo.translations) {
            optTranslationsMap[ot.languageId] = { optionText: ot.optionText };
            if (ot.languageCode) {
              optTranslationsMap[ot.languageCode.toLowerCase()] = {
                optionText: ot.optionText,
              };
            }
          }

          const optItem: ExamOptionSnapshotItem = {
            id: optId,
            sourceOptionId: vo.sourceOptionId,
            optionKey: vo.optionKey,
            optionLabel: vo.optionLabel || vo.optionText,
            optionText: vo.optionText,
            displayOrder: vo.displayOrder,
            isCorrect: vo.isCorrect,
            translations: optTranslationsMap,
          };

          optionsList.push(optItem);
          optionsById[optId] = optItem;
          optionsById[vo.id] = optItem;
        }

        const questionItem: ExamQuestionSnapshotItem = {
          examQuestionId,
          sourceQuestionId: vq.sourceQuestionId,
          sequenceNumber: vq.sequenceNumber,
          displayOrder: matchingEq?.displayOrder || vq.sequenceNumber,
          sectionId: matchingEq?.sectionId || null,
          section: matchingEq?.section
            ? {
                id: matchingEq.section.id,
                name: matchingEq.section.name,
                subjectId: matchingEq.section.subjectId,
              }
            : null,
          marks: vq.marks,
          negativeMarks: vq.negativeMarks,
          questionType: vq.type,
          difficultyLevel: vq.difficultyLevel,
          questionText: vq.questionText,
          passage: vq.passage || null,
          assertion: vq.assertion || null,
          reason: vq.reason || null,
          explanation: vq.explanation || null,
          correctAnswer: vq.correctAnswer,
          options: optionsList,
          optionsById,
          translations: qTranslationsMap,
        };

        snapshotQuestions.push(questionItem);
        snapshotQuestionsById[examQuestionId] = questionItem;
        snapshotQuestionsById[vq.sourceQuestionId] = questionItem;
      }
    } else if (examQuestions.length > 0) {
      // 3B. Source from ExamQuestions (for imported / uploaded question papers)
      for (const eq of examQuestions) {
        const q = eq.question;
        const examQuestionId = eq.id;

        const qTranslationsMap: Record<
          string,
          {
            questionText: string;
            passageText?: string | null;
            assertionText?: string | null;
            reasonText?: string | null;
          }
        > = {};

        if (q.translations && q.translations.length > 0) {
          for (const tr of q.translations) {
            const transData = {
              questionText: tr.questionText,
              passageText: tr.passageText || null,
              assertionText: tr.assertionText || null,
              reasonText: tr.reasonText || null,
            };
            qTranslationsMap[tr.languageId] = transData;
            if (tr.language?.code) {
              qTranslationsMap[tr.language.code.toLowerCase()] = transData;
            }
          }
        }

        const optionsList: ExamOptionSnapshotItem[] = [];
        const optionsById: Record<string, ExamOptionSnapshotItem> = {};

        if (q.options && q.options.length > 0) {
          for (const opt of q.options) {
            const optTranslationsMap: Record<string, { optionText: string }> = {};
            if (opt.translations && opt.translations.length > 0) {
              for (const ot of opt.translations) {
                optTranslationsMap[ot.languageId] = { optionText: ot.optionText };
                if (ot.language?.code) {
                  optTranslationsMap[ot.language.code.toLowerCase()] = {
                    optionText: ot.optionText,
                  };
                }
              }
            }

            const optItem: ExamOptionSnapshotItem = {
              id: opt.id,
              sourceOptionId: opt.id,
              optionKey: opt.optionKey || 'A',
              optionLabel: opt.optionLabel || opt.optionText || '',
              optionText: opt.optionText || opt.optionLabel || '',
              displayOrder: opt.displayOrder,
              isCorrect: opt.isCorrect,
              translations: optTranslationsMap,
            };

            optionsList.push(optItem);
            optionsById[opt.id] = optItem;
          }
        }

        const defaultTrans = q.translations?.[0];
        const defaultQuestionText = defaultTrans?.questionText || '';

        const questionItem: ExamQuestionSnapshotItem = {
          examQuestionId,
          sourceQuestionId: q.id,
          sequenceNumber: eq.displayOrder,
          displayOrder: eq.displayOrder,
          sectionId: eq.sectionId,
          section: eq.section
            ? {
                id: eq.section.id,
                name: eq.section.name,
                subjectId: eq.section.subjectId,
              }
            : null,
          marks: eq.marks ?? 4.0,
          negativeMarks: eq.negativeMarks ?? 1.0,
          questionType: q.questionType?.code || 'SCQ',
          difficultyLevel: q.difficultyLevel,
          questionText: defaultQuestionText,
          passage: q.passage || defaultTrans?.passageText || null,
          assertion: q.assertion || defaultTrans?.assertionText || null,
          reason: q.reason || defaultTrans?.reasonText || null,
          explanation: null,
          correctAnswer: null,
          options: optionsList,
          optionsById,
          translations: qTranslationsMap,
        };

        snapshotQuestions.push(questionItem);
        snapshotQuestionsById[examQuestionId] = questionItem;
        snapshotQuestionsById[q.id] = questionItem;
      }
    }

    // 4. Map Sections & Languages
    const sections = (exam.sections || []).map((s) => ({
      id: s.id,
      name: s.name,
      subjectId: s.subjectId,
      displayOrder: s.displayOrder,
    }));

    const languages = (exam.languages || []).map((l) => ({
      id: l.language?.id || l.languageId,
      code: l.language?.code || 'en',
      name: l.language?.name || 'English',
      nativeName: l.language?.nativeName || null,
      isDefault: l.isDefault,
    }));

    // 5. Calculate official end time & TTL
    const effectiveEndTime =
      officialEndTime ||
      exam.endTime ||
      new Date(Date.now() + (exam.durationMinutes || 180) * 60 * 1000);

    const ttlSeconds = this.calculateTTLSeconds(effectiveEndTime);
    const ttlExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return {
      examId,
      examVersionId,
      versionNumber: version.versionNumber,
      totalQuestions: snapshotQuestions.length,
      durationMinutes: version.durationMinutes || exam.durationMinutes,
      totalMarks: version.totalMarks || exam.totalMarks,
      sections,
      languages,
      questions: snapshotQuestions,
      questionsById: snapshotQuestionsById,
      cachedAt: new Date().toISOString(),
      officialExamEndTime: effectiveEndTime.toISOString(),
      ttlSeconds,
      ttlExpiresAt,
    };
  }

  /**
   * Prepares and loads the complete question snapshot into Redis before exam start.
   * State flow: SCHEDULED -> PREPARING -> CACHE_READY
   */
  async prepareExamCache(
    params: PrepareExamCacheParams,
  ): Promise<{ success: boolean; snapshot: ExamQuestionPaperSnapshot }> {
    const { examId, scheduleId, userId } = params;
    this.logger.log(
      `[ExamCache] Beginning cache preparation for exam '${examId}', schedule '${scheduleId || 'N/A'}'`,
    );

    // 1. Resolve ExamVersionId
    let versionId = params.examVersionId;
    let officialEndTime = params.officialEndTime;

    if (!versionId || !officialEndTime) {
      const schedule = await this.prisma.examSchedule.findFirst({
        where: scheduleId
          ? { id: scheduleId }
          : { examId, status: { in: ['SCHEDULED', 'ACTIVE'] } },
        orderBy: { createdAt: 'desc' },
      });

      if (schedule) {
        versionId = versionId || schedule.examVersionId;
        officialEndTime = officialEndTime || schedule.endTime;
      }
    }

    if (!versionId) {
      const latestVersion = await this.prisma.examVersion.findFirst({
        where: { examId },
        orderBy: { versionNumber: 'desc' },
      });
      if (latestVersion) {
        versionId = latestVersion.id;
      }
    }

    if (!versionId) {
      throw new NotFoundException(
        `Cannot prepare exam cache: No ExamVersion found for exam '${examId}'`,
      );
    }

    // 2. Mark state: PREPARING
    if (this.redisService.isEnabled) {
      await this.redisService.set(
        ExamRedisKeys.status(examId, versionId),
        'PREPARING',
        300, // short lock/prep status TTL
      );
    }

    try {
      // 3. Build complete question-paper snapshot from PostgreSQL
      const snapshot = await this.buildQuestionPaperSnapshot(
        examId,
        versionId,
        officialEndTime,
      );

      if (snapshot.totalQuestions === 0) {
        throw new BadRequestException(
          `Cannot prepare exam cache: Exam '${examId}' has 0 questions configured.`,
        );
      }

      // 4. Store complete snapshot in Redis
      if (this.redisService.isEnabled) {
        const snapshotJson = JSON.stringify(snapshot);
        await this.redisService.set(
          ExamRedisKeys.questions(examId, versionId),
          snapshotJson,
          snapshot.ttlSeconds,
        );

        // 5. Store Cache Metadata
        const meta: ExamCacheMeta = {
          examId,
          examVersionId: versionId,
          questionCount: snapshot.totalQuestions,
          languageCount: snapshot.languages.length,
          preparedAt: snapshot.cachedAt,
          verifiedAt: new Date().toISOString(),
          officialExamEndTime: snapshot.officialExamEndTime,
          ttlSeconds: snapshot.ttlSeconds,
          status: 'CACHE_READY',
        };

        await this.redisService.set(
          ExamRedisKeys.meta(examId, versionId),
          JSON.stringify(meta),
          snapshot.ttlSeconds,
        );

        // 6. Verify written cache exists and is intact
        const verification = await this.verifyExamCache(
          examId,
          versionId,
          snapshot.totalQuestions,
        );

        if (!verification.isValid) {
          await this.redisService.del(ExamRedisKeys.questions(examId, versionId));
          await this.redisService.del(ExamRedisKeys.status(examId, versionId));
          await this.redisService.del(ExamRedisKeys.meta(examId, versionId));

          this.logger.error(
            `[ExamCache] Cache verification failed for exam '${examId}': ${verification.errors.join(
              ', ',
            )}`,
          );
          throw new BadRequestException(
            `Cache verification failed: ${verification.errors.join('; ')}`,
          );
        }

        // 7. Mark status: CACHE_READY
        await this.redisService.set(
          ExamRedisKeys.status(examId, versionId),
          'CACHE_READY',
          snapshot.ttlSeconds,
        );
      }

      this.logger.log(
        `[ExamCache] Cache preparation completed successfully for exam '${examId}' (Version: ${versionId}, Questions: ${snapshot.totalQuestions}, TTL: ${snapshot.ttlSeconds}s)`,
      );

      return { success: true, snapshot };
    } catch (err: any) {
      if (this.redisService.isEnabled && versionId) {
        await this.redisService.del(ExamRedisKeys.status(examId, versionId));
      }
      this.logger.error(
        `[ExamCache] Cache preparation failed for exam '${examId}': ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * Verifies the prepared cache integrity in Redis
   */
  async verifyExamCache(
    examId: string,
    examVersionId: string,
    expectedCount?: number,
  ): Promise<ExamCacheVerificationResult> {
    const errors: string[] = [];
    const questionsKey = ExamRedisKeys.questions(examId, examVersionId);

    const exists = await this.redisService.exists(questionsKey);
    if (!exists) {
      return {
        isValid: false,
        questionCount: 0,
        expectedCount: expectedCount || 0,
        languagesCount: 0,
        optionsCount: 0,
        errors: ['Question snapshot key does not exist in Redis'],
      };
    }

    const cachedRaw = await this.redisService.get(questionsKey);
    if (!cachedRaw) {
      return {
        isValid: false,
        questionCount: 0,
        expectedCount: expectedCount || 0,
        languagesCount: 0,
        optionsCount: 0,
        errors: ['Cached question snapshot value is empty'],
      };
    }

    let parsed: ExamQuestionPaperSnapshot;
    try {
      parsed = JSON.parse(cachedRaw);
    } catch (parseErr: any) {
      return {
        isValid: false,
        questionCount: 0,
        expectedCount: expectedCount || 0,
        languagesCount: 0,
        optionsCount: 0,
        errors: [`Invalid JSON in cached snapshot: ${parseErr.message}`],
      };
    }

    if (parsed.examId !== examId) {
      errors.push(`Snapshot examId '${parsed.examId}' mismatch expected '${examId}'`);
    }

    if (parsed.examVersionId !== examVersionId) {
      errors.push(
        `Snapshot examVersionId '${parsed.examVersionId}' mismatch expected '${examVersionId}'`,
      );
    }

    const qCount = parsed.questions ? parsed.questions.length : 0;
    if (qCount === 0) {
      errors.push('Snapshot contains 0 questions');
    }

    if (expectedCount !== undefined && expectedCount > 0 && qCount !== expectedCount) {
      errors.push(
        `Question count mismatch: cached ${qCount}, expected ${expectedCount}`,
      );
    }

    let totalOptions = 0;
    for (const q of parsed.questions || []) {
      if (!q.questionText || !q.questionText.trim()) {
        errors.push(`Question '${q.examQuestionId}' missing questionText`);
      }
      totalOptions += (q.options || []).length;
    }

    return {
      isValid: errors.length === 0,
      questionCount: qCount,
      expectedCount: expectedCount || qCount,
      languagesCount: parsed.languages ? parsed.languages.length : 0,
      optionsCount: totalOptions,
      errors,
    };
  }

  /**
   * Primary read path for active exam questions.
   * Reads from Redis; triggers safe rebuild if cache unexpectedly disappeared.
   */
  async getExamSnapshot(
    examId: string,
    examVersionId: string,
  ): Promise<ExamQuestionPaperSnapshot> {
    if (!this.redisService.isEnabled) {
      // In resilient offline mode, build directly from PostgreSQL without Redis
      return this.buildQuestionPaperSnapshot(examId, examVersionId);
    }

    const key = ExamRedisKeys.questions(examId, examVersionId);
    const cached = await this.redisService.get(key);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (err: any) {
        this.logger.warn(
          `[ExamCache] Corrupt JSON in Redis for '${key}': ${err.message}. Initiating safe rebuild.`,
        );
      }
    }

    // Cache miss / disappeared unexpectedly: rebuild safely from immutable PostgreSQL ExamVersion
    this.logger.warn(
      `[ExamCache] Missing cache for active exam '${examId}', version '${examVersionId}'. Triggering safe rebuild...`,
    );
    return this.rebuildExamCache(examId, examVersionId);
  }

  /**
   * Safely rebuilds cache from PostgreSQL without mutating the version
   */
  async rebuildExamCache(
    examId: string,
    examVersionId: string,
  ): Promise<ExamQuestionPaperSnapshot> {
    this.logger.log(
      `[ExamCache] Safe rebuild started for exam '${examId}', version '${examVersionId}'`,
    );
    const prepResult = await this.prepareExamCache({
      examId,
      examVersionId,
    });
    return prepResult.snapshot;
  }

  /**
   * Recalculates TTL and updates Redis expiration when Super Admin updates schedule or end time
   */
  async updateExamCacheTTL(
    examId: string,
    examVersionId: string,
    newEndTime: Date,
  ): Promise<void> {
    if (!this.redisService.isEnabled) return;

    const newTtlSeconds = this.calculateTTLSeconds(newEndTime);
    this.logger.log(
      `[ExamCache] Updating TTL for exam '${examId}', version '${examVersionId}' to ${newTtlSeconds}s (Ends: ${newEndTime.toISOString()})`,
    );

    const qKey = ExamRedisKeys.questions(examId, examVersionId);
    const sKey = ExamRedisKeys.status(examId, examVersionId);
    const mKey = ExamRedisKeys.meta(examId, examVersionId);

    await this.redisService.expire(qKey, newTtlSeconds);
    await this.redisService.expire(sKey, newTtlSeconds);
    await this.redisService.expire(mKey, newTtlSeconds);

    // Update meta record if exists
    const metaRaw = await this.redisService.get(mKey);
    if (metaRaw) {
      try {
        const meta: ExamCacheMeta = JSON.parse(metaRaw);
        meta.officialExamEndTime = newEndTime.toISOString();
        meta.ttlSeconds = newTtlSeconds;
        await this.redisService.set(mKey, JSON.stringify(meta), newTtlSeconds);
      } catch {
        // Non-blocking
      }
    }
  }

  /**
   * Invalidates Redis cache when exam is cancelled or version explicitly superseded
   */
  async invalidateExamCache(
    examId: string,
    examVersionId?: string,
  ): Promise<void> {
    if (!this.redisService.isEnabled) return;

    if (examVersionId) {
      this.logger.log(
        `[ExamCache] Invalidating cache for exam '${examId}', version '${examVersionId}'`,
      );
      await this.redisService.del(ExamRedisKeys.questions(examId, examVersionId));
      await this.redisService.del(ExamRedisKeys.status(examId, examVersionId));
      await this.redisService.del(ExamRedisKeys.meta(examId, examVersionId));
    } else {
      // Invalidate all versions for this exam
      const pattern = `exam:${examId}:*`;
      const matched = await this.redisService.keys(pattern);
      if (matched.length > 0) {
        this.logger.log(
          `[ExamCache] Invalidating ${matched.length} keys for exam '${examId}'`,
        );
        for (const k of matched) {
          await this.redisService.del(k);
        }
      }
    }
  }

  /**
   * Checks if cache is marked READY and verified in Redis
   */
  async isExamCacheReady(
    examId: string,
    examVersionId: string,
  ): Promise<boolean> {
    if (!this.redisService.isEnabled) {
      return true; // Resilient offline mode
    }

    const statusKey = ExamRedisKeys.status(examId, examVersionId);
    const status = await this.redisService.get(statusKey);
    if (status === 'CACHE_READY') {
      return true;
    }

    // Fallback: check if questions key exists and is valid
    const verification = await this.verifyExamCache(examId, examVersionId);
    return verification.isValid;
  }
}
