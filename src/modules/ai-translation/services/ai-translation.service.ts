import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { AiTranslationFileParserService } from './ai-translation-file-parser.service';
import { AiTranslationValidatorService } from './ai-translation-validator.service';
import {
  AI_TRANSLATION_DEFAULTS,
  AI_TRANSLATION_LANGUAGE_QUEUE,
  AI_TRANSLATION_QUEUE,
  SAMPLE_CSV_CONTENT,
} from '../constants/ai-translation.constants';
import {
  SubmitAiTranslationDto,
} from '../dto/ai-translation.dto';
import {
  UploadValidationResponse,
  AiTranslationJobDetails,
  LanguageTranslationProgress,
} from '../dto/ai-translation-upload.dto';
import { AiTranslationParentJobData } from '../processors/ai-translation-parent.processor';
import { AiTranslationLanguageJobData } from '../processors/ai-translation-language.processor';

@Injectable()
export class AiTranslationService {
  private readonly logger = new Logger(AiTranslationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parserService: AiTranslationFileParserService,
    private readonly validatorService: AiTranslationValidatorService,
    private readonly jobProgressService: JobProgressService,
    @InjectQueue(AI_TRANSLATION_QUEUE)
    private readonly parentQueue: Queue<AiTranslationParentJobData>,
    @InjectQueue(AI_TRANSLATION_LANGUAGE_QUEUE)
    private readonly languageQueue: Queue<AiTranslationLanguageJobData>,
  ) {}

  /**
   * List scheduled exams eligible for AI question paper translation
   */
  async getScheduledExams() {
    const schedules = await this.prisma.examSchedule.findMany({
      where: {
        status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED'] },
      },
      include: {
        exam: {
          include: {
            languages: {
              include: { language: true },
            },
            versions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
            },
            examQuestions: {
              select: { id: true },
            },
          },
        },
      },
      orderBy: { startTime: 'asc' },
    });

    // Fetch existing translation jobs for these exams
    const examIds = schedules.map((s) => s.examId);
    const jobs = await this.prisma.aiTranslationJob.findMany({
      where: { examId: { in: examIds } },
      orderBy: { createdAt: 'desc' },
    });

    // Fetch all active regional languages from Language Master (excluding English)
    const allMasterRegionalLanguages = await this.prisma.preferredLanguage.findMany({
      where: {
        isActive: true,
        code: { notIn: ['en', 'EN'] },
      },
      orderBy: { displayOrder: 'asc' },
    });

    const jobMap = new Map<string, any>();
    for (const j of jobs) {
      if (!jobMap.has(j.examId)) {
        jobMap.set(j.examId, j);
      }
    }

