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
import { extractPlainText } from '../../../common/utils/rich-content-text-extractor';
import { buildTranslatedRichDoc } from '../../../common/utils/rich-content-validator';

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
        status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED', 'ENDED'] },
        exam: {
          status: {
            name: { notIn: ['CANCELLED'] },
          },
        },
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
      orderBy: { startTime: 'desc' },
    });

    const scheduledExamIds = schedules.map((s) => s.examId).filter(Boolean);

    // Also fetch all existing translation jobs
    const allJobs = await this.prisma.aiTranslationJob.findMany({
      orderBy: { createdAt: 'desc' },
    });
    const jobExamIds = Array.from(new Set(allJobs.map((j) => j.examId)));

    // Fetch standalone exams that have translation jobs or questions but aren't in the schedules list
    const standaloneExams = await this.prisma.exam.findMany({
      where: {
        id: { notIn: scheduledExamIds },
        status: {
          name: { notIn: ['CANCELLED'] },
        },
        OR: [
          { id: { in: jobExamIds } },
          { examQuestions: { some: {} } },
        ],
      },
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
        schedules: {
          orderBy: { startTime: 'desc' },
          take: 1,
        },
      },
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
    for (const j of allJobs) {
      if (!jobMap.has(j.examId)) {
        jobMap.set(j.examId, j);
      }
    }

    const scheduledItems = schedules
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
          examCode: (s.exam as any)?.code || s.exam?.title || 'EXAM',
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

    const standaloneItems = standaloneExams.map((e) => {
      const latestJob = jobMap.get(e.id);
      let targetLanguages = (e.languages || [])
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

      const sched = e.schedules?.[0];

      return {
        scheduleId: sched?.id || e.id,
        examId: e.id,
        examTitle: e.title || 'Scheduled Exam',
        examCode: (e as any)?.code || e.title || 'EXAM',
        startTime: sched?.startTime || e.createdAt,
        endTime: sched?.endTime || e.createdAt,
        durationMinutes: e.durationMinutes || 0,
        totalQuestionsConfigured: e.totalQuestions || 0,
        currentQuestionsCount: e.examQuestions?.length || 0,
        defaultLanguageId: '',
        targetLanguages,
        latestVersionId: e.versions?.[0]?.id || null,
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

    const combined = [...scheduledItems, ...standaloneItems];
    combined.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    return combined;
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

    let schedule = await this.prisma.examSchedule.findUnique({
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

    let exam = schedule?.exam;
    if (!exam) {
      exam = (await this.prisma.exam.findUnique({
        where: { id: examScheduleId },
        include: {
          languages: {
            include: { language: true },
          },
          versions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
          },
        },
      })) as any;
    }

    if (!exam) {
      throw new NotFoundException(
        `Exam or Exam Schedule with ID '${examScheduleId}' not found.`,
      );
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
    }

    // 1. Parse buffer
    const { rows: rawRows, headers } = await this.parserService.parseBuffer(
      file.buffer,
      file.originalname,
    );

    // 2. Validate
    const validationResult = this.validatorService.validate(rawRows, headers, {
      examScheduleId: schedule?.id || exam.id,
      examId: exam.id,
      examVersionId: exam.versions[0]?.id || '',
      examTitle: exam.title,
      examCode: (exam as any).code || exam.title,
      totalQuestionsConfigured: exam.totalQuestions || rawRows.length,
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
    let schedule = await this.prisma.examSchedule.findUnique({
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

    let exam = schedule?.exam;
    if (!exam) {
      exam = (await this.prisma.exam.findUnique({
        where: { id: dto.examScheduleId },
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
      })) as any;
    }

    if (!exam) {
      throw new NotFoundException(
        `Exam or Exam Schedule with ID '${dto.examScheduleId}' not found.`,
      );
    }

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
      where: exam.examTargetId
        ? { examTargetSubjects: { some: { examTargetId: exam.examTargetId } } }
        : undefined,
    });
    if (!defaultSubject) {
      defaultSubject = await this.prisma.subject.findFirst();
    }
    if (!defaultSubject) {
      defaultSubject = await this.prisma.subject.create({
        data: {
          name: 'Physics',
          code: 'PHY',
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
    const result = await this.prisma.$transaction(
      async (tx) => {
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
              isCorrect: optDef.key === qRow.correctAnswer, // Fixed: was hardcoded false
              displayOrder: oIdx + 1,
            },
          });
          if (defaultLangId) {
            await tx.questionOptionTranslation.create({
              data: {
                optionId: createdOpt.id,
                languageId: defaultLangId,
                optionText: optDef.text || '',
              },
            });
          }
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
          const evOpt = await tx.examVersionOption.create({
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
          if (defaultLangId) {
            await tx.examVersionOptionTranslation.create({
              data: {
                examVersionOptionId: evOpt.id,
                languageId: defaultLangId,
                languageCode: 'en',
                optionText: opt.optionText || '',
              },
            });
          }
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
          status: 'WAITING',
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
    }, { maxWait: 15000, timeout: 60000 });

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
        status: 'WAITING',
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
        status: 'WAITING',
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

    // CRITICAL: Persist manual questions to database immediately so they are safely stored in PostgreSQL
    let resolvedVersionId = '';
    try {
      resolvedVersionId = await this.saveManualQuestionsToDB(
        aiJob.id,
        exam.id,
        userId,
        dto.questions,
      );
      await this.prisma.aiTranslationJob.update({
        where: { id: aiJob.id },
        data: {
          examVersionId: resolvedVersionId,
          dbSaveProgress: 100,
        } as any,
      });
    } catch (saveErr: any) {
      this.logger.error(`Failed to save manual questions to database: ${saveErr.message}`, saveErr.stack);
      throw saveErr;
    }

    // Enqueue BullMQ parent job with the manual questions payload for background AI translation
    try {
      await this.parentQueue.add(
        `ai-translation-${aiJob.id}`,
        {
          jobId: aiJob.id,
          examId: exam.id,
          examVersionId: resolvedVersionId,
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
    } catch (err: any) {
      this.logger.warn(
        `[AiTranslationService] Could not enqueue job ${aiJob.id} to parent queue (${err.message}). Queue operating in degraded mode.`,
      );
    }

    // Publish WebSocket Queued Event
    await this.jobProgressService.publishQueued(
      AI_TRANSLATION_QUEUE,
      aiJob.id,
      {
        type: 'AI Question Paper Translation',
        userId,
        examId: exam.id,
        message: `Queued ${dto.questions.length} questions for AI translation.`,
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
      dbSaveProgress: (job as any).dbSaveProgress ?? 100,
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
          questionContent?: any;
          assertionText?: string | null;
          assertionContent?: any;
          reasonText?: string | null;
          reasonContent?: any;
          passageText?: string | null;
          passageContent?: any;
          options: {
            A: string;
            AContent?: any;
            B: string;
            BContent?: any;
            C: string;
            CContent?: any;
            D: string;
            DContent?: any;
          };
        }>();


        // 1. First add from master question translations
        if (masterQ?.translations) {
          for (const mt of masterQ.translations) {
            const lang = langMap.get(mt.languageId) || langByCodeMap.get(mt.languageId.toLowerCase());
            const langId = lang?.id || mt.languageId;
            const langCode = lang?.code || 'en';
            const langName = lang?.name || langCode.toUpperCase();

            const optATrans = masterOptA?.translations.find((ot) => ot.languageId === langId);
            const optBTrans = masterOptB?.translations.find((ot) => ot.languageId === langId);
            const optCTrans = masterOptC?.translations.find((ot) => ot.languageId === langId);
            const optDTrans = masterOptD?.translations.find((ot) => ot.languageId === langId);

            translationMap.set(langId, {
              languageId: langId,
              languageName: langName,
              languageCode: langCode,
              questionText: mt.questionText || q.questionText,
              questionContent: (mt as any).questionContent || (q as any).questionContent || null,
              assertionText: (mt as any).assertionText || q.assertion || null,
              assertionContent: (mt as any).assertionContent || (q as any).assertionContent || null,
              reasonText: (mt as any).reasonText || q.reason || null,
              reasonContent: (mt as any).reasonContent || (q as any).reasonContent || null,
              passageText: (mt as any).passageText || q.passage || null,
              passageContent: (mt as any).passageContent || (q as any).passageContent || null,
              options: {
                A: optATrans?.optionText || optionA?.optionText || '',
                AContent: (optATrans as any)?.optionContent || (optionA as any)?.optionContent || null,
                B: optBTrans?.optionText || optionB?.optionText || '',
                BContent: (optBTrans as any)?.optionContent || (optionB as any)?.optionContent || null,
                C: optCTrans?.optionText || optionC?.optionText || '',
                CContent: (optCTrans as any)?.optionContent || (optionC as any)?.optionContent || null,
                D: optDTrans?.optionText || optionD?.optionText || '',
                DContent: (optDTrans as any)?.optionContent || (optionD as any)?.optionContent || null,
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

          const optATrans = optionA?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode);
          const optBTrans = optionB?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode);
          const optCTrans = optionC?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode);
          const optDTrans = optionD?.translations.find((ot) => ot.languageId === langId || ot.languageCode === langCode);

          const existing = translationMap.get(langId);

          const rawQContent = (evt as any).questionContent || existing?.questionContent;
          const effectiveQContent = rawQContent || ((q as any).questionContent ? buildTranslatedRichDoc((q as any).questionContent, evt.questionText || q.questionText) : null);

          const rawAContent = (optATrans as any)?.optionContent || existing?.options?.AContent;
          const effectiveAContent = rawAContent || ((optionA as any)?.optionContent ? buildTranslatedRichDoc((optionA as any).optionContent, optATrans?.optionText || optionA?.optionText) : null);

          const rawBContent = (optBTrans as any)?.optionContent || existing?.options?.BContent;
          const effectiveBContent = rawBContent || ((optionB as any)?.optionContent ? buildTranslatedRichDoc((optionB as any).optionContent, optBTrans?.optionText || optionB?.optionText) : null);

          const rawCContent = (optCTrans as any)?.optionContent || existing?.options?.CContent;
          const effectiveCContent = rawCContent || ((optionC as any)?.optionContent ? buildTranslatedRichDoc((optionC as any).optionContent, optCTrans?.optionText || optionC?.optionText) : null);

          const rawDContent = (optDTrans as any)?.optionContent || existing?.options?.DContent;
          const effectiveDContent = rawDContent || ((optionD as any)?.optionContent ? buildTranslatedRichDoc((optionD as any).optionContent, optDTrans?.optionText || optionD?.optionText) : null);

          translationMap.set(langId, {
            languageId: langId,
            languageName: langName,
            languageCode: langCode,
            questionText: evt.questionText || existing?.questionText || q.questionText,
            questionContent: effectiveQContent,
            assertionText: (evt as any).assertionText || existing?.assertionText || q.assertion || null,
            assertionContent: (evt as any).assertionContent || existing?.assertionContent || (q as any).assertionContent || null,
            reasonText: (evt as any).reasonText || existing?.reasonText || q.reason || null,
            reasonContent: (evt as any).reasonContent || existing?.reasonContent || (q as any).reasonContent || null,
            passageText: (evt as any).passageText || existing?.passageText || q.passage || null,
            passageContent: (evt as any).passageContent || existing?.passageContent || (q as any).passageContent || null,
            options: {
              A: optATrans?.optionText || existing?.options.A || optionA?.optionText || '',
              AContent: effectiveAContent,
              B: optBTrans?.optionText || existing?.options.B || optionB?.optionText || '',
              BContent: effectiveBContent,
              C: optCTrans?.optionText || existing?.options.C || optionC?.optionText || '',
              CContent: effectiveCContent,
              D: optDTrans?.optionText || existing?.options.D || optionD?.optionText || '',
              DContent: effectiveDContent,
            },
          });
        }

        return {
          id: q.id,
          sequenceNumber: q.sequenceNumber,
          questionText: q.questionText,
          questionContent: (q as any).questionContent || null,
          assertionText: q.assertion || null,
          assertionContent: (q as any).assertionContent || null,
          reasonText: q.reason || null,
          reasonContent: (q as any).reasonContent || null,
          passageText: q.passage || null,
          passageContent: (q as any).passageContent || null,
          options: {
            A: optionA?.optionText || '',
            AContent: (optionA as any)?.optionContent || null,
            B: optionB?.optionText || '',
            BContent: (optionB as any)?.optionContent || null,
            C: optionC?.optionText || '',
            CContent: (optionC as any)?.optionContent || null,
            D: optionD?.optionText || '',
            DContent: (optionD as any)?.optionContent || null,
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

    await this.parentQueue.add(
      `retry-lang-${language.code || 'lang'}-${jobId}`,
      {
        jobId,
        examId: job.examId,
        examVersionId: job.examVersionId,
        userId,
        retryLanguageId: languageId,
      } as any,
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

  /**
   * Saves manually entered questions to the PostgreSQL database.
   * Creates: ExamVersion, Question, QuestionOption (with correct isCorrect=true),
   * ExamQuestion, ExamVersionQuestion, ExamVersionOption, ExamVersionTranslation.
   * Returns the created ExamVersion ID.
   */
  async saveManualQuestionsToDB(
    jobId: string,
    examId: string,
    userId: string,
    questions: any[],
  ): Promise<string> {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        sections: { include: { subject: true }, orderBy: { displayOrder: 'asc' } },
      },
    });
    if (!exam) throw new Error(`Exam ${examId} not found during manual question DB save.`);

    // Resolve default subject for the exam's target
    let defaultSubject = await this.prisma.subject.findFirst({
      where: exam.examTargetId
        ? { examTargetSubjects: { some: { examTargetId: exam.examTargetId } } }
        : undefined,
    });
    if (!defaultSubject) defaultSubject = await this.prisma.subject.findFirst();
    if (!defaultSubject) {
      defaultSubject = await this.prisma.subject.create({
        data: { name: 'Physics', code: 'PHY' },
      });
    }

    let defaultChapter = await this.prisma.chapter.findFirst({
      where: { subjectId: defaultSubject.id },
    });
    if (!defaultChapter) {
      defaultChapter = await this.prisma.chapter.create({
        data: { subjectId: defaultSubject.id, name: 'General Chapter', code: 'GEN-01' },
      });
    }

    const defaultLanguage =
      (await this.prisma.preferredLanguage.findFirst({ where: { code: 'en' } })) ||
      (await this.prisma.preferredLanguage.findFirst());
    const defaultLangId = defaultLanguage?.id || null;

    const marksPerQ = (exam as any).defaultMarksPerQuestion || 4;
    const negMarks = (exam as any).defaultNegativeMarks || 1;

    // ── Clean up existing version questions & reuse ExamVersion safely ──
    const existingVersions = await this.prisma.examVersion.findMany({
      where: { examId: exam.id },
      orderBy: { versionNumber: 'asc' },
    });
    const versionIds = existingVersions.map((v) => v.id);

    if (versionIds.length > 0) {
      const evQIds = (
        await this.prisma.examVersionQuestion.findMany({
          where: { examVersionId: { in: versionIds } },
          select: { id: true },
        })
      ).map((q) => q.id);

      if (evQIds.length > 0) {
        await this.prisma.examVersionOptionTranslation.deleteMany({
          where: { option: { examVersionQuestionId: { in: evQIds } } },
        });
        await this.prisma.examVersionTranslation.deleteMany({
          where: { examVersionQuestionId: { in: evQIds } },
        });
        await this.prisma.examVersionOption.deleteMany({
          where: { examVersionQuestionId: { in: evQIds } },
        });
        await this.prisma.examVersionQuestion.deleteMany({
          where: { examVersionId: { in: versionIds } },
        });
      }
    }

    let examVersion: any;
    if (existingVersions.length > 0) {
      examVersion = await this.prisma.examVersion.update({
        where: { id: existingVersions[0].id },
        data: {
          status: 'GENERATED',
          totalQuestions: questions.length,
          durationMinutes: exam.durationMinutes || 60,
          totalMarks: questions.length * marksPerQ,
        },
      });

      if (existingVersions.length > 1) {
        const extraVersionIds = existingVersions.slice(1).map((v) => v.id);
        await this.prisma.examSchedule.updateMany({
          where: { examVersionId: { in: extraVersionIds } },
          data: { examVersionId: examVersion.id },
        });
        await this.prisma.examVersion.deleteMany({
          where: { id: { in: extraVersionIds } },
        });
      }
    } else {
      examVersion = await this.prisma.examVersion.create({
        data: {
          examId: exam.id,
          versionNumber: 1,
          status: 'GENERATED',
          totalQuestions: questions.length,
          durationMinutes: exam.durationMinutes || 60,
          totalMarks: questions.length * marksPerQ,
          generatedById: userId,
        },
      });
    }

    // Clean up previous master question links
    const prevExamQs = await this.prisma.examQuestion.findMany({
      where: { examId: exam.id },
      select: { questionId: true },
    });
    const prevQIds = prevExamQs.map((eq) => eq.questionId);
    if (prevQIds.length > 0) {
      await this.prisma.examQuestion.deleteMany({ where: { examId: exam.id } });
      const stillLinked = await this.prisma.examQuestion.findMany({
        where: { questionId: { in: prevQIds } },
        select: { questionId: true },
      });
      const stillLinkedSet = new Set(stillLinked.map((e) => e.questionId));
      const deletable = prevQIds.filter((id) => !stillLinkedSet.has(id));
      if (deletable.length > 0) {
        await this.prisma.questionOptionTranslation.deleteMany({
          where: { option: { questionId: { in: deletable } } },
        });
        await this.prisma.questionTranslation.deleteMany({ where: { questionId: { in: deletable } } });
        await this.prisma.questionOption.deleteMany({ where: { questionId: { in: deletable } } });
        await this.prisma.question.deleteMany({ where: { id: { in: deletable } } });
      }
    }

    // Map existing sections by subjectId for fast lookup
    const sectionBySubject = new Map<string, any>();
    for (const sec of exam.sections || []) {
      if (sec.subjectId && !sectionBySubject.has(sec.subjectId)) {
        sectionBySubject.set(sec.subjectId, sec);
      }
    }

    // Cache subjects and default chapters by subjectId
    const subjectCache = new Map<string, any>();
    const chapterCache = new Map<string, any>();

    // Seed default subject & chapter in caches
    subjectCache.set(defaultSubject.id, defaultSubject);
    chapterCache.set(defaultSubject.id, defaultChapter);

    const getSubjectAndChapter = async (subjectId?: string) => {
      const targetSubId = subjectId || defaultSubject.id;
      let sub = subjectCache.get(targetSubId);
      if (!sub) {
        sub = await this.prisma.subject.findUnique({ where: { id: targetSubId } });
        if (!sub) sub = defaultSubject;
        subjectCache.set(sub.id, sub);
      }

      let ch = chapterCache.get(sub.id);
      if (!ch) {
        ch = await this.prisma.chapter.findFirst({ where: { subjectId: sub.id } });
        if (!ch) {
          ch = await this.prisma.chapter.create({
            data: { subjectId: sub.id, name: 'General Chapter', code: `${sub.name.slice(0, 3).toUpperCase()}-01` },
          });
        }
        chapterCache.set(sub.id, ch);
      }

      return { subject: sub, chapter: ch };
    };

    const getExamSection = async (sub: any) => {
      let sec = sectionBySubject.get(sub.id);
      if (!sec) {
        sec = await this.prisma.examSection.create({
          data: {
            examId: exam.id,
            subjectId: sub.id,
            name: `${sub.name} Section`,
            totalQuestions: 0,
            displayOrder: sectionBySubject.size + 1,
          } as any,
        });
        sectionBySubject.set(sub.id, sec);
      }
      return sec;
    };

    const totalQ = questions.length;
    const REPORT_INTERVAL = Math.max(1, Math.ceil(totalQ / 10));

    for (let idx = 0; idx < questions.length; idx++) {
      const qData = questions[idx];
      const seqNum = idx + 1;

      const qType = qData.type || 'SINGLE_CORRECT';
      const qDifficulty = qData.difficulty || 'MEDIUM';

      const { subject: qSubject, chapter: qChapter } = await getSubjectAndChapter(qData.subjectId);
      const qSection = await getExamSection(qSubject);

      const rawQuestionText = extractPlainText(qData.questionContent || qData.questionText || '');
      const rawAssertion = qType === 'ASSERTION_REASON' ? extractPlainText(qData.assertionContent || qData.assertion || '') : null;
      const rawReason = qType === 'ASSERTION_REASON' ? extractPlainText(qData.reasonContent || qData.reason || '') : null;
      const rawPassage = extractPlainText(qData.passageContent || qData.passage || '') || null;

      // Create master Question
      const masterQ = await this.prisma.question.create({
        data: {
          subjectId: qSubject.id,
          chapterId: qChapter.id,
          ...(defaultLangId ? { defaultLanguageId: defaultLangId } : {}),
          type: qType as any,
          difficultyLevel: qDifficulty as any,
          marks: marksPerQ,
          negativeMarks: negMarks,
          assertion: rawAssertion,
          assertionContent: qData.assertionContent || null,
          reason: rawReason,
          reasonContent: qData.reasonContent || null,
          passage: rawPassage,
          passageContent: qData.passageContent || null,
          questionContent: qData.questionContent || null,
          createdById: userId,
          isActive: true,
        } as any,
      });

      // English translation for the question text
      if (defaultLangId) {
        await this.prisma.questionTranslation.create({
          data: {
            questionId: masterQ.id,
            languageId: defaultLangId,
            questionText: rawQuestionText,
            questionContent: qData.questionContent || null,
            assertionText: rawAssertion,
            assertionContent: qData.assertionContent || null,
            reasonText: rawReason,
            reasonContent: qData.reasonContent || null,
            passageText: rawPassage,
            passageContent: qData.passageContent || null,
            explanation: qData.explanation || null,
          } as any,
        });
      }

      // Create options if applicable (non-numerical)
      const createdOpts: any[] = [];
      if (qType !== 'NUMERICAL') {
        const optDefs = [
          { key: 'A', text: qData.optionA || '', content: qData.optionAContent },
          { key: 'B', text: qData.optionB || '', content: qData.optionBContent },
          { key: 'C', text: qData.optionC || '', content: qData.optionCContent },
          { key: 'D', text: qData.optionD || '', content: qData.optionDContent },
        ];

        const multiCorrect = Array.isArray(qData.correctAnswers)
          ? qData.correctAnswers
          : typeof qData.correctAnswer === 'string'
          ? qData.correctAnswer.split(/[\s,]+/).filter(Boolean)
          : [];

        for (let oIdx = 0; oIdx < optDefs.length; oIdx++) {
          const optDef = optDefs[oIdx];
          const isCorrect =
            qType === 'MULTIPLE_CORRECT'
              ? multiCorrect.includes(optDef.key)
              : optDef.key === qData.correctAnswer;

          const rawOptText = extractPlainText(optDef.content || optDef.text || '');

          const opt = await this.prisma.questionOption.create({
            data: {
              questionId: masterQ.id,
              optionKey: optDef.key,
              optionLabel: optDef.key,
              optionText: rawOptText,
              optionContent: optDef.content || null,
              isCorrect,
              displayOrder: oIdx + 1,
            } as any,
          });
          createdOpts.push({ ...opt, optionContent: optDef.content || null });

          if (defaultLangId) {
            await this.prisma.questionOptionTranslation.create({
              data: {
                optionId: opt.id,
                languageId: defaultLangId,
                optionText: rawOptText,
                optionContent: optDef.content || null,
              } as any,
            });
          }
        }
      }

      // Create QuestionAnswer record
      const correctOptionIds = createdOpts.filter((o) => o.isCorrect).map((o) => o.id);
      await this.prisma.questionAnswer.create({
        data: {
          questionId: masterQ.id,
          answerType: qType as any,
          correctOptionIds: correctOptionIds.length > 0 ? correctOptionIds : undefined,
          numericalAnswer:
            qType === 'NUMERICAL' && qData.numericalAnswer !== undefined && qData.numericalAnswer !== null
              ? parseFloat(String(qData.numericalAnswer))
              : null,
        } as any,
      });

      // Link to exam
      await this.prisma.examQuestion.create({
        data: {
          examId: exam.id,
          sectionId: qSection.id,
          questionId: masterQ.id,
          displayOrder: seqNum,
          marks: marksPerQ,
          negativeMarks: negMarks,
        } as any,
      });

      // Prepare snapshot correctAnswer object
      let snapshotCorrectAnswer: any = null;
      if (qType === 'NUMERICAL') {
        snapshotCorrectAnswer = {
          numericalAnswer:
            qData.numericalAnswer !== undefined && qData.numericalAnswer !== null
              ? parseFloat(String(qData.numericalAnswer))
              : null,
        };
      } else if (qType === 'MULTIPLE_CORRECT') {
        const multiCorrect = Array.isArray(qData.correctAnswers)
          ? qData.correctAnswers
          : typeof qData.correctAnswer === 'string'
          ? qData.correctAnswer.split(/[\s,]+/).filter(Boolean)
          : [];
        snapshotCorrectAnswer = { keys: multiCorrect };
      } else {
        snapshotCorrectAnswer = { key: qData.correctAnswer };
      }

      // ExamVersionQuestion snapshot
      const evq = await this.prisma.examVersionQuestion.create({
        data: {
          examVersionId: examVersion.id,
          sourceQuestionId: masterQ.id,
          sequenceNumber: seqNum,
          sectionName: (qSection as any).name || `${qSubject.name} Section`,
          subjectName: qSubject.name,
          type: qType as any,
          difficultyLevel: qDifficulty as any,
          marks: marksPerQ,
          negativeMarks: negMarks,
          assertion: rawAssertion,
          assertionContent: qData.assertionContent || null,
          reason: rawReason,
          reasonContent: qData.reasonContent || null,
          passage: rawPassage,
          passageContent: qData.passageContent || null,
          questionText: rawQuestionText,
          questionContent: qData.questionContent || null,
          explanation: qData.explanation || null,
          correctAnswer: snapshotCorrectAnswer,
        } as any,
      });

      // English translation snapshot
      if (defaultLangId) {
        await this.prisma.examVersionTranslation.create({
          data: {
            examVersionQuestionId: evq.id,
            languageId: defaultLangId,
            languageCode: 'en',
            questionText: rawQuestionText,
            questionContent: qData.questionContent || null,
            assertionText: rawAssertion,
            assertionContent: qData.assertionContent || null,
            reasonText: rawReason,
            reasonContent: qData.reasonContent || null,
            passageText: rawPassage,
            passageContent: qData.passageContent || null,
            explanation: qData.explanation || null,
          } as any,
        });
      }

      // ExamVersionOption snapshots (isCorrect propagated)
      for (let oIdx = 0; oIdx < createdOpts.length; oIdx++) {
        const opt = createdOpts[oIdx];
        const evOpt = await this.prisma.examVersionOption.create({
          data: {
            examVersionQuestionId: evq.id,
            sourceOptionId: opt.id,
            displayOrder: oIdx + 1,
            optionKey: opt.optionKey,
            optionLabel: opt.optionLabel,
            optionText: opt.optionText || '',
            optionContent: opt.optionContent || null,
            isCorrect: opt.isCorrect,
          } as any,
        });
        if (defaultLangId) {
          await this.prisma.examVersionOptionTranslation.create({
            data: {
              examVersionOptionId: evOpt.id,
              languageId: defaultLangId,
              languageCode: 'en',
              optionText: opt.optionText || '',
              optionContent: opt.optionContent || null,
            },
          });
        }
      }

      // Report dbSaveProgress every REPORT_INTERVAL or on the last question
      if ((idx + 1) % REPORT_INTERVAL === 0 || idx === totalQ - 1) {
        const dbPct = Math.round(((idx + 1) / totalQ) * 100);
        await this.prisma.aiTranslationJob.update({
          where: { id: jobId },
          data: { dbSaveProgress: dbPct } as any,
        });
        await this.jobProgressService.publishProgress(
          AI_TRANSLATION_QUEUE,
          jobId,
          idx + 1,
          totalQ,
          {
            stage: 'DB_SAVE',
            message: `Saving English questions: ${idx + 1} of ${totalQ}...`,
            dbSaveProgress: dbPct,
            phase: 'DB_SAVE',
          },
        );
      }
    }

    // Update exam totals
    await this.prisma.exam.update({
      where: { id: exam.id },
      data: { totalQuestions: questions.length, totalMarks: questions.length * marksPerQ },
    });

    // Link schedule to new version and mark answer key ready
    await this.prisma.examSchedule.updateMany({
      where: { examId: exam.id },
      data: {
        examVersionId: examVersion.id,
        hasAnswerKey: true,
        answerKeyUploadedAt: new Date(),
        answerKeyUploadedById: userId,
      } as any,
    });

    // Ensure English default language link
    if (defaultLangId) {
      await this.prisma.examLanguage.upsert({
        where: { examId_languageId: { examId: exam.id, languageId: defaultLangId } },
        create: { examId: exam.id, languageId: defaultLangId, isDefault: true, displayOrder: 1 },
        update: { isDefault: true },
      });
    }

    return examVersion.id;
  }

  /**
   * Helper to convert Tiptap JSON or string content to clean semantic HTML
   */
  private serializeRichDocToHtml(docOrText: any, fallbackText?: string): string {
    if (!docOrText && !fallbackText) return '';

    const escapeHtml = (str: string) => {
      return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    let doc = docOrText;
    if (typeof doc === 'string') {
      try {
        const parsed = JSON.parse(doc);
        if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
          doc = parsed;
        }
      } catch {
        // Plain string
        return escapeHtml(doc).replace(/\n/g, '<br />');
      }
    }

    if (!doc || typeof doc !== 'object' || doc.type !== 'doc' || !Array.isArray(doc.content)) {
      return escapeHtml(typeof docOrText === 'string' ? docOrText : fallbackText || '').replace(/\n/g, '<br />');
    }

    const walk = (node: any): string => {
      if (!node) return '';

      if (node.type === 'text') {
        let text = escapeHtml(node.text || '');
        if (node.marks && Array.isArray(node.marks)) {
          for (const mark of node.marks) {
            if (mark.type === 'bold') text = `<strong>${text}</strong>`;
            if (mark.type === 'italic') text = `<em>${text}</em>`;
            if (mark.type === 'underline') text = `<u>${text}</u>`;
            if (mark.type === 'strike') text = `<s>${text}</s>`;
            if (mark.type === 'code') text = `<code>${text}</code>`;
          }
        }
        return text;
      }

      if (node.type === 'inlineMath') {
        const latex = node.attrs?.latex || '';
        return `<span class="math-tex inline-math" data-latex="${escapeHtml(latex)}">$${latex}$</span>`;
      }

      if (node.type === 'blockMath') {
        const latex = node.attrs?.latex || '';
        return `<div class="math-tex block-math" data-latex="${escapeHtml(latex)}">$$${latex}$$</div>`;
      }

      if (node.type === 'image') {
        const src = node.attrs?.src || '';
        const alt = escapeHtml(node.attrs?.alt || 'Question Diagram');
        return `<div class="diagram-wrapper"><img src="${src}" alt="${alt}" class="diagram-img" />${alt && alt !== 'Question diagram' && alt !== '[Image]' ? `<div class="diagram-caption">${alt}</div>` : ''}</div>`;
      }

      const inner = node.content && Array.isArray(node.content) ? node.content.map(walk).join('') : '';

      switch (node.type) {
        case 'paragraph':
          return `<p>${inner || '&nbsp;'}</p>`;
        case 'heading':
          const level = Math.min(Math.max(1, node.attrs?.level || 3), 6);
          return `<h${level}>${inner}</h${level}>`;
        case 'bulletList':
          return `<ul>${inner}</ul>`;
        case 'orderedList':
          return `<ol>${inner}</ol>`;
        case 'listItem':
          return `<li>${inner}</li>`;
        case 'table':
          return `<table class="content-table">${inner}</table>`;
        case 'tableRow':
          return `<tr>${inner}</tr>`;
        case 'tableCell':
          return `<td>${inner}</td>`;
        case 'tableHeader':
          return `<th>${inner}</th>`;
        case 'blockquote':
          return `<blockquote>${inner}</blockquote>`;
        case 'horizontalRule':
          return '<hr />';
        default:
          return inner;
      }
    };

    return doc.content.map(walk).join('');
  }

  /**
   * GET /api/ai-translations/jobs/:jobId/print
   * Generate complete, publication-ready, multi-page printable HTML question paper for the selected language
   */
  async generatePrintableQuestionPaperHtml(
    jobId: string,
    languageId?: string,
    languageCode?: string,
  ): Promise<string> {
    const job = await this.prisma.aiTranslationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`AI Translation Job '${jobId}' not found.`);
    }

    const exam = await this.prisma.exam.findUnique({
      where: { id: job.examId },
      include: {
        examTarget: true,
        sections: { include: { subject: true }, orderBy: { displayOrder: 'asc' } },
      },
    });

    const examVersion = job.examVersionId
      ? await this.prisma.examVersion.findUnique({
          where: { id: job.examVersionId },
        })
      : null;

    // 1. Resolve Target Language
    const allLanguages = await this.prisma.preferredLanguage.findMany();
    let targetLang = allLanguages.find(
      (l) =>
        (languageId && l.id === languageId) ||
        (languageCode && l.code?.toLowerCase() === languageCode.toLowerCase()) ||
        (languageId && l.code?.toLowerCase() === languageId.toLowerCase()),
    );

    if (!targetLang) {
      targetLang =
        allLanguages.find((l) => l.code?.toLowerCase() === 'en') ||
        allLanguages[0];
    }

    const isEnglish = targetLang?.code?.toLowerCase() === 'en';
    const targetLangId = targetLang?.id;
    const targetLangCode = targetLang?.code?.toLowerCase() || 'en';
    const targetLangName = targetLang?.name || 'English';

    // 2. Fetch all ExamVersionQuestions with options and translations
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

    // 3. Fetch source questions for rich content fallback
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

    const examTitle = exam?.title || 'Examination Question Paper';
    const examCode = (exam as any)?.code || '';
    const examTargetName = exam?.examTarget?.name || '';
    const durationMinutes = exam?.durationMinutes || examVersion?.durationMinutes || 60;
    const totalMarks = examVersion?.totalMarks || evQuestions.length * 4;
    const totalQuestions = evQuestions.length;

    // 4. Build Question Cards
    const questionCardsHtml = evQuestions.map((q, idx) => {
      const seq = q.sequenceNumber || idx + 1;
      const masterQ = masterQMap.get(q.sourceQuestionId);

      // Resolve question translation
      const qTrans = !isEnglish
        ? q.translations.find(
            (t) =>
              t.languageId === targetLangId ||
              t.languageCode?.toLowerCase() === targetLangCode,
          ) ||
          masterQ?.translations.find(
            (t) =>
              t.languageId === targetLangId ||
              (t as any).languageCode?.toLowerCase() === targetLangCode,
          )
        : null;

      // Passage
      const rawPassageContent = !isEnglish
        ? (qTrans as any)?.passageContent || qTrans?.passageText || (q as any).passageContent || q.passage
        : (q as any).passageContent || q.passage || masterQ?.passageContent || masterQ?.passage;
      const passageHtml = rawPassageContent
        ? `<div class="passage-box"><div class="passage-header">Passage / Comprehension</div>${this.serializeRichDocToHtml(rawPassageContent, q.passage || '')}</div>`
        : '';

      // Assertion & Reason
      const rawAssertionContent = !isEnglish
        ? (qTrans as any)?.assertionContent || (qTrans as any)?.assertionText || (q as any).assertionContent || q.assertion
        : (q as any).assertionContent || q.assertion;
      const rawReasonContent = !isEnglish
        ? (qTrans as any)?.reasonContent || (qTrans as any)?.reasonText || (q as any).reasonContent || q.reason
        : (q as any).reasonContent || q.reason;

      let assertionReasonHtml = '';
      if (rawAssertionContent || rawReasonContent) {
        assertionReasonHtml = `
          <div class="assertion-reason-box">
            ${rawAssertionContent ? `<div class="assertion-row"><strong>Assertion (A):</strong> ${this.serializeRichDocToHtml(rawAssertionContent, q.assertion || '')}</div>` : ''}
            ${rawReasonContent ? `<div class="reason-row"><strong>Reason (R):</strong> ${this.serializeRichDocToHtml(rawReasonContent, q.reason || '')}</div>` : ''}
          </div>
        `;
      }

      // Question Statement
      const rawQuestionContent = !isEnglish
        ? (qTrans as any)?.questionContent || qTrans?.questionText || (q as any).questionContent || q.questionText
        : (q as any).questionContent || q.questionText || masterQ?.questionContent;
      const questionTextHtml = this.serializeRichDocToHtml(rawQuestionContent, q.questionText);

      // Options
      const optionsHtml = q.options.map((opt) => {
        const optKey = opt.optionKey || opt.optionLabel || 'A';
        const masterOpt = masterQ?.options.find((o) => o.optionKey === optKey);

        const optTrans = !isEnglish
          ? opt.translations.find(
              (ot) =>
                ot.languageId === targetLangId ||
                ot.languageCode?.toLowerCase() === targetLangCode,
            ) ||
            masterOpt?.translations.find((ot) => ot.languageId === targetLangId)
          : null;

        const rawOptContent = !isEnglish
          ? (optTrans as any)?.optionContent ||
            (optTrans?.optionText && optTrans.optionText !== '[Image]' && !optTrans.optionText.includes('[Image]')
              ? optTrans.optionText
              : (opt as any).optionContent || opt.optionText)
          : (opt as any).optionContent || opt.optionText || (masterOpt as any)?.optionContent;

        const optContentHtml = this.serializeRichDocToHtml(rawOptContent, opt.optionText || '');

        return `
          <div class="option-item">
            <span class="option-key">(${optKey})</span>
            <div class="option-content">${optContentHtml}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="question-card" id="q-${seq}">
          <div class="question-card-header">
            <div class="q-seq-badge">Question ${seq}</div>
            <div class="q-meta-badges">
              ${q.subjectName ? `<span class="q-badge subject-badge">${q.subjectName}</span>` : ''}
              ${q.sectionName ? `<span class="q-badge section-badge">${q.sectionName}</span>` : ''}
              <span class="q-badge marks-badge">+${q.marks || 4} / -${q.negativeMarks || 1}</span>
            </div>
          </div>
          ${passageHtml}
          ${assertionReasonHtml}
          <div class="question-body">
            ${questionTextHtml}
          </div>
          <div class="options-grid">
            ${optionsHtml}
          </div>
        </div>
      `;
    }).join('\n');

    // 5. Complete Standalone HTML Document
    return `<!DOCTYPE html>
<html lang="${targetLangCode}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${examTitle} - ${targetLangName} Question Paper</title>
  <!-- KaTeX for crisp LaTeX formulas -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"></script>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", "Noto Sans Gujarati", "Noto Sans Telugu", "Noto Sans Tamil", "Noto Sans Kannada", "Noto Sans Malayalam", "Noto Sans Bengali", sans-serif;
      color: #0f172a;
      background-color: #f8fafc;
      font-size: 14px;
      line-height: 1.6;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* Screen Action Bar */
    .screen-action-bar {
      position: sticky;
      top: 0;
      z-index: 999;
      background: #1e293b;
      color: #ffffff;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    .action-bar-title {
      font-size: 15px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lang-pill {
      background: #4f46e5;
      color: #ffffff;
      padding: 3px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
    .action-buttons {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-primary {
      background: #4f46e5;
      color: #ffffff;
    }
    .btn-primary:hover {
      background: #4338ca;
    }
    .btn-secondary {
      background: #334155;
      color: #f1f5f9;
    }
    .btn-secondary:hover {
      background: #475569;
    }

    /* Printable Page Container */
    .paper-container {
      max-width: 860px;
      margin: 24px auto;
      background: #ffffff;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
    }

    /* Official Exam Header */
    .exam-header {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 16px;
      margin-bottom: 20px;
      text-align: center;
    }
    .exam-main-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #0f172a;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .exam-sub-title {
      font-size: 14px;
      font-weight: 600;
      color: #475569;
      margin-bottom: 12px;
    }
    .exam-meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 12px;
      text-align: left;
    }
    .meta-item strong {
      display: block;
      color: #64748b;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .meta-item span {
      font-weight: 700;
      color: #0f172a;
    }

    /* Instructions Box */
    .instructions-card {
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 24px;
      font-size: 12px;
      line-height: 1.5;
    }
    .instructions-card h4 {
      font-weight: 700;
      color: #1e293b;
      margin-bottom: 6px;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }
    .instructions-card ul {
      padding-left: 18px;
      color: #334155;
    }

    /* Question Cards */
    .question-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 20px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .question-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px dashed #e2e8f0;
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .q-seq-badge {
      font-weight: 800;
      font-size: 14px;
      color: #4f46e5;
    }
    .q-meta-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .q-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: #f1f5f9;
      color: #475569;
    }
    .marks-badge {
      background: #ecfdf5;
      color: #059669;
      border: 1px solid #a7f3d0;
    }

    /* Passage & Assertion Boxes */
    .passage-box {
      background: #f8fafc;
      border-left: 3px solid #4f46e5;
      padding: 12px 14px;
      margin-bottom: 12px;
      border-radius: 0 6px 6px 0;
      font-size: 13px;
    }
    .passage-header {
      font-weight: 700;
      color: #4f46e5;
      font-size: 11px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .assertion-reason-box {
      background: #faf5ff;
      border: 1px solid #e9d5ff;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .assertion-row, .reason-row {
      margin-bottom: 4px;
    }

    /* Question Statement */
    .question-body {
      font-size: 14px;
      font-weight: 500;
      color: #0f172a;
      line-height: 1.6;
      margin-bottom: 14px;
    }
    .diagram-wrapper {
      margin: 12px 0;
      text-align: center;
    }
    .diagram-img {
      max-width: 100%;
      max-height: 260px;
      height: auto;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
      object-contain: contain;
    }
    .diagram-caption {
      font-size: 11px;
      color: #64748b;
      margin-top: 4px;
      font-style: italic;
    }

    /* Options Grid */
    .options-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }
    .option-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 13px;
    }
    .option-key {
      font-weight: 800;
      color: #334155;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .option-content {
      flex: 1;
      color: #1e293b;
      word-break: break-word;
    }
    .option-content img {
      max-width: 100%;
      max-height: 160px;
      height: auto;
      border-radius: 4px;
    }

    /* Print Specific Media Styles */
    @media print {
      body {
        background-color: #ffffff !important;
        font-size: 12pt;
      }
      .no-print, .screen-action-bar {
        display: none !important;
      }
      .paper-container {
        max-width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
      }
      .question-card {
        border: 1px solid #cbd5e1 !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        margin-bottom: 16px !important;
        padding: 14px !important;
      }
      .options-grid {
        gap: 8px !important;
      }
      @page {
        size: A4 portrait;
        margin: 15mm 15mm 20mm 15mm;
      }
    }
  </style>
</head>
<body>
  <!-- Floating Screen Action Bar (Hidden in Print) -->
  <div class="screen-action-bar no-print">
    <div class="action-bar-title">
      <span>Question Paper Preview</span>
      <span class="lang-pill">${targetLangName}</span>
      <span style="font-size: 12px; color: #94a3b8; font-weight: normal;">• ${totalQuestions} Questions</span>
    </div>
    <div class="action-buttons">
      <button class="btn btn-primary" onclick="window.print()">
        <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
        </svg>
        Print Whole Paper
      </button>
      <button class="btn btn-secondary" onclick="window.close()">Close</button>
    </div>
  </div>

  <!-- Printable Paper Body -->
  <div class="paper-container">
    <!-- Header -->
    <header class="exam-header">
      <h1 class="exam-main-title">${examTitle}</h1>
      ${examTargetName ? `<div class="exam-sub-title">${examTargetName} ${examCode ? `(${examCode})` : ''}</div>` : ''}
      <div class="exam-meta-grid">
        <div class="meta-item">
          <strong>Language</strong>
          <span>${targetLangName}</span>
        </div>
        <div class="meta-item">
          <strong>Total Questions</strong>
          <span>${totalQuestions}</span>
        </div>
        <div class="meta-item">
          <strong>Duration</strong>
          <span>${durationMinutes} Mins</span>
        </div>
        <div class="meta-item">
          <strong>Max Marks</strong>
          <span>${totalMarks}</span>
        </div>
      </div>
    </header>

    <!-- General Instructions -->
    <div class="instructions-card">
      <h4>General Instructions:</h4>
      <ul>
        <li>This paper contains <strong>${totalQuestions}</strong> questions in <strong>${targetLangName}</strong>.</li>
        <li>All questions are compulsory unless specified otherwise.</li>
        <li>Each question has four options (A, B, C, D). Choose the most appropriate single response.</li>
        <li>Correct answers earn <strong>+4 marks</strong>; incorrect answers incur <strong>-1 mark</strong> penalty.</li>
      </ul>
    </div>

    <!-- Full Questions List -->
    <main class="questions-list">
      ${questionCardsHtml}
    </main>
  </div>

  <script>
    // Automatically render Math / LaTeX expressions
    document.addEventListener("DOMContentLoaded", function() {
      if (window.renderMathInElement) {
        renderMathInElement(document.body, {
          delimiters: [
            {left: "$$", right: "$$", display: true},
            {left: "$", right: "$", display: false},
            {left: "\\(", right: "\\)", display: false},
            {left: "\\[", right: "\\]", display: true}
          ],
          throwOnError: false
        });
      }
    });
  </script>
</body>
</html>`;
  }

}