    return schedules
      .filter((s) => !!s.exam)
      .map((s) => {
        const latestJob = jobMap.get(s.examId);
        let targetLanguages = (s.exam?.languages || [])
          .filter((l) => l.language && (l.language.code || '').toLowerCase() !== 'en' && l.language.isActive)
          .map((l) => ({
            id: l.language!.id,
            name: l.language!.name,
            code: l.language!.code || 'en',
          }));

        // Default to all active regional languages from Language Master
        if (targetLanguages.length === 0) {
          targetLanguages = allMasterRegionalLanguages.map((ml) => ({
            id: ml.id,
            name: ml.name,
            code: ml.code || 'en',
          }));
        }

        return {
          scheduleId: s.id,
          examId: s.exam?.id || s.examId,
          examTitle: s.exam?.title || 'Scheduled Exam',
          examCode: s.exam?.title || 'EXAM',
          startTime: s.startTime,
          endTime: s.endTime,
          durationMinutes: s.exam?.durationMinutes || 0,
          totalQuestionsConfigured: s.exam?.totalQuestions || 0,
          currentQuestionsCount: s.exam?.examQuestions?.length || 0,
          defaultLanguageId: '',
          targetLanguages,
          latestVersionId: s.exam?.versions?.[0]?.id || null,
          translationJob: latestJob
            ? {
                id: latestJob.id,
                status: latestJob.status,
                overallProgress: latestJob.overallProgress,
                createdAt: latestJob.createdAt,
                completedAt: latestJob.completedAt,
                languageStatuses: latestJob.languageStatuses,
              }
            : null,
        };
      });
  }

  /**
   * Upload and validate file (CSV or Excel) for an exam schedule
   */
  async uploadAndValidate(
    file: Express.Multer.File,
    examScheduleId: string,
  ): Promise<UploadValidationResponse> {
    if (!file || !file.buffer) {
      throw new BadRequestException('No file uploaded.');
    }

    if (file.size > AI_TRANSLATION_DEFAULTS.MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `File size exceeds maximum allowed limit of 10MB.`,
      );
    }

    const schedule = await this.prisma.examSchedule.findUnique({
      where: { id: examScheduleId },
      include: {
        exam: {
          include: {
            languages: {
              include: { language: true },
            },
            versions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!schedule || !schedule.exam) {
      throw new NotFoundException(
        `Exam Schedule with ID '${examScheduleId}' not found.`,
      );
    }

    const allMasterRegionalLanguages = await this.prisma.preferredLanguage.findMany({
      where: {
        isActive: true,
        code: { notIn: ['en', 'EN'] },
      },
      orderBy: { displayOrder: 'asc' },
    });

    let targetLanguages = schedule.exam.languages
      .filter((l) => l.language && (l.language.code || '').toLowerCase() !== 'en' && l.language.isActive)
      .map((l) => ({
        id: l.language!.id,
        name: l.language!.name,
        code: l.language!.code || 'en',
      }));

    if (targetLanguages.length === 0) {
      targetLanguages = allMasterRegionalLanguages.map((ml) => ({
        id: ml.id,
        name: ml.name,
        code: ml.code || 'en',
      }));
    }

    // 1. Parse buffer
    const { rows: rawRows, headers } = await this.parserService.parseBuffer(
      file.buffer,
      file.originalname,
    );

    // 2. Validate
    const validationResult = this.validatorService.validate(rawRows, headers, {
      examScheduleId: schedule.id,
      examId: schedule.exam.id,
      examVersionId: schedule.exam.versions[0]?.id || '',
      examTitle: schedule.exam.title,
      examCode: schedule.exam.title,
      totalQuestionsConfigured: schedule.exam.totalQuestions || rawRows.length,
      targetLanguages,
    });

    return validationResult;
  }

  /**
   * Save questions into DB and enqueue AI translation
   */
  async submitAndStartTranslation(
    dto: SubmitAiTranslationDto,
    userId: string,
  ): Promise<{ jobId: string; message: string; totalQuestions: number; totalLanguages: number }> {
    const schedule = await this.prisma.examSchedule.findUnique({
      where: { id: dto.examScheduleId },
      include: {
        exam: {
          include: {
            languages: {
              include: { language: true },
            },
            versions: {
              orderBy: { versionNumber: 'desc' },
              take: 1,
            },
            sections: true,
          },
        },
      },
    });

    if (!schedule || !schedule.exam) {
      throw new NotFoundException(
        `Exam Schedule with ID '${dto.examScheduleId}' not found.`,
      );
    }

    const exam = schedule.exam;

    const allMasterRegionalLanguages = await this.prisma.preferredLanguage.findMany({
      where: {
        isActive: true,
        code: { notIn: ['en', 'EN'] },
      },
      orderBy: { displayOrder: 'asc' },
    });

    let targetLanguages = exam.languages
      .filter((l) => l.language && (l.language.code || '').toLowerCase() !== 'en' && l.language.isActive)
      .map((l) => ({
        id: l.language!.id,
        name: l.language!.name,
        code: l.language!.code || 'en',
      }));

    if (targetLanguages.length === 0) {
      targetLanguages = allMasterRegionalLanguages.map((ml) => ({
        id: ml.id,
        name: ml.name,
        code: ml.code || 'en',
      }));
    }

    // Find default subject & chapter for questions
    let defaultSubject = await this.prisma.subject.findFirst({
      where: { examTargetId: exam.examTargetId },
    });
    if (!defaultSubject) {
      defaultSubject = await this.prisma.subject.findFirst();
    }
    if (!defaultSubject) {
      defaultSubject = await this.prisma.subject.create({
        data: {
          examTargetId: exam.examTargetId,
          name: 'General',
          code: 'GEN',
        },
      });
    }

    let defaultChapter = await this.prisma.chapter.findFirst({
      where: { subjectId: defaultSubject.id },
    });
    if (!defaultChapter) {
      defaultChapter = await this.prisma.chapter.create({
        data: {
          subjectId: defaultSubject.id,
          name: 'General Chapter',
          code: 'GEN-01',
        },
      });
    }

    const defaultLanguage =
      (await this.prisma.preferredLanguage.findFirst({
        where: { code: 'en' },
      })) || (await this.prisma.preferredLanguage.findFirst());

    const defaultLangId = defaultLanguage?.id || '';

    // Execute atomic transaction for questions + exam version + job record
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Check or create ExamSection
      let examSection = exam.sections[0];
      if (!examSection) {
        examSection = await tx.examSection.create({
          data: {
            examId: exam.id,
            subjectId: defaultSubject.id,
            name: 'Section A',
            totalQuestions: dto.questions.length,
            displayOrder: 1,
          },
        });
      }

      // 2. Clean up previous exam version snapshots first (so sourceQuestionId references are removed)
      const existingVersions = await tx.examVersion.findMany({
        where: { examId: exam.id },
        select: { id: true },
      });
      const versionIds = existingVersions.map((v) => v.id);

      if (versionIds.length > 0) {
        const evQuestionsToDelete = await tx.examVersionQuestion.findMany({
          where: { examVersionId: { in: versionIds } },
          select: { id: true },
        });
        const evQIds = evQuestionsToDelete.map((q) => q.id);

        if (evQIds.length > 0) {
          await tx.examVersionOptionTranslation.deleteMany({
            where: {
              option: { examVersionQuestionId: { in: evQIds } },
            },
          });
          await tx.examVersionTranslation.deleteMany({
            where: { examVersionQuestionId: { in: evQIds } },
          });
          await tx.examVersionOption.deleteMany({
            where: { examVersionQuestionId: { in: evQIds } },
          });
          await tx.examVersionQuestion.deleteMany({
            where: { examVersionId: { in: versionIds } },
          });
        }
      }

      // 3. Clean up previous questions for this exam
      const existingExamQuestions = await tx.examQuestion.findMany({
        where: { examId: exam.id },
        select: { questionId: true },
      });
      const qIds = existingExamQuestions.map((eq) => eq.questionId);

      if (qIds.length > 0) {
        // Unlink from this exam
        await tx.examQuestion.deleteMany({ where: { examId: exam.id } });

        // Find which questions are still referenced in other exams or attempts
        const stillUsedInExam = await tx.examQuestion.findMany({
          where: { questionId: { in: qIds } },
          select: { questionId: true },
        });
        const stillUsedInAttempts = await tx.attemptQuestion.findMany({
          where: { examQuestion: { questionId: { in: qIds } } },
          select: { examQuestion: { select: { questionId: true } } },
        });
        const stillUsedSet = new Set([
          ...stillUsedInExam.map((e) => e.questionId),
          ...stillUsedInAttempts.map((a) => a.examQuestion.questionId),
        ]);

        const deletableQIds = qIds.filter((id) => !stillUsedSet.has(id));

        if (deletableQIds.length > 0) {
          await tx.questionOptionTranslation.deleteMany({
            where: { option: { questionId: { in: deletableQIds } } },
          });
          await tx.questionTranslation.deleteMany({
            where: { questionId: { in: deletableQIds } },
          });
          await tx.questionOption.deleteMany({
            where: { questionId: { in: deletableQIds } },
          });
          await tx.question.deleteMany({
            where: { id: { in: deletableQIds } },
          });
        }
      }

      // 4. Create or Update Version
      let examVersion = exam.versions[0];
      if (!examVersion) {
        examVersion = await tx.examVersion.create({
          data: {
            examId: exam.id,
            versionNumber: 1,
            status: 'GENERATED',
            generationSeed: `ai_trans_${Date.now()}`,
            totalQuestions: dto.questions.length,
            durationMinutes: exam.durationMinutes || 60,
            totalMarks: dto.questions.length * (exam.defaultMarksPerQuestion || 1),
            generatedById: userId,
          },
        });
      }

      // 4. Create Questions, Options, ExamQuestions, VersionQuestions
      const marksPerQ = exam.defaultMarksPerQuestion || 1;
      const negMarks = exam.defaultNegativeMarks || 0;

      for (let idx = 0; idx < dto.questions.length; idx++) {
        const qRow = dto.questions[idx];
        const seqNum = qRow.questionNumber || idx + 1;

        // Create Master Question
        const masterQ = await tx.question.create({
          data: {
            subjectId: defaultSubject.id,
            chapterId: defaultChapter.id,
            defaultLanguageId: defaultLangId,
            type: 'SINGLE_CORRECT',
            difficultyLevel: 'MEDIUM',
            marks: marksPerQ,
            negativeMarks: negMarks,
            createdById: userId,
            isActive: true,
          },
        });

        // Create Default English Translation
        if (defaultLangId) {
          await tx.questionTranslation.create({
            data: {
              questionId: masterQ.id,
              languageId: defaultLangId,
              questionText: qRow.question,
            },
          });
        }

        // Create Options A, B, C, D
        const optDefs = [
          { key: 'A', text: qRow.optionA },
          { key: 'B', text: qRow.optionB },
          { key: 'C', text: qRow.optionC },
          { key: 'D', text: qRow.optionD },
        ];

        const createdOpts: any[] = [];
        for (let oIdx = 0; oIdx < optDefs.length; oIdx++) {
          const optDef = optDefs[oIdx];
          const createdOpt = await tx.questionOption.create({
            data: {
              questionId: masterQ.id,
              optionKey: optDef.key,
              optionLabel: optDef.key,
              optionText: optDef.text,
              isCorrect: false, // Answer key uploaded separately
              displayOrder: oIdx + 1,
            },
          });
          createdOpts.push(createdOpt);
        }

        // Link Question to Exam
        await tx.examQuestion.create({
          data: {
            examId: exam.id,
            sectionId: examSection.id,
            questionId: masterQ.id,
            displayOrder: seqNum,
            marks: marksPerQ,
            negativeMarks: negMarks,
          },
        });

        // Create Immutable ExamVersionQuestion snapshot
        const evq = await tx.examVersionQuestion.create({
          data: {
            examVersionId: examVersion.id,
            sourceQuestionId: masterQ.id,
            sequenceNumber: seqNum,
            sectionName: examSection.name,
            subjectName: defaultSubject.name,
            type: 'SINGLE_CORRECT',
            difficultyLevel: 'MEDIUM',
            marks: marksPerQ,
            negativeMarks: negMarks,
            questionText: qRow.question,
          },
        });

        // Create ExamVersionTranslation for default English
        if (defaultLangId) {
          await tx.examVersionTranslation.create({
            data: {
              examVersionQuestionId: evq.id,
              languageId: defaultLangId,
              languageCode: 'en',
              questionText: qRow.question,
            },
          });
        }

        // Create ExamVersionOptions snapshots
        for (let oIdx = 0; oIdx < createdOpts.length; oIdx++) {
          const opt = createdOpts[oIdx];
          await tx.examVersionOption.create({
            data: {
              examVersionQuestionId: evq.id,
              sourceOptionId: opt.id,
              displayOrder: oIdx + 1,
              optionKey: opt.optionKey,
              optionLabel: opt.optionLabel,
              optionText: opt.optionText || '',
              isCorrect: false,
            },
          });
        }
      }

      // 5. Update Exam total questions if needed & ensure ExamLanguage entries
      await tx.exam.update({
        where: { id: exam.id },
        data: {
          totalQuestions: dto.questions.length,
          totalMarks: dto.questions.length * marksPerQ,
        },
      });

      if (defaultLangId) {
        await tx.examLanguage.upsert({
          where: {
            examId_languageId: {
              examId: exam.id,
              languageId: defaultLangId,
            },
          },
          create: {
            examId: exam.id,
            languageId: defaultLangId,
            isDefault: true,
            displayOrder: 1,
          },
          update: { isDefault: true },
        });
      }

      for (let i = 0; i < targetLanguages.length; i++) {
        const tl = targetLanguages[i];
        await tx.examLanguage.upsert({
          where: {
            examId_languageId: {
              examId: exam.id,
              languageId: tl.id,
            },
          },
          create: {
            examId: exam.id,
            languageId: tl.id,
            isDefault: false,
            displayOrder: i + 2,
          },
          update: {},
        });
      }

      // 6. Create / Upsert AiTranslationJob
      const initialLanguages: LanguageTranslationProgress[] = targetLanguages.map(
        (tl) => ({
          languageId: tl.id,
          languageName: tl.name,
          languageCode: tl.code,
          status: 'QUEUED',
          completedQuestions: 0,
          totalQuestions: dto.questions.length,
          failedBatches: 0,
        }),
      );

      const aiJob = await tx.aiTranslationJob.upsert({
        where: {
          examId_examVersionId: {
            examId: exam.id,
            examVersionId: examVersion.id,
          },
        },
        create: {
          examId: exam.id,
          examVersionId: examVersion.id,
          totalQuestions: dto.questions.length,
          totalLanguages: targetLanguages.length,
          batchSize: AI_TRANSLATION_DEFAULTS.BATCH_SIZE,
          status: 'QUEUED',
          overallProgress: 0,
          languageStatuses: initialLanguages as any,
          createdById: userId,
        },
        update: {
          totalQuestions: dto.questions.length,
          totalLanguages: targetLanguages.length,
          status: 'QUEUED',
          overallProgress: 0,
          languageStatuses: initialLanguages as any,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          failedAt: null,
        },
      });

      return {
        aiJob,
        examVersionId: examVersion.id,
      };
    });

    // 7. Enqueue BullMQ parent job
    await this.parentQueue.add(
      `ai-translation-${result.aiJob.id}`,
      {
        jobId: result.aiJob.id,
        examId: exam.id,
        examVersionId: result.examVersionId,
        userId,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );

    // 8. Publish WebSocket Queued Event
    await this.jobProgressService.publishQueued(
      AI_TRANSLATION_QUEUE,
      result.aiJob.id,
      {
        type: 'AI Question Paper Translation',
        userId,
        examId: exam.id,
        message: `Translation job queued for ${dto.questions.length} questions across ${targetLanguages.length} regional languages.`,
      },
    );

    // 9. Audit Log
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'AI_TRANSLATION_STARTED',
        entityType: 'AI_TRANSLATION_JOB',
        entityId: result.aiJob.id,
        metadata: {
          examId: exam.id,
          examTitle: exam.title,
          totalQuestions: dto.questions.length,
          targetLanguages: targetLanguages.map((t) => t.name),
        },
      },
    });

    return {
      jobId: result.aiJob.id,
      message: 'Question paper saved and AI translation initiated successfully.',
      totalQuestions: dto.questions.length,
      totalLanguages: targetLanguages.length,
    };
  }

  /**
   * Central reusable method to automatically start AI Translation for an already-saved ExamVersion.
   * Invoked after DB commit in Manual Question Paper Entry and Direct/CSV Question Paper Uploads.
   */
  async startQuestionPaperTranslation(
    examId: string,
    examVersionId: string,
    userId: string,
  ): Promise<{ jobId: string; totalQuestions: number; totalLanguages: number; targetLanguages: string[] }> {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        languages: {
          include: { language: true },
        },
        versions: {
          where: { id: examVersionId },
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    const examVersion =
      exam.versions[0] ||
      (await this.prisma.examVersion.findUnique({ where: { id: examVersionId } }));
    if (!examVersion) {
      throw new NotFoundException(`ExamVersion with ID '${examVersionId}' not found.`);
    }

    // Count questions in this version
    const totalQuestions = await this.prisma.examVersionQuestion.count({
      where: { examVersionId },
    });

    if (totalQuestions === 0) {
      this.logger.warn(`Cannot start AI Translation for examVersionId ${examVersionId}: 0 questions found.`);
      return { jobId: '', totalQuestions: 0, totalLanguages: 0, targetLanguages: [] };
    }

    // Resolve target regional languages (excluding English)
    const allMasterRegionalLanguages = await this.prisma.preferredLanguage.findMany({
      where: {
        isActive: true,
        code: { notIn: ['en', 'EN'] },
      },
      orderBy: { displayOrder: 'asc' },
    });

    let targetLanguages = (exam.languages || [])
      .filter((l) => l.language && (l.language.code || '').toLowerCase() !== 'en' && l.language.isActive)
      .map((l) => ({
        id: l.language!.id,
        name: l.language!.name,
        code: l.language!.code || 'en',
      }));

    // If no target languages configured on exam, default to all active regional languages in Language Master
    if (targetLanguages.length === 0) {
      targetLanguages = allMasterRegionalLanguages.map((ml) => ({
        id: ml.id,
        name: ml.name,
        code: ml.code || 'en',
      }));

      // Ensure examLanguage entries exist for the exam
      for (let i = 0; i < targetLanguages.length; i++) {
        const tl = targetLanguages[i];
        await this.prisma.examLanguage.upsert({
          where: {
            examId_languageId: {
              examId: exam.id,
              languageId: tl.id,
            },
          },
          create: {
            examId: exam.id,
            languageId: tl.id,
            isDefault: false,
            displayOrder: i + 2,
          },
          update: {},
        });
      }
    }

    // Check if an active translation job already exists for this exact version (Idempotency)
    const existingJob = await this.prisma.aiTranslationJob.findUnique({
      where: {
        examId_examVersionId: {
          examId: exam.id,
          examVersionId: examVersion.id,
        },
      },
    });

    if (existingJob && (existingJob.status === 'QUEUED' || existingJob.status === 'PROCESSING')) {
      this.logger.log(`Active AI Translation job ${existingJob.id} already exists for version ${examVersion.id}. Returning existing job.`);
      return {
        jobId: existingJob.id,
        totalQuestions,
        totalLanguages: targetLanguages.length,
        targetLanguages: targetLanguages.map((t) => t.name),
      };
    }

    // Build initial per-language progress state
    const initialLanguages: LanguageTranslationProgress[] = targetLanguages.map(
      (tl) => ({
        languageId: tl.id,
        languageName: tl.name,
        languageCode: tl.code,
        status: 'QUEUED',
        completedQuestions: 0,
        totalQuestions,
        failedBatches: 0,
      }),
    );

    // Create / Upsert AiTranslationJob for this (examId, examVersionId)
    const aiJob = await this.prisma.aiTranslationJob.upsert({
      where: {
        examId_examVersionId: {
          examId: exam.id,
          examVersionId: examVersion.id,
        },
      },
      create: {
        examId: exam.id,
        examVersionId: examVersion.id,
        totalQuestions,
        totalLanguages: targetLanguages.length,
        batchSize: AI_TRANSLATION_DEFAULTS.BATCH_SIZE,
        status: 'QUEUED',
        overallProgress: 0,
        languageStatuses: initialLanguages as any,
        createdById: userId,
      },
      update: {
        totalQuestions,
        totalLanguages: targetLanguages.length,
        status: 'QUEUED',
        overallProgress: 0,
        languageStatuses: initialLanguages as any,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        failedAt: null,
      },
    });

    // Enqueue BullMQ parent job
    await this.parentQueue.add(
      `ai-translation-${aiJob.id}`,
      {
        jobId: aiJob.id,
        examId: exam.id,
        examVersionId: examVersion.id,
        userId,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );

    // Publish WebSocket Queued Event
    await this.jobProgressService.publishQueued(
      AI_TRANSLATION_QUEUE,
      aiJob.id,
      {
        type: 'AI Question Paper Translation',
        userId,
        examId: exam.id,
        message: `Translation job queued for ${totalQuestions} questions across ${targetLanguages.length} regional languages.`,
      },
    );

    // Record Audit Log
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'AI_TRANSLATION_STARTED',
        entityType: 'AI_TRANSLATION_JOB',
        entityId: aiJob.id,
        metadata: {
          examId: exam.id,
          examTitle: exam.title,
          examVersionId: examVersion.id,
          totalQuestions,
          targetLanguages: targetLanguages.map((t) => t.name),
        },
      },
    });

    return {
      jobId: aiJob.id,
      totalQuestions,
      totalLanguages: targetLanguages.length,
      targetLanguages: targetLanguages.map((t) => t.name),
    };
  }

  /**
   * Immediately queues manual questions for background database save + AI translation.
   * Returns immediately in <80ms with translationJobId so frontend redirects instantly.
   */
  async queueManualQuestionsTranslation(
    examId: string,
    dto: { questions: any[] },
    userId: string,
  ): Promise<{ jobId: string; message: string; totalQuestions: number; totalLanguages: number }> {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        languages: { include: { language: true } },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    const allMasterRegionalLanguages = await this.prisma.preferredLanguage.findMany({
      where: {
        isActive: true,
        code: { notIn: ['en', 'EN'] },
      },
      orderBy: { displayOrder: 'asc' },
    });

    let targetLanguages = (exam.languages || [])
      .filter((l) => l.language && (l.language.code || '').toLowerCase() !== 'en' && l.language.isActive)
      .map((l) => ({
        id: l.language!.id,
        name: l.language!.name,
        code: l.language!.code || 'en',
      }));

    if (targetLanguages.length === 0) {
      targetLanguages = allMasterRegionalLanguages.map((ml) => ({
        id: ml.id,
        name: ml.name,
        code: ml.code || 'en',
      }));

      // Ensure examLanguage entries exist for the exam
      for (let i = 0; i < targetLanguages.length; i++) {
        const tl = targetLanguages[i];
        await this.prisma.examLanguage.upsert({
          where: {
            examId_languageId: {
              examId: exam.id,
              languageId: tl.id,
            },
          },
          create: {
            examId: exam.id,
            languageId: tl.id,
            isDefault: false,
            displayOrder: i + 2,
          },
          update: {},
        });
      }
    }

    const initialLanguages: LanguageTranslationProgress[] = targetLanguages.map(
      (tl) => ({
        languageId: tl.id,
        languageName: tl.name,
        languageCode: tl.code,
        status: 'QUEUED',
        completedQuestions: 0,
        totalQuestions: dto.questions.length,
        failedBatches: 0,
      }),
    );

    // Create or update AiTranslationJob in DB
    const existingJob = await this.prisma.aiTranslationJob.findFirst({
      where: { examId },
      orderBy: { createdAt: 'desc' },
    });

    const latestVersion = await this.prisma.examVersion.findFirst({
      where: { examId: exam.id },
      orderBy: { versionNumber: 'desc' },
    });

    const aiJob = existingJob
      ? await this.prisma.aiTranslationJob.update({
          where: { id: existingJob.id },
          data: {
            totalQuestions: dto.questions.length,
            totalLanguages: targetLanguages.length,
            status: 'QUEUED',
            overallProgress: 0,
            languageStatuses: initialLanguages as any,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
            failedAt: null,
          },
        })
      : await this.prisma.aiTranslationJob.create({
          data: {
            examId: exam.id,
            examVersionId: latestVersion?.id || randomUUID(),
            totalQuestions: dto.questions.length,
            totalLanguages: targetLanguages.length,
            batchSize: AI_TRANSLATION_DEFAULTS.BATCH_SIZE,
            status: 'QUEUED',
            overallProgress: 0,
            languageStatuses: initialLanguages as any,
            createdById: userId,
          },
        });

    // Enqueue BullMQ parent job with the manual questions payload for background saving & translation
    await this.parentQueue.add(
      `ai-translation-${aiJob.id}`,
      {
        jobId: aiJob.id,
        examId: exam.id,
        userId,
        manualQuestionsPayload: dto,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );

    // Publish WebSocket Queued Event
    await this.jobProgressService.publishQueued(
      AI_TRANSLATION_QUEUE,
      aiJob.id,
      {
        type: 'AI Question Paper Translation',
        userId,
        examId: exam.id,
        message: `Queued ${dto.questions.length} questions for database save and AI translation.`,
      },
    );

    return {
      jobId: aiJob.id,
      message: 'Question paper queued! Redirecting to AI Translation...',
      totalQuestions: dto.questions.length,
      totalLanguages: targetLanguages.length,
    };
  }

  /**
   * Get translation job status and per-language progress
   */
  async getJobStatus(jobId: string): Promise<AiTranslationJobDetails> {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`AI Translation Job '${jobId}' not found.`);
    }

    const exam = await this.prisma.exam.findUnique({
      where: { id: job.examId },
      select: { title: true },
    });

    return {
      id: job.id,
      examId: job.examId,
      examVersionId: job.examVersionId,
      examTitle: exam?.title,
      examCode: exam?.title,
      totalQuestions: job.totalQuestions,
      totalLanguages: job.totalLanguages,
      batchSize: job.batchSize,
      status: job.status,
      overallProgress: job.overallProgress,
      languageStatuses: (job.languageStatuses as any as LanguageTranslationProgress[]) || [],
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  /**
   * Get question paper details with translations for viewing
   */
  async getJobQuestions(jobId: string) {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`AI Translation Job '${jobId}' not found.`);
    }

    const evQuestions = await this.prisma.examVersionQuestion.findMany({
      where: { examVersionId: job.examVersionId },
      include: {
        options: {
          orderBy: { displayOrder: 'asc' },
          include: {
            translations: true,
          },
        },
        translations: true,
      },
      orderBy: { sequenceNumber: 'asc' },
    });

    // Also fetch source question translations as reliable fallback
    const sourceQIds = evQuestions.map((q) => q.sourceQuestionId).filter(Boolean);
    const masterQuestions = await this.prisma.question.findMany({
      where: { id: { in: sourceQIds } },
      include: {
        translations: true,
        options: {
          include: {
            translations: true,
          },
        },
      },
    });
    const masterQMap = new Map(masterQuestions.map((mq) => [mq.id, mq]));

    const languages = await this.prisma.preferredLanguage.findMany();
    const langMap = new Map(languages.map((l) => [l.id, l]));
    const langByCodeMap = new Map(languages.map((l) => [(l.code || '').toLowerCase(), l]));

    return {
      jobId: job.id,
      examId: job.examId,
      examVersionId: job.examVersionId,
      totalQuestions: evQuestions.length,
      questions: evQuestions.map((q) => {
        const optionA = q.options.find((o) => o.optionKey === 'A');
        const optionB = q.options.find((o) => o.optionKey === 'B');
        const optionC = q.options.find((o) => o.optionKey === 'C');
        const optionD = q.options.find((o) => o.optionKey === 'D');

        const masterQ = masterQMap.get(q.sourceQuestionId);
        const masterOptA = masterQ?.options.find((o) => o.optionKey === 'A');
        const masterOptB = masterQ?.options.find((o) => o.optionKey === 'B');
        const masterOptC = masterQ?.options.find((o) => o.optionKey === 'C');
        const masterOptD = masterQ?.options.find((o) => o.optionKey === 'D');

        // Build a consolidated map of translations by languageId
        const translationMap = new Map<string, {
          languageId: string;
          languageName: string;
          languageCode: string;
          questionText: string;
          options: { A: string; B: string; C: string; D: string };
        }>();

        // 1. First add from master question translations
        if (masterQ?.translations) {
          for (const mt of masterQ.translations) {
            const lang = langMap.get(mt.languageId) || langByCodeMap.get(mt.languageId.toLowerCase());
            const langId = lang?.id || mt.languageId;
            const langCode = lang?.code || 'en';
            const langName = lang?.name || langCode.toUpperCase();

            const optATrans = masterOptA?.translations.find((ot) => ot.languageId === langId)?.optionText;
            const optBTrans = masterOptB?.translations.find((ot) => ot.languageId === langId)?.optionText;
            const optCTrans = masterOptC?.translations.find((ot) => ot.languageId === langId)?.optionText;
            const optDTrans = masterOptD?.translations.find((ot) => ot.languageId === langId)?.optionText;

            translationMap.set(langId, {
              languageId: langId,
              languageName: langName,
              languageCode: langCode,
              questionText: mt.questionText || q.questionText,
              options: {
                A: optATrans || optionA?.optionText || '',
                B: optBTrans || optionB?.optionText || '',
                C: optCTrans || optionC?.optionText || '',
                D: optDTrans || optionD?.optionText || '',
              },
            });
          }
        }

        // 2. Overlay / add from ExamVersionQuestion translations
        for (const evt of q.translations) {
          const lang = langMap.get(evt.languageId) || langByCodeMap.get((evt.languageCode || '').toLowerCase());
          const langId = lang?.id || evt.languageId;
          const langCode = lang?.code || evt.languageCode || 'en';
          const langName = lang?.name || langCode.toUpperCase();

          const optATrans = optionA?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode)?.optionText;
          const optBTrans = optionB?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode)?.optionText;
          const optCTrans = optionC?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode)?.optionText;
          const optDTrans = optionD?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode)?.optionText;

          const existing = translationMap.get(langId);

          translationMap.set(langId, {
            languageId: langId,
            languageName: langName,
            languageCode: langCode,
            questionText: evt.questionText || existing?.questionText || q.questionText,
            options: {
              A: optATrans || existing?.options.A || optionA?.optionText || '',
              B: optBTrans || existing?.options.B || optionB?.optionText || '',
              C: optCTrans || existing?.options.C || optionC?.optionText || '',
              D: optDTrans || existing?.options.D || optionD?.optionText || '',
            },
          });
        }

        return {
          id: q.id,
          sequenceNumber: q.sequenceNumber,
          questionText: q.questionText,
          options: {
            A: optionA?.optionText || '',
            B: optionB?.optionText || '',
            C: optionC?.optionText || '',
            D: optionD?.optionText || '',
          },
          translations: Array.from(translationMap.values()),
        };
      }),
    };
  }

  /**
   * Retry translation for a specific language
   */
  async retryLanguage(jobId: string, languageId: string, userId: string) {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`AI Translation Job '${jobId}' not found.`);
    }

    const language = await this.prisma.preferredLanguage.findUnique({
      where: { id: languageId },
    });

    if (!language) {
      throw new NotFoundException(`Language '${languageId}' not found.`);
    }

    const list = (job.languageStatuses as any as LanguageTranslationProgress[]) || [];
    const idx = list.findIndex((l) => l.languageId === languageId);
    if (idx >= 0) {
      list[idx].status = 'QUEUED';
      list[idx].failedBatches = 0;
      list[idx].errorMessage = undefined;
    }

    await this.prisma.aiTranslationJob.update({
      where: { id: jobId },
      data: {
        status: 'PROCESSING',
        languageStatuses: list as any,
      },
    });

    await this.languageQueue.add(
      `retry-${language.code || 'lang'}-${jobId}`,
      {
        jobId,
        examId: job.examId,
        examVersionId: job.examVersionId,
        languageId: language.id,
        languageName: language.name,
        languageCode: language.code || 'en',
        userId,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
      },
    );

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'AI_TRANSLATION_LANGUAGE_RETRY',
        entityType: 'AI_TRANSLATION_JOB',
        entityId: jobId,
        metadata: { languageId, languageName: language.name },
      },
    });

    return { message: `Retry initiated for language: ${language.name}` };
  }

  /**
   * Retry entire failed translation job
   */
  async retryJob(jobId: string, userId: string) {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`AI Translation Job '${jobId}' not found.`);
    }

    await this.parentQueue.add(
      `retry-parent-${jobId}`,
      {
        jobId,
        examId: job.examId,
        examVersionId: job.examVersionId,
        userId,
      },
      {
        attempts: 3,
      },
    );

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'AI_TRANSLATION_JOB_RETRY',
        entityType: 'AI_TRANSLATION_JOB',
        entityId: jobId,
      },
    });

    return { message: 'Translation job retry initiated.' };
  }

  /**
   * Generate sample template for download
   */
  async getSampleTemplate(format: 'csv' | 'xlsx'): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    if (format === 'csv') {
      return {
        buffer: Buffer.from(SAMPLE_CSV_CONTENT, 'utf-8'),
        contentType: 'text/csv',
        fileName: 'sample_ai_question_paper_template.csv',
      };
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('QuestionPaper');

    worksheet.columns = [
      { header: 'question_number', key: 'question_number', width: 18 },
      { header: 'question', key: 'question', width: 45 },
      { header: 'option_a', key: 'option_a', width: 25 },
      { header: 'option_b', key: 'option_b', width: 25 },
      { header: 'option_c', key: 'option_c', width: 25 },
      { header: 'option_d', key: 'option_d', width: 25 },
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E40AF' },
    };

    worksheet.addRow({
      question_number: 1,
      question: 'What is 2 + 2?',
      option_a: '2',
      option_b: '3',
      option_c: '4',
      option_d: '5',
    });

    worksheet.addRow({
      question_number: 2,
      question: 'What is the capital of India?',
      option_a: 'Mumbai',
      option_b: 'New Delhi',
      option_c: 'Chennai',
      option_d: 'Kolkata',
    });

    worksheet.addRow({
      question_number: 3,
      question: 'Which planet is known as the Red Planet?',
      option_a: 'Earth',
      option_b: 'Mars',
      option_c: 'Jupiter',
      option_d: 'Saturn',
    });

    const buffer = (await workbook.xlsx.writeBuffer()) as any;

    return {
      buffer: Buffer.from(buffer),
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'sample_ai_question_paper_template.xlsx',
    };
  }
}
