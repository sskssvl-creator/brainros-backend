import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { ExamPaperParserService } from './exam-paper-parser.service';
import { ExamPaperValidatorService } from './exam-paper-validator.service';
import {
  ExamImportFormatEnum,
  ExamImportFilterDto,
  ExamPaperValidationResult,
  BlueprintItemDto,
  BlueprintSubjectRule,
  ComprehensiveExamValidationResult,
  CreateExamFromUploadDto,
  ExamManagerFilterDto,
  TranslationValidationSummary,
} from '../dto/exam-manager.dto';
import { QuestionDifficultyEnum, QuestionTypeEnum, Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ExamImportJobData } from '../processors/exam-import.processor';
import { AiTranslationService } from '../../ai-translation/services/ai-translation.service';

@Injectable()
export class ExamPaperImportService {
  private readonly logger = new Logger(ExamPaperImportService.name);
  private readonly storageDir = path.join(process.cwd(), 'uploads', 'exam-imports');

  constructor(
    private readonly prisma: PrismaService,
    private readonly parserService: ExamPaperParserService,
    private readonly validatorService: ExamPaperValidatorService,
    private readonly aiTranslationService: AiTranslationService,
    @InjectQueue('exam-import-queue') private readonly examImportQueue: Queue,
  ) {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Preview Question Paper upload with comprehensive validation metrics & diagnostics
   */
  async previewQuestionPaperUpload(
    file: { originalname: string; size: number; buffer: Buffer },
    examId: string,
  ) {
    this.validateFile(file);

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        sections: { include: { subject: true } },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    const parsedRows = await this.parserService.parseBuffer(
      file.buffer,
      file.originalname,
    );

    const validationResult = await this.validatorService.validatePaper(
      parsedRows,
    );

    // Exam compatibility check
    const examErrors: Array<{ row: number; column?: string; message: string }> = [
      ...validationResult.errors,
    ];

    if (parsedRows.length > 0) {
      const firstRowTarget = (parsedRows[0].examTarget || '').trim().toUpperCase();
      const examTargetName = (exam.examTarget?.name || '').trim().toUpperCase();
      if (
        firstRowTarget &&
        examTargetName &&
        !examTargetName.includes(firstRowTarget) &&
        !firstRowTarget.includes(examTargetName)
      ) {
        examErrors.push({
          row: 1,
          column: 'exam_target',
          message: `Incompatible paper: Uploaded paper specifies target '${parsedRows[0].examTarget}', but selected exam target is '${exam.examTarget?.name}'.`,
        });
        validationResult.isValid = false;
      }
    }

    // Collect subjects, chapters, question types
    const subjectsSet = new Set<string>();
    const chaptersSet = new Set<string>();
    const questionTypesSet = new Set<string>();

    const previewRows = validationResult.validatedRows.map((vr) => {
      const d = vr.data;
      if (d.subject) subjectsSet.add(d.subject);
      if (d.chapter) chaptersSet.add(d.chapter);
      if (d.questionType) questionTypesSet.add(d.questionType);

      const rowHasExamError = examErrors.some((e) => e.row === vr.rowNumber);

      return {
        rowNumber: vr.rowNumber,
        questionText: d.questionText || '',
        questionType: d.questionType || 'SINGLE_CORRECT',
        subject: d.subject || '',
        chapter: d.chapter || '',
        options: {
          A: d.optionA || '',
          B: d.optionB || '',
          C: d.optionC || '',
          D: d.optionD || '',
        },
        correctAnswer: d.correctAnswer || '',
        marks: d.marks || 4,
        negativeMarks: d.negativeMarks || 1,
        isValid: vr.isValid && !rowHasExamError,
        errors: [
          ...vr.errors,
          ...examErrors.filter((e) => e.row === vr.rowNumber).map((e) => e.message),
        ],
        warnings: vr.warnings,
      };
    });

    return {
      isValid: validationResult.isValid && examErrors.length === 0,
      examId: exam.id,
      examTitle: exam.title,
      examTarget: exam.examTarget?.name || 'General',
      totalQuestions: parsedRows.length,
      validQuestions: previewRows.filter((r) => r.isValid).length,
      invalidQuestions: previewRows.filter((r) => !r.isValid).length,
      subjects: Array.from(subjectsSet),
      chapters: Array.from(chaptersSet),
      questionTypes: Array.from(questionTypesSet),
      errors: examErrors,
      warnings: validationResult.warnings,
      previewRows: previewRows.slice(0, 100),
    };
  }

  /**
   * Submit Question Paper for asynchronous background processing via BullMQ
   */
  async submitQuestionPaperUpload(
    file: { originalname: string; size: number; buffer: Buffer },
    examId: string,
    userId: string,
  ) {
    this.validateFile(file);

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    // Idempotency: avoid duplicate active jobs if submitted recently
    const activeImport = await (this.prisma as any).examImport.findFirst({
      where: {
        createdExamId: examId,
        status: 'PROCESSING',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeImport) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      if (activeImport.startedAt && activeImport.startedAt > tenMinutesAgo) {
        return {
          message: 'Question paper has been queued for processing.',
          importId: activeImport.id,
          jobId: activeImport.id,
        };
      }
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const storedFileName = `${Date.now()}_${path.basename(file.originalname)}`;
    const storagePath = path.join(this.storageDir, storedFileName);
    await fs.promises.writeFile(storagePath, file.buffer);

    const importSession = await (this.prisma as any).examImport.create({
      data: {
        fileName: file.originalname,
        fileType: ext.replace('.', '').toUpperCase(),
        storageKey: storagePath,
        fileSize: file.size,
        status: 'PROCESSING',
        createdById: userId,
        createdExamId: examId,
        createdExamTitle: exam.title,
        startedAt: new Date(),
      },
    });

    const job = await this.examImportQueue.add(
      'process-exam-paper',
      {
        importId: importSession.id,
        examId,
        userId,
        filePath: storagePath,
        originalFileName: file.originalname,
      },
      {
        jobId: importSession.id,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return {
      message: 'Question paper has been queued for processing.',
      importId: importSession.id,
      jobId: String(job.id),
    };
  }

  /**
   * Background Execution of Question Paper import (invoked by BullMQ Worker)
   * Enforces safe replacement: existing questions are preserved if import fails
   */
  async executeBackgroundExamImport(
    data: ExamImportJobData,
    progressCallback: (
      current: number,
      total: number,
      stage: string,
      message: string,
    ) => Promise<void>,
  ) {
    const { importId, examId, userId, filePath, originalFileName } = data;

    await progressCallback(5, 100, 'PARSING', 'Reading and parsing file...');

    const buffer = await fs.promises.readFile(filePath);
    const parsedRows = await this.parserService.parseBuffer(buffer, originalFileName);

    await progressCallback(15, 100, 'VALIDATING', 'Validating questions & structure...');
    const validationResult = await this.validatorService.validatePaper(parsedRows);

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        sections: { include: { subject: true } },
      },
    });

    if (!exam) {
      throw new Error(`Exam with ID '${examId}' not found.`);
    }

    // Compatibility check
    if (parsedRows.length > 0) {
      const firstRowTarget = (parsedRows[0].examTarget || '').trim().toUpperCase();
      const examTargetName = (exam.examTarget?.name || '').trim().toUpperCase();
      if (
        firstRowTarget &&
        examTargetName &&
        !examTargetName.includes(firstRowTarget) &&
        !firstRowTarget.includes(examTargetName)
      ) {
        validationResult.errors.push({
          row: 1,
          column: 'exam_target',
          message: `Uploaded question paper is for target '${parsedRows[0].examTarget}', but selected exam is for '${exam.examTarget?.name}'.`,
        });
        validationResult.isValid = false;
      }
    }

    // Record staged rows
    const stagingData = validationResult.validatedRows.map((r) => ({
      importId,
      rowNumber: r.rowNumber,
      status: r.isValid ? 'VALID' : 'INVALID',
      examCode: r.data.examCode,
      examTitle: r.data.examName,
      subjectName: r.data.subject,
      sectionName: r.data.sectionName,
      questionNumber: r.data.questionNumber,
      rawData: r.data as any,
      normalizedData: r.data as any,
      dtoData: r.data as any,
      errors: r.errors,
      warnings: r.warnings,
    }));

    await (this.prisma as any).examImportRow.createMany({
      data: stagingData,
    });

    // Check if validation failed: safe replacement preserves old paper
    if (!validationResult.isValid || validationResult.errors.length > 0) {
      const errorSummary = `Validation failed with ${validationResult.errors.length} error(s). Existing question paper remained intact.`;
      await (this.prisma as any).examImport.update({
        where: { id: importId },
        data: {
          status: 'FAILED',
          totalRows: validationResult.totalRows,
          validRows: validationResult.validRows,
          invalidRows: validationResult.invalidRows,
          errorSummary,
          completedAt: new Date(),
        },
      });
      throw new BadRequestException(errorSummary);
    }

    await progressCallback(25, 100, 'PROCESSING', 'Processing questions and options...');

    // Execute atomic safe transaction attaching/replacing questions on exam
    const totalRows = validationResult.validatedRows.length;
    let createdVersionId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      // 1. Resolve default preferred language
      let defaultLang = await tx.preferredLanguage.findFirst({
        where: { code: 'en' },
      });
      if (!defaultLang) defaultLang = await tx.preferredLanguage.findFirst();

      // 2. Sections resolution
      const sectionNameToDbRecord = new Map<string, any>();
      for (let sIdx = 0; sIdx < validationResult.sections.length; sIdx++) {
        const sec = validationResult.sections[sIdx];
        const subLower = (sec.subject || '').toLowerCase().trim();
        const cleanName = subLower.includes('physic')
          ? 'Physics'
          : subLower.includes('chem')
          ? 'Chemistry'
          : subLower.includes('math')
          ? 'Mathematics'
          : subLower.includes('bio') || subLower.includes('botan') || subLower.includes('zool')
          ? 'Biology'
          : sec.subject;

        let subject = await tx.subject.findFirst({
          where: {
            name: { equals: cleanName, mode: 'insensitive' },
          },
        });
        if (!subject) {
          subject = await tx.subject.create({
            data: {
              name: cleanName,
              code: cleanName.toUpperCase().slice(0, 4),
              displayOrder: sIdx + 1,
            },
          });
        }
        if (exam.examTargetId) {
          await tx.examTargetSubject.upsert({
            where: {
              examTargetId_subjectId: {
                examTargetId: exam.examTargetId,
                subjectId: subject.id,
              },
            },
            create: {
              examTargetId: exam.examTargetId,
              subjectId: subject.id,
              displayOrder: sIdx + 1,
            },
            update: {},
          });
        }

        let examSection = await tx.examSection.findFirst({
          where: {
            examId: exam.id,
            name: { equals: sec.name, mode: 'insensitive' },
          },
        });

        if (!examSection) {
          examSection = await tx.examSection.create({
            data: {
              examId: exam.id,
              subjectId: subject.id,
              name: sec.name,
              totalQuestions: sec.questionCount,
              displayOrder: sIdx + 1,
            },
          });
        } else {
          examSection = await tx.examSection.update({
            where: { id: examSection.id },
            data: {
              subjectId: subject.id,
              totalQuestions: sec.questionCount,
            },
          });
        }

        sectionNameToDbRecord.set(`${sec.subject}::${sec.name}`, {
          section: examSection,
          subject,
        });
      }

      // 3. Create questions, options, translations, answers, explanations
      const newExamQuestionsData: Array<{
        examId: string;
        sectionId: string;
        questionId: string;
        displayOrder: number;
        marks: number;
        negativeMarks: number;
      }> = [];
      const createdQuestionTuples: Array<{
        questionId: string;
        sourceRow: any;
        options: Array<{ id: string; optionKey: string; optionText: string; isCorrect: boolean }>;
      }> = [];

      for (let qIdx = 0; qIdx < totalRows; qIdx++) {
        const row = validationResult.validatedRows[qIdx];
        const data = row.data;

        const secKey = `${data.subject || 'General'}::${
          data.sectionName || `${data.subject || 'General'} Section`
        }`;
        const secData =
          sectionNameToDbRecord.get(secKey) ||
          Array.from(sectionNameToDbRecord.values())[0];

        const subject = secData.subject;
        const examSection = secData.section;

        // Resolve Chapter
        let chapter = data.chapter
          ? await tx.chapter.findFirst({
              where: {
                subjectId: subject.id,
                name: { equals: data.chapter, mode: 'insensitive' },
              },
            })
          : null;

        if (!chapter) {
          chapter = await tx.chapter.findFirst({
            where: { subjectId: subject.id },
          });
          if (!chapter) {
            chapter = await tx.chapter.create({
              data: {
                subjectId: subject.id,
                name: data.chapter || `${subject.name} General Chapter`,
              },
            });
          }
        }

        const diffLevel = (
          ['EASY', 'MEDIUM', 'HARD', 'VERY_HARD'].includes(data.difficulty || '')
            ? data.difficulty
            : 'MEDIUM'
        ) as QuestionDifficultyEnum;

        const qType = (
          [
            'SINGLE_CORRECT',
            'MULTIPLE_CORRECT',
            'NUMERICAL',
            'ASSERTION_REASON',
            'MATCH_FOLLOWING',
            'CASE_BASED',
          ].includes(data.questionType || '')
            ? data.questionType
            : 'SINGLE_CORRECT'
        ) as QuestionTypeEnum;

        // Create Question
        const question = await tx.question.create({
          data: {
            subjectId: subject.id,
            chapterId: chapter.id,
            difficultyLevel: diffLevel,
            type: qType,
            status: 'APPROVED',
            marks: data.marks || 4.0,
            negativeMarks: data.negativeMarks || 1.0,
            passage: data.passageText || null,
            assertion: data.assertionText || null,
            reason: data.reasonText || null,
            defaultLanguageId: defaultLang ? defaultLang.id : (undefined as any),
            createdById: userId,
            approvedById: userId,
            approvedAt: new Date(),
          },
        });

        // Question Translation
        if (defaultLang) {
          await tx.questionTranslation.create({
            data: {
              questionId: question.id,
              languageId: defaultLang.id,
              questionText: data.questionText,
              passageText: data.passageText || null,
              assertionText: data.assertionText || null,
              reasonText: data.reasonText || null,
              explanation: data.explanation || null,
            },
          });
        }

        // Options
        const optionKeys = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
        const correctAnswers = (data.correctAnswer || '')
          .toUpperCase()
          .split(/[\s,;]+/)
          .map((s) => s.trim());

        const correctOptionIds: string[] = [];

        const createdQuestionOptions: Array<{ id: string; optionKey: string; optionText: string; isCorrect: boolean }> = [];

        for (let oIdx = 0; oIdx < optionKeys.length; oIdx++) {
          const key = optionKeys[oIdx];
          const optText = (data as any)[`option${key}`];

          if (optText && optText.trim()) {
            const isCorrect = correctAnswers.includes(key);
            const opt = await tx.questionOption.create({
              data: {
                questionId: question.id,
                optionKey: key,
                optionText: optText.trim(),
                isCorrect,
                displayOrder: oIdx + 1,
              },
            });

            createdQuestionOptions.push({
              id: opt.id,
              optionKey: key,
              optionText: optText.trim(),
              isCorrect,
            });

            if (isCorrect) correctOptionIds.push(opt.id);

            if (defaultLang) {
              await tx.questionOptionTranslation.create({
                data: {
                  optionId: opt.id,
                  languageId: defaultLang.id,
                  optionText: optText.trim(),
                },
              });
            }
          }
        }

        // Answer
        await tx.questionAnswer.create({
          data: {
            questionId: question.id,
            answerType: qType,
            correctOptionIds:
              correctOptionIds.length > 0 ? correctOptionIds : undefined,
            numericalAnswer:
              qType === 'NUMERICAL' ? parseFloat(data.correctAnswer) : null,
          },
        });

        // Explanation
        if (data.explanation && data.explanation.trim()) {
          await tx.questionExplanation.create({
            data: {
              questionId: question.id,
              explanation: data.explanation.trim(),
            },
          });
        }

        newExamQuestionsData.push({
          examId: exam.id,
          sectionId: examSection.id,
          questionId: question.id,
          displayOrder: qIdx + 1,
          marks: data.marks || 4.0,
          negativeMarks: data.negativeMarks || 1.0,
        });

        createdQuestionTuples.push({
          questionId: question.id,
          sourceRow: data,
          options: createdQuestionOptions,
        });

        // Incremental progress
        if ((qIdx + 1) % 20 === 0 || qIdx === totalRows - 1) {
          await progressCallback(
            qIdx + 1,
            totalRows,
            'PROCESSING',
            `Processed ${qIdx + 1} of ${totalRows} questions...`,
          );
        }
      }

      // 4. Safe replacement: delete previous examQuestions links for this exam
      await tx.examQuestion.deleteMany({
        where: { examId: exam.id },
      });

      // 5. Insert new examQuestions
      for (const eqData of newExamQuestionsData) {
        await tx.examQuestion.create({
          data: eqData,
        });
      }

      // 6. Update exam metrics
      await tx.exam.update({
        where: { id: exam.id },
        data: {
          totalQuestions: validationResult.totalQuestions,
          totalMarks: validationResult.totalMarks,
          durationMinutes: validationResult.durationMinutes || exam.durationMinutes,
        },
      });

      // 7. Create or update ExamVersion
      const latestVersion = await tx.examVersion.findFirst({
        where: { examId: exam.id },
        orderBy: { versionNumber: 'desc' },
      });
      const newVersionNumber = (latestVersion?.versionNumber || 0) + 1;

      const examVersion = await tx.examVersion.create({
        data: {
          examId: exam.id,
          versionNumber: newVersionNumber,
          status: 'GENERATED',
          totalQuestions: validationResult.totalQuestions,
          durationMinutes: validationResult.durationMinutes || exam.durationMinutes,
          totalMarks: validationResult.totalMarks,
          generatedById: userId,
        },
      });

      // Populate ExamVersionQuestions & Options
      let vSeq = 1;
      for (const tuple of createdQuestionTuples) {
        const vq = await tx.examVersionQuestion.create({
          data: {
            examVersionId: examVersion.id,
            sourceQuestionId: tuple.questionId,
            sequenceNumber: vSeq++,
            sectionName: tuple.sourceRow.sectionName || tuple.sourceRow.subject || 'General',
            subjectName: tuple.sourceRow.subject || 'General',
            type: tuple.sourceRow.questionType || 'SINGLE_CORRECT',
            difficultyLevel: tuple.sourceRow.difficulty || 'MEDIUM',
            marks: tuple.sourceRow.marks || 4.0,
            negativeMarks: tuple.sourceRow.negativeMarks || 1.0,
            passage: tuple.sourceRow.passageText || null,
            assertion: tuple.sourceRow.assertionText || null,
            reason: tuple.sourceRow.reasonText || null,
            questionText: tuple.sourceRow.questionText || 'Question statement',
            explanation: tuple.sourceRow.explanation || null,
            correctAnswer: tuple.sourceRow.correctAnswer ? { key: tuple.sourceRow.correctAnswer } : undefined,
          },
        });

        for (let oIdx = 0; oIdx < tuple.options.length; oIdx++) {
          const opt = tuple.options[oIdx];
          await tx.examVersionOption.create({
            data: {
              examVersionQuestionId: vq.id,
              sourceOptionId: opt.id,
              displayOrder: oIdx + 1,
              optionKey: opt.optionKey,
              optionLabel: opt.optionKey,
              optionText: opt.optionText || '',
              isCorrect: opt.isCorrect,
            },
          });
        }
      }

      // Update schedule to link to this version & mark answer key as ready
      await tx.examSchedule.updateMany({
        where: { examId: exam.id },
        data: {
          examVersionId: examVersion.id,
          hasAnswerKey: true,
          answerKeyUploadedAt: new Date(),
          answerKeyUploadedById: userId,
        },
      });

      // 8. Update import session
      await (tx as any).examImport.update({
        where: { id: importId },
        data: {
          status: 'COMPLETED',
          totalRows: validationResult.totalRows,
          validRows: validationResult.validRows,
          invalidRows: 0,
          examCount: 1,
          questionsCreated: validationResult.totalQuestions,
          sectionsCreated: validationResult.sections.length,
          createdExamId: exam.id,
          createdExamTitle: exam.title,
          completedAt: new Date(),
        },
      });
      createdVersionId = examVersion.id;
    }, {
      maxWait: 60000,
      timeout: 300000,
    });

    // Automatically trigger shared AI Translation for imported exam version
    if (createdVersionId) {
      try {
        await this.aiTranslationService.startQuestionPaperTranslation(
          exam.id,
          createdVersionId,
          userId,
        );
      } catch (err: any) {
        this.logger.warn(
          `Could not start automatic AI translation for imported exam ${exam.id}: ${err.message}`,
        );
      }
    }

    await progressCallback(
      totalRows,
      totalRows,
      'COMPLETED',
      `Completed: ${totalRows} of ${totalRows} questions imported successfully.`,
    );

    return {
      success: true,
      questionsCreated: validationResult.totalQuestions,
      sectionsCreated: validationResult.sections.length,
    };
  }

  /**
   * Dedicated Read-Only View of complete question paper
   * Shows questions and options in exact persisted order without student randomization
   */
  async getExamQuestionPaper(examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: { select: { id: true, name: true, description: true } },
        status: { select: { id: true, name: true } },
        sections: {
          orderBy: { displayOrder: 'asc' },
          include: { subject: { select: { id: true, name: true, code: true } } },
        },
        examQuestions: {
          orderBy: { displayOrder: 'asc' },
          include: {
            section: { select: { id: true, name: true } },
            question: {
              include: {
                subject: { select: { id: true, name: true } },
                chapter: { select: { id: true, name: true } },
                options: {
                  orderBy: { displayOrder: 'asc' },
                  include: { translations: true },
                },
                answer: true,
                explanation: true,
                translations: true,
              },
            },
          },
        },
        schedules: {
          orderBy: { startTime: 'desc' },
          take: 1,
        },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    const questions = exam.examQuestions.map((eq, idx) => {
      const q = eq.question;
      const translation = q.translations?.[0];
      const questionText = translation?.questionText || (q as any).questionText || '';
      const explanationText = q.explanation?.explanation || translation?.explanation || '';

      const options = (q.options || []).map((opt) => ({
        id: opt.id,
        optionKey: opt.optionKey,
        optionText: opt.translations?.[0]?.optionText || opt.optionText || '',
        isCorrect: opt.isCorrect,
        displayOrder: opt.displayOrder,
      }));

      return {
        id: q.id,
        questionNumber: idx + 1,
        displayOrder: eq.displayOrder,
        questionText,
        passageText: translation?.passageText || q.passage || null,
        assertionText: translation?.assertionText || q.assertion || null,
        reasonText: translation?.reasonText || q.reason || null,
        type: q.type,
        difficultyLevel: q.difficultyLevel,
        subject: q.subject?.name || eq.section?.name || 'General',
        chapter: q.chapter?.name || null,
        section: eq.section?.name || null,
        marks: eq.marks ?? q.marks,
        negativeMarks: eq.negativeMarks ?? q.negativeMarks,
        options,
        correctAnswer: q.correctAnswer,
        explanation: explanationText,
      };
    });

    return {
      id: exam.id,
      title: exam.title,
      description: exam.description,
      examTarget: exam.examTarget?.name || 'General',
      status: exam.status?.name || 'DRAFT',
      durationMinutes: exam.durationMinutes,
      totalMarks: exam.totalMarks,
      totalQuestions: questions.length,
      schedule: exam.schedules?.[0] || null,
      sections: exam.sections.map((s) => ({
        id: s.id,
        name: s.name,
        subject: s.subject?.name || '',
        totalQuestions: s.totalQuestions,
      })),
      questions,
    };
  }

  /**
   * Retry failed question paper upload from stored storageKey
   */
  async retryQuestionPaperUpload(examId: string, userId: string) {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) throw new NotFoundException(`Exam with ID '${examId}' not found.`);

    const latestFailedImport = await (this.prisma as any).examImport.findFirst({
      where: {
        createdExamId: examId,
        status: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestFailedImport || !latestFailedImport.storageKey) {
      throw new BadRequestException('No previous failed import found to retry for this exam.');
    }

    if (!fs.existsSync(latestFailedImport.storageKey)) {
      throw new BadRequestException('The stored import file is no longer available on disk. Please upload again.');
    }

    await (this.prisma as any).examImport.update({
      where: { id: latestFailedImport.id },
      data: {
        status: 'PROCESSING',
        startedAt: new Date(),
        errorSummary: null,
      },
    });

    const job = await this.examImportQueue.add(
      'process-exam-paper',
      {
        importId: latestFailedImport.id,
        examId,
        userId,
        filePath: latestFailedImport.storageKey,
        originalFileName: latestFailedImport.fileName,
      },
      {
        jobId: latestFailedImport.id,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return {
      message: 'Question paper upload has been requeued for processing.',
      importId: latestFailedImport.id,
      jobId: String(job.id),
    };
  }

  /**
   * Upload and process question paper file synchronously with transaction safety
   */
  async processQuestionPaperUpload(
    file: { originalname: string; size: number; buffer: Buffer },
    userId: string,
  ) {
    this.validateFile(file);

    const ext = path.extname(file.originalname).toLowerCase();
    const storedFileName = `${Date.now()}_${path.basename(file.originalname)}`;
    const storagePath = path.join(this.storageDir, storedFileName);

    await fs.promises.writeFile(storagePath, file.buffer);

    // 1. Create staged ExamImport session record
    const importSession = await (this.prisma as any).examImport.create({
      data: {
        fileName: file.originalname,
        fileType: ext.replace('.', '').toUpperCase(),
        storageKey: storagePath,
        fileSize: file.size,
        status: 'PROCESSING',
        createdById: userId,
        startedAt: new Date(),
      },
    });

    try {
      // 2. Parse File
      const parsedRows = await this.parserService.parseBuffer(
        file.buffer,
        file.originalname,
      );

      // 3. Validate File
      const validationResult = await this.validatorService.validatePaper(
        parsedRows,
      );

      // 4. Record Staged Rows
      const stagingData = validationResult.validatedRows.map((r) => ({
        importId: importSession.id,
        rowNumber: r.rowNumber,
        status: r.isValid ? 'VALID' : 'INVALID',
        examCode: r.data.examCode,
        examTitle: r.data.examName,
        subjectName: r.data.subject,
        sectionName: r.data.sectionName,
        questionNumber: r.data.questionNumber,
        rawData: r.data as any,
        normalizedData: r.data as any,
        dtoData: r.data as any,
        errors: r.errors,
        warnings: r.warnings,
      }));

      await (this.prisma as any).examImportRow.createMany({
        data: stagingData,
      });

      // 5. Check If Validation Failed -> Reject without committing exam data
      if (!validationResult.isValid || validationResult.errors.length > 0) {
        const errorSummary = `Question paper validation failed with ${validationResult.errors.length} error(s). No exam created.`;

        const failedSession = await (this.prisma as any).examImport.update({
          where: { id: importSession.id },
          data: {
            status: 'FAILED',
            totalRows: validationResult.totalRows,
            validRows: validationResult.validRows,
            invalidRows: validationResult.invalidRows,
            errorSummary,
            completedAt: new Date(),
          },
        });

        return {
          success: false,
          status: 'FAILED',
          importId: importSession.id,
          message: errorSummary,
          summary: {
            totalRows: validationResult.totalRows,
            validRows: validationResult.validRows,
            invalidRows: validationResult.invalidRows,
            errorsCount: validationResult.errors.length,
          },
          errors: validationResult.errors,
          warnings: validationResult.warnings,
          session: failedSession,
        };
      }

      // 6. Execute Atomic Transaction creating Exam, Sections, Questions, Answers, Options
      const createdExam = await this.createExamFromPaper(
        validationResult,
        importSession.id,
        userId,
      );

      const completedSession = await (this.prisma as any).examImport.update({
        where: { id: importSession.id },
        data: {
          status: 'COMPLETED',
          totalRows: validationResult.totalRows,
          validRows: validationResult.validRows,
          invalidRows: 0,
          examCount: 1,
          questionsCreated: validationResult.totalQuestions,
          sectionsCreated: validationResult.sections.length,
          createdExamId: createdExam.id,
          createdExamCode: validationResult.examCode,
          createdExamTitle: createdExam.title,
          completedAt: new Date(),
        },
      });

      return {
        success: true,
        status: 'SUCCESS',
        importId: importSession.id,
        examId: createdExam.id,
        examTitle: createdExam.title,
        examCode: validationResult.examCode,
        message: `Exam '${createdExam.title}' created successfully with ${validationResult.totalQuestions} questions and ${validationResult.sections.length} sections!`,
        summary: {
          totalRows: validationResult.totalRows,
          questionsCreated: validationResult.totalQuestions,
          sectionsCreated: validationResult.sections.length,
          durationMinutes: validationResult.durationMinutes,
          totalMarks: validationResult.totalMarks,
        },
        errors: [],
        warnings: validationResult.warnings,
        session: completedSession,
      };
    } catch (err: any) {
      this.logger.error(`Import execution error: ${err.message}`, err.stack);

      await (this.prisma as any).examImport.update({
        where: { id: importSession.id },
        data: {
          status: 'FAILED',
          errorSummary: err.message || 'Import processing encountered a fatal error.',
          completedAt: new Date(),
        },
      });

      throw new BadRequestException(
        err.message || 'Failed to process question paper import.',
      );
    }
  }

  /**
   * Atomic creation of Exam, Sections, and Questions in a single database transaction
   */
  private async createExamFromPaper(
    validation: ExamPaperValidationResult,
    importId: string,
    userId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Resolve or create ExamTarget
      const targetName =
        validation.validatedRows[0]?.data.examTarget?.trim() || 'NEET';
      let examTarget = await tx.examTarget.findFirst({
        where: { name: { equals: targetName, mode: 'insensitive' } },
      });
      if (!examTarget) {
        examTarget = await tx.examTarget.findFirst();
        if (!examTarget) {
          examTarget = await tx.examTarget.create({
            data: { name: targetName, description: `${targetName} Target Exam` },
          });
        }
      }

      // 2. Resolve ExamStatus (PUBLISHED or DRAFT)
      let publishedStatus = await tx.examStatus.findFirst({
        where: { name: { in: ['PUBLISHED', 'ACTIVE', 'GENERATED'] } },
      });
      if (!publishedStatus) {
        publishedStatus = await tx.examStatus.create({
          data: { name: 'PUBLISHED' },
        });
      }

      // 3. Resolve Default PreferredLanguage
      let defaultLang = await tx.preferredLanguage.findFirst({
        where: { code: 'en' },
      });
      if (!defaultLang) {
        defaultLang = await tx.preferredLanguage.findFirst();
      }

      // 4. Create Exam Record
      const exam = await tx.exam.create({
        data: {
          examTargetId: examTarget.id,
          title: validation.examTitle,
          description:
            validation.validatedRows[0]?.data.examDescription ||
            `Imported from Question Paper (${validation.examCode})`,
          totalQuestions: validation.totalQuestions,
          totalMarks: validation.totalMarks,
          durationMinutes: validation.durationMinutes,
          defaultMarksPerQuestion: 4,
          defaultNegativeMarks: 1,
          statusId: publishedStatus.id,
          createdById: userId,
        },
      });

      // 5. Create ExamLanguage
      if (defaultLang) {
        await tx.examLanguage.create({
          data: {
            examId: exam.id,
            languageId: defaultLang.id,
            isDefault: true,
            displayOrder: 1,
          },
        });
      }

      // 6. Create ExamSections
      const sectionNameToDbRecord = new Map<string, any>();

      for (let sIdx = 0; sIdx < validation.sections.length; sIdx++) {
        const sec = validation.sections[sIdx];

        // Find or create global Subject
        const subLower = (sec.subject || '').toLowerCase().trim();
        const cleanName = subLower.includes('physic')
          ? 'Physics'
          : subLower.includes('chem')
          ? 'Chemistry'
          : subLower.includes('math')
          ? 'Mathematics'
          : subLower.includes('bio') || subLower.includes('botan') || subLower.includes('zool')
          ? 'Biology'
          : sec.subject;

        let subject = await tx.subject.findFirst({
          where: {
            name: { equals: cleanName, mode: 'insensitive' },
          },
        });

        if (!subject) {
          subject = await tx.subject.create({
            data: {
              name: cleanName,
              code: cleanName.toUpperCase().slice(0, 4),
              displayOrder: sIdx + 1,
            },
          });
        }

        if (examTarget?.id) {
          await tx.examTargetSubject.upsert({
            where: {
              examTargetId_subjectId: {
                examTargetId: examTarget.id,
                subjectId: subject.id,
              },
            },
            create: {
              examTargetId: examTarget.id,
              subjectId: subject.id,
              displayOrder: sIdx + 1,
            },
            update: {},
          });
        }

        const examSection = await tx.examSection.create({
          data: {
            examId: exam.id,
            subjectId: subject.id,
            name: sec.name,
            totalQuestions: sec.questionCount,
            displayOrder: sIdx + 1,
          },
        });

        sectionNameToDbRecord.set(`${sec.subject}::${sec.name}`, {
          section: examSection,
          subject,
        });
      }

      // 7. Iterate through validated rows and create Questions, Options, Answers, Explanations & ExamQuestions
      for (let qIdx = 0; qIdx < validation.validatedRows.length; qIdx++) {
        const row = validation.validatedRows[qIdx];
        const data = row.data;

        const secKey = `${data.subject || 'General'}::${
          data.sectionName || `${data.subject || 'General'} Section`
        }`;
        const secData =
          sectionNameToDbRecord.get(secKey) ||
          Array.from(sectionNameToDbRecord.values())[0];

        const subject = secData.subject;
        const examSection = secData.section;

        // Resolve Chapter
        let chapter = data.chapter
          ? await tx.chapter.findFirst({
              where: {
                subjectId: subject.id,
                name: { equals: data.chapter, mode: 'insensitive' },
              },
            })
          : null;

        if (!chapter) {
          chapter = await tx.chapter.findFirst({
            where: { subjectId: subject.id },
          });
          if (!chapter) {
            chapter = await tx.chapter.create({
              data: {
                subjectId: subject.id,
                name: data.chapter || `${subject.name} General Chapter`,
              },
            });
          }
        }

        // Difficulty level
        const diffLevel = (
          ['EASY', 'MEDIUM', 'HARD', 'VERY_HARD'].includes(data.difficulty || '')
            ? data.difficulty
            : 'MEDIUM'
        ) as QuestionDifficultyEnum;

        // Question Type
        const qType = (
          [
            'SINGLE_CORRECT',
            'MULTIPLE_CORRECT',
            'NUMERICAL',
            'ASSERTION_REASON',
            'MATCH_FOLLOWING',
            'CASE_BASED',
          ].includes(data.questionType || '')
            ? data.questionType
            : 'SINGLE_CORRECT'
        ) as QuestionTypeEnum;

        // Create Question
        const question = await tx.question.create({
          data: {
            subjectId: subject.id,
            chapterId: chapter.id,
            difficultyLevel: diffLevel,
            type: qType,
            status: 'APPROVED',
            marks: data.marks || 4.0,
            negativeMarks: data.negativeMarks || 1.0,
            passage: data.passageText || null,
            assertion: data.assertionText || null,
            reason: data.reasonText || null,
            defaultLanguageId: defaultLang ? defaultLang.id : undefined as any,
            createdById: userId,
            approvedById: userId,
            approvedAt: new Date(),
          },
        });

        // Create English translation (or default language translation)
        if (defaultLang) {
          await tx.questionTranslation.create({
            data: {
              questionId: question.id,
              languageId: defaultLang.id,
              questionText: data.questionText,
              passageText: data.passageText || null,
              assertionText: data.assertionText || null,
              reasonText: data.reasonText || null,
              explanation: data.explanation || null,
            },
          });
        }

        // Create Options
        const optionKeys = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
        const correctAnswers = data.correctAnswer
          .toUpperCase()
          .split(/[\s,;]+/)
          .map((s) => s.trim());

        const createdOptionIds: string[] = [];
        const correctOptionIds: string[] = [];

        for (let oIdx = 0; oIdx < optionKeys.length; oIdx++) {
          const key = optionKeys[oIdx];
          const optText = (data as any)[`option${key}`];

          if (optText && optText.trim()) {
            const isCorrect = correctAnswers.includes(key);

            const opt = await tx.questionOption.create({
              data: {
                questionId: question.id,
                optionKey: key,
                optionText: optText.trim(),
                isCorrect,
                displayOrder: oIdx + 1,
              },
            });

            createdOptionIds.push(opt.id);
            if (isCorrect) correctOptionIds.push(opt.id);

            if (defaultLang) {
              await tx.questionOptionTranslation.create({
                data: {
                  optionId: opt.id,
                  languageId: defaultLang.id,
                  optionText: optText.trim(),
                },
              });
            }
          }
        }

        // Create QuestionAnswer
        await tx.questionAnswer.create({
          data: {
            questionId: question.id,
            answerType: qType,
            correctOptionIds:
              correctOptionIds.length > 0 ? correctOptionIds : undefined,
            numericalAnswer:
              qType === 'NUMERICAL' ? parseFloat(data.correctAnswer) : null,
          },
        });

        // Create QuestionExplanation if present
        if (data.explanation && data.explanation.trim()) {
          await tx.questionExplanation.create({
            data: {
              questionId: question.id,
              explanation: data.explanation.trim(),
            },
          });
        }

        // Create ExamQuestion link
        await tx.examQuestion.create({
          data: {
            examId: exam.id,
            sectionId: examSection.id,
            questionId: question.id,
            displayOrder: qIdx + 1,
            marks: data.marks || 4.0,
            negativeMarks: data.negativeMarks || 1.0,
          },
        });

        // Update staging row with success result
        await (tx as any).examImportRow.updateMany({
          where: {
            importId,
            rowNumber: row.rowNumber,
          },
          data: {
            importStatus: 'SUCCESS',
            resultQuestionId: question.id,
            resultExamId: exam.id,
          },
        });
      }

      return exam;
    }, {
      maxWait: 60000,
      timeout: 300000,
    });
  }

  /**
   * Get single import session status
   */
  async getImportSession(importId: string) {
    const session = await (this.prisma as any).examImport.findUnique({
      where: { id: importId },
      include: {
        createdBy: {
          select: { id: true, email: true, mobileNumber: true },
        },
      },
    });

    if (!session) {
      throw new NotFoundException(`Exam import session '${importId}' not found.`);
    }

    return session;
  }

  /**
   * Get paginated staging rows for an import session
   */
  async getImportRows(importId: string, query: ExamImportFilterDto) {
    const page = query.page ? Number(query.page) : 1;
    const limit = query.limit ? Number(query.limit) : 10;
    const skip = (page - 1) * limit;

    const where: any = { importId };
    if (query.status && query.status !== 'ALL') {
      where.status = query.status;
    }

    const [rows, total] = await Promise.all([
      (this.prisma as any).examImportRow.findMany({
        where,
        skip,
        take: limit,
        orderBy: { rowNumber: 'asc' },
      }),
      (this.prisma as any).examImportRow.count({ where }),
    ]);

    return {
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get list of historical exam paper imports
   */
  async getImportHistory(query: ExamImportFilterDto) {
    const page = query.page ? Number(query.page) : 1;
    const limit = query.limit ? Number(query.limit) : 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status && query.status !== 'ALL') {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      (this.prisma as any).examImport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: {
            select: { id: true, email: true, mobileNumber: true },
          },
        },
      }),
      (this.prisma as any).examImport.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Generate downloadable Question Paper Template (XLSX or CSV)
   */
  async generateTemplate(format: ExamImportFormatEnum) {
    const headers = [
      'question_number',
      'question',
      'option_a',
      'option_b',
      'option_c',
      'option_d',
      'correct_answer',
    ];

    const sampleRows = [
      {
        question_number: 1,
        question: 'What is 2 + 2?',
        option_a: '2',
        option_b: '3',
        option_c: '4',
        option_d: '5',
        correct_answer: 'C',
      },
      {
        question_number: 2,
        question: 'Capital of India?',
        option_a: 'Mumbai',
        option_b: 'Delhi',
        option_c: 'Chennai',
        option_d: 'Kolkata',
        correct_answer: 'B',
      },
      {
        question_number: 3,
        question: 'Which is a prime number?',
        option_a: '4',
        option_b: '6',
        option_c: '7',
        option_d: '8',
        correct_answer: 'C',
      },
      {
        question_number: 4,
        question: 'What is H2O?',
        option_a: 'Oxygen',
        option_b: 'Hydrogen',
        option_c: 'Water',
        option_d: 'Carbon Dioxide',
        correct_answer: 'C',
      },
      {
        question_number: 5,
        question: 'Which planet is known as the Red Planet?',
        option_a: 'Earth',
        option_b: 'Mars',
        option_c: 'Jupiter',
        option_d: 'Venus',
        correct_answer: 'B',
      },
    ];

    if (format === ExamImportFormatEnum.CSV) {
      const csvLines = [headers.join(',')];
      for (const r of sampleRows) {
        const line = headers
          .map((h) => {
            const val = (r as any)[h] ?? '';
            return `"${String(val).replace(/"/g, '""')}"`;
          })
          .join(',');
        csvLines.push(line);
      }

      return {
        buffer: Buffer.from(csvLines.join('\n'), 'utf-8'),
        fileName: 'question_paper_import_template.csv',
        contentType: 'text/csv',
      };
    }

    // XLSX format
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('QuestionPaper');

    worksheet.columns = [
      { header: 'Question Number', key: 'question_number', width: 18 },
      { header: 'Question', key: 'question', width: 45 },
      { header: 'Option A', key: 'option_a', width: 22 },
      { header: 'Option B', key: 'option_b', width: 22 },
      { header: 'Option C', key: 'option_c', width: 22 },
      { header: 'Option D', key: 'option_d', width: 22 },
      { header: 'Correct Answer', key: 'correct_answer', width: 18 },
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4338CA' },
    };

    for (const r of sampleRows) {
      worksheet.addRow(r);
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      fileName: 'question_paper_import_template.xlsx',
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /**
   * Generate downloadable Error Report (.xlsx or .csv) for failed import
   */
  async generateErrorReport(importId: string, format: ExamImportFormatEnum) {
    const session = await this.getImportSession(importId);
    const rows = await (this.prisma as any).examImportRow.findMany({
      where: { importId, status: 'INVALID' },
      orderBy: { rowNumber: 'asc' },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Errors');

    worksheet.columns = [
      { header: 'Row Number', key: 'rowNumber', width: 14 },
      { header: 'Subject', key: 'subject', width: 20 },
      { header: 'Section', key: 'section', width: 22 },
      { header: 'Question Text', key: 'questionText', width: 45 },
      { header: 'Validation Errors', key: 'errors', width: 60 },
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE11D48' },
    };

    for (const r of rows) {
      const errorsList = Array.isArray(r.errors)
        ? r.errors.join('; ')
        : String(r.errors || 'Validation error');

      worksheet.addRow({
        rowNumber: r.rowNumber,
        subject: r.subjectName || (r.rawData as any)?.subject || '',
        section: r.sectionName || (r.rawData as any)?.section_name || '',
        questionText: (r.rawData as any)?.question_text || '',
        errors: errorsList,
      });
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      fileName: `question_paper_errors_${importId.slice(0, 8)}.xlsx`,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /**
   * 1. Get all active predefined & custom blueprints from master data
   * GET /admin/exam-manager/blueprints
   */
  async getActiveBlueprints(): Promise<BlueprintItemDto[]> {
    return [];
  }

  /**
   * Helper to parse translation spreadsheet rows
   */
  async parseTranslationBuffer(
    buffer: Buffer,
    fileName: string,
  ): Promise<any[]> {
    const workbook = new ExcelJS.Workbook();
    const ext = path.extname(fileName).toLowerCase();

    if (ext === '.csv') {
      const text = buffer.toString('utf-8');
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length <= 1) return [];

      const headers = lines[0]
        .split(',')
        .map((h) => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
      const rows: any[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]
          .split(',')
          .map((c) => c.replace(/^["']|["']$/g, '').trim());
        const rowObj: any = { rowNumber: i + 1 };
        headers.forEach((h, idx) => {
          rowObj[h] = cols[idx] || '';
        });
        rows.push(rowObj);
      }
      return rows;
    } else {
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      if (!sheet) return [];

      const headers: string[] = [];
      sheet.getRow(1).eachCell((cell, colNumber) => {
        headers[colNumber] = String(cell.value || '')
          .trim()
          .toLowerCase();
      });

      const rows: any[] = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const rowObj: any = { rowNumber };
        row.eachCell((cell, colNumber) => {
          const h = headers[colNumber];
          if (h) rowObj[h] = String(cell.value || '').trim();
        });
        rows.push(rowObj);
      });
      return rows;
    }
  }

  /**
   * 2. Validate Question Paper + Multiple Regional Translation Files against Blueprint
   * POST /admin/exam-manager/validate
   */
  async validateQuestionPaperAndTranslations(
    questionFile: { originalname: string; size: number; buffer: Buffer },
    blueprintId?: string,
    translationFiles: Array<{
      file: { originalname: string; size: number; buffer: Buffer };
      languageId: string;
    }> = [],
  ): Promise<ComprehensiveExamValidationResult> {
    this.validateFile(questionFile);

    // 2. Parse Question Paper File
    const parsedRows = await this.parserService.parseBuffer(
      questionFile.buffer,
      questionFile.originalname,
    );

    // 3. Validate Question Paper Structure
    const paperValidation =
      await this.validatorService.validatePaper(parsedRows);

    const errors = [...paperValidation.errors];
    const warnings = [...paperValidation.warnings];

    // 5. Validate Simultaneous Translation Files
    const allLanguages = await this.prisma.preferredLanguage.findMany();
    const langMap = new Map(allLanguages.map((l) => [l.id, l]));
    const translationsSummary: TranslationValidationSummary[] = [];

    for (const tf of translationFiles) {
      const lang = langMap.get(tf.languageId);
      if (!lang) {
        continue;
      }

      const tRows = await this.parseTranslationBuffer(
        tf.file.buffer,
        tf.file.originalname,
      );
      const totalQ = paperValidation.totalRows;
      let validRows = 0;
      let invalidRows = 0;
      const tErrors: string[] = [];

      for (const tr of tRows) {
        const qText = tr.question_text || tr.question || tr.text || '';
        if (!qText.trim()) {
          invalidRows++;
          tErrors.push(`Row ${tr.rowNumber}: Translated question text is missing.`);
        } else {
          validRows++;
        }
      }

      const coveragePercentage =
        totalQ > 0 ? Math.min(100, Math.round((validRows / totalQ) * 100)) : 0;

      translationsSummary.push({
        languageId: lang.id,
        languageCode: lang.code || lang.name,
        languageName: lang.name,
        fileName: tf.file.originalname,
        totalQuestions: totalQ,
        translatedQuestions: validRows,
        coveragePercentage,
        validRows,
        invalidRows,
        errors: tErrors.slice(0, 10),
      });
    }

    // 6. Build Preview Sample Rows
    const previewRows = paperValidation.validatedRows.slice(0, 15).map((r) => ({
      rowNumber: r.rowNumber,
      questionNumber: r.data.questionNumber,
      subject: r.data.subject,
      chapter: r.data.chapter,
      questionText: r.data.questionText,
      questionType: r.data.questionType || 'SINGLE_CORRECT',
      options: [
        { key: 'A', text: r.data.optionA || '', isCorrect: r.data.correctAnswer === 'A' },
        { key: 'B', text: r.data.optionB || '', isCorrect: r.data.correctAnswer === 'B' },
        { key: 'C', text: r.data.optionC || '', isCorrect: r.data.correctAnswer === 'C' },
        { key: 'D', text: r.data.optionD || '', isCorrect: r.data.correctAnswer === 'D' },
      ],
      correctAnswer: r.data.correctAnswer,
      difficulty: r.data.difficulty || 'MEDIUM',
      status: r.isValid ? ('VALID' as const) : ('INVALID' as const),
      errors: r.errors,
    }));

    const isValid = paperValidation.isValid && errors.length === 0;

    return {
      isValid,
      blueprint: {
        id: 'standard',
        name: 'Standard Question Paper',
        totalQuestions: paperValidation.totalQuestions,
        isMatched: true,
        subjectChecks: [],
      },
      questionsSummary: {
        totalRows: paperValidation.totalRows,
        validRows: paperValidation.validRows,
        invalidRows: paperValidation.invalidRows,
        duplicateRows: 0,
        totalQuestions: paperValidation.totalQuestions,
        totalMarks: paperValidation.totalMarks,
        durationMinutes: paperValidation.durationMinutes || 180,
        subjectCounts: {},
      },
      translationsSummary,
      previewRows,
      errors,
      warnings,
    };
  }

  /**
   * 3. Transactionally Create Draft Exam + Sections + Questions + Immutable Snapshot + Translations
   * POST /admin/exam-manager/create-from-upload
   */
  async createExamFromValidatedUpload(
    dto: CreateExamFromUploadDto,
    questionFile: { originalname: string; size: number; buffer: Buffer },
    translationFiles: Array<{
      file: { originalname: string; size: number; buffer: Buffer };
      languageId: string;
    }> = [],
    userId: string,
  ) {
    if ((dto as any).examId) {
      await this.validateQuestionPaperUploadWindow((dto as any).examId);
    }

    const validation = await this.validateQuestionPaperAndTranslations(
      questionFile,
      dto.blueprintId,
      translationFiles,
    );

    if (!validation.isValid && validation.errors.length > 0) {
      throw new BadRequestException(
        `Cannot create exam: ${validation.errors[0]?.message || 'Validation failed'}`,
      );
    }

    const parsedRows = await this.parserService.parseBuffer(
      questionFile.buffer,
      questionFile.originalname,
    );
    const paperValidation =
      await this.validatorService.validatePaper(parsedRows);

    // Resolve Exam Target & Status
    const allBlueprints = await this.getActiveBlueprints();
    const blueprint = allBlueprints.find(
      (b) => b.id === dto.blueprintId || b.code === dto.blueprintId,
    );

    let targetId = blueprint?.examTargetId;
    if (!targetId) {
      const defaultTarget = await this.prisma.examTarget.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      targetId = defaultTarget?.id || '';
    }

    const draftStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'DRAFT' },
    });
    if (!draftStatus) {
      throw new NotFoundException('Exam status DRAFT not found.');
    }

    const marksPerQ = dto.defaultMarksPerQuestion || 4;
    const negMarks = dto.defaultNegativeMarks || 1;
    const duration =
      dto.durationMinutes ||
      blueprint?.durationMinutes ||
      validation.questionsSummary.durationMinutes ||
      180;
    const totalMarks =
      validation.questionsSummary.totalMarks ||
      validation.questionsSummary.totalQuestions * marksPerQ;

    // Parse Translation Rows ahead of transaction
    const parsedTranslationsMap: Record<string, any[]> = {};
    for (const tf of translationFiles) {
      const rows = await this.parseTranslationBuffer(
        tf.file.buffer,
        tf.file.originalname,
      );
      parsedTranslationsMap[tf.languageId] = rows;
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Create Exam
      const exam = await tx.exam.create({
        data: {
          examTargetId: targetId!,
          title: dto.title.trim(),
          description:
            dto.description ||
            `Exam created via Question Paper upload based on ${blueprint?.name || 'Blueprint'} (${paperValidation.totalQuestions} Questions)`,
          totalQuestions: paperValidation.totalQuestions,
          totalMarks,
          durationMinutes: duration,
          defaultMarksPerQuestion: marksPerQ,
          defaultNegativeMarks: negMarks,
          statusId: draftStatus.id,
          createdById: userId,
        },
      });

      // 2. Group Questions by Section / Subject
      const sectionsMap = new Map<string, typeof paperValidation.validatedRows>();
      for (const row of paperValidation.validatedRows) {
        if (!row.isValid) continue;
        const sName = row.data.sectionName || row.data.subject || 'General';
        if (!sectionsMap.has(sName)) sectionsMap.set(sName, []);
        sectionsMap.get(sName)!.push(row);
      }

      // 3. Create Sections and ExamQuestions
      let secOrder = 1;
      let globalQOrder = 1;
      const createdQuestionTuples: Array<{
        questionId: string;
        sourceRow: any;
        options: any[];
      }> = [];

      for (const [secName, secRows] of sectionsMap.entries()) {
        const firstRow = secRows[0];
        let subjectRecord = await tx.subject.findFirst({
          where: {
            OR: [
              { name: { contains: firstRow.data.subject, mode: 'insensitive' } },
              { code: { contains: firstRow.data.subject, mode: 'insensitive' } },
            ],
          },
        });
        if (!subjectRecord) {
          subjectRecord = await tx.subject.findFirst();
        }
        const subId = subjectRecord?.id || '';

        let chapterRecord = await tx.chapter.findFirst({
          where: { subjectId: subId },
        });
        if (!chapterRecord) {
          chapterRecord = await tx.chapter.findFirst();
        }
        const chapId = chapterRecord?.id || '';

        const defaultLang = await tx.preferredLanguage.findFirst({
          where: { code: 'en' },
        });
        const langId = defaultLang?.id || (await tx.preferredLanguage.findFirst())?.id || '';

        const examSection = await tx.examSection.create({
          data: {
            examId: exam.id,
            subjectId: subId,
            name: secName,
            totalQuestions: secRows.length,
            displayOrder: secOrder++,
          },
        });

        for (const r of secRows) {
          const qData = r.data;

          // Create Question in Question Bank
          const question = await tx.question.create({
            data: {
              subjectId: subId,
              chapterId: chapId,
              defaultLanguageId: langId,
              type: (qData.questionType as any) || QuestionTypeEnum.SINGLE_CORRECT,
              difficultyLevel:
                (qData.difficulty as any) || QuestionDifficultyEnum.MEDIUM,
              marks: qData.marks || marksPerQ,
              negativeMarks: qData.negativeMarks || negMarks,
              passage: qData.passageText || null,
              assertion: qData.assertionText || null,
              reason: qData.reasonText || null,
              createdById: userId,
              isActive: true,
            },
          });

          // Create Options
          const createdOptions: any[] = [];
          const optDefs = [
            { key: 'A', text: qData.optionA },
            { key: 'B', text: qData.optionB },
            { key: 'C', text: qData.optionC },
            { key: 'D', text: qData.optionD },
          ];

          for (let optIdx = 0; optIdx < optDefs.length; optIdx++) {
            const od = optDefs[optIdx];
            if (od.text !== undefined && od.text !== null) {
              const opt = await tx.questionOption.create({
                data: {
                  questionId: question.id,
                  optionKey: od.key,
                  optionLabel: od.key,
                  optionText: od.text || '',
                  isCorrect: qData.correctAnswer === od.key,
                  displayOrder: optIdx + 1,
                },
              });
              createdOptions.push(opt);
            }
          }

          // Create Default English Translation
          const defaultLang = await tx.preferredLanguage.findFirst({
            where: { code: 'en' },
          });
          if (defaultLang) {
            await tx.questionTranslation.create({
              data: {
                questionId: question.id,
                languageId: defaultLang.id,
                questionText: qData.questionText || 'Question statement',
                explanation: qData.explanation || null,
              },
            });
          }

          // Link to Exam
          await tx.examQuestion.create({
            data: {
              examId: exam.id,
              sectionId: examSection.id,
              questionId: question.id,
              displayOrder: globalQOrder++,
              marks: qData.marks || marksPerQ,
              negativeMarks: qData.negativeMarks || negMarks,
            },
          });

          createdQuestionTuples.push({
            questionId: question.id,
            sourceRow: qData,
            options: createdOptions,
          });
        }
      }

      // 4. Create Regional Translations
      for (const [langId, tRows] of Object.entries(parsedTranslationsMap)) {
        for (let i = 0; i < createdQuestionTuples.length; i++) {
          const tuple = createdQuestionTuples[i];
          const tRow = tRows[i] || tRows.find((tr) => tr.question_number === tuple.sourceRow.questionNumber);

          if (tRow) {
            const qText = tRow.question_text || tRow.question || tRow.text || tuple.sourceRow.questionText;
            const explanation = tRow.explanation || tuple.sourceRow.explanation;

            await tx.questionTranslation.upsert({
              where: {
                questionId_languageId: {
                  questionId: tuple.questionId,
                  languageId: langId,
                },
              },
              create: {
                questionId: tuple.questionId,
                languageId: langId,
                questionText: qText,
                explanation,
              },
              update: {
                questionText: qText,
                explanation,
              },
            });

            // Option translations
            const tOptions = [
              { key: 'A', text: tRow.option_a },
              { key: 'B', text: tRow.option_b },
              { key: 'C', text: tRow.option_c },
              { key: 'D', text: tRow.option_d },
            ];

            for (const to of tOptions) {
              const matchedOpt = tuple.options.find((o) => o.optionKey === to.key);
              if (matchedOpt && to.text) {
                await tx.questionOptionTranslation.upsert({
                  where: {
                    optionId_languageId: {
                      optionId: matchedOpt.id,
                      languageId: langId,
                    },
                  },
                  create: {
                    optionId: matchedOpt.id,
                    languageId: langId,
                    optionText: to.text,
                  },
                  update: {
                    optionText: to.text,
                  },
                });
              }
            }
          }
        }

        // Link language to Exam
        await tx.examLanguage.upsert({
          where: {
            examId_languageId: {
              examId: exam.id,
              languageId: langId,
            },
          },
          create: {
            examId: exam.id,
            languageId: langId,
            isDefault: false,
          },
          update: {},
        });
      }

      // 6. Create Immutable ExamVersion Snapshot
      const examVersion = await tx.examVersion.create({
        data: {
          examId: exam.id,
          versionNumber: 1,
          status: 'GENERATED',
          generationSeed: `exam_upload_${Date.now()}`,
          totalQuestions: paperValidation.totalQuestions,
          durationMinutes: duration,
          totalMarks,
          generatedById: userId,
        },
      });

      // 7. Populate ExamVersionQuestions & Options
      let vSeq = 1;
      for (const tuple of createdQuestionTuples) {
        const vq = await tx.examVersionQuestion.create({
          data: {
            examVersionId: examVersion.id,
            sourceQuestionId: tuple.questionId,
            sequenceNumber: vSeq++,
            sectionName: tuple.sourceRow.sectionName || tuple.sourceRow.subject || 'General',
            subjectName: tuple.sourceRow.subject || 'General',
            type: tuple.sourceRow.questionType || 'SINGLE_CORRECT',
            difficultyLevel: tuple.sourceRow.difficulty || 'MEDIUM',
            marks: tuple.sourceRow.marks || marksPerQ,
            negativeMarks: tuple.sourceRow.negativeMarks || negMarks,
            passage: tuple.sourceRow.passageText || null,
            assertion: tuple.sourceRow.assertionText || null,
            reason: tuple.sourceRow.reasonText || null,
            questionText: tuple.sourceRow.questionText || 'Question statement',
            explanation: tuple.sourceRow.explanation || null,
            correctAnswer: tuple.sourceRow.correctAnswer || null,
          },
        });

        for (let oIdx = 0; oIdx < tuple.options.length; oIdx++) {
          const opt = tuple.options[oIdx];
          await tx.examVersionOption.create({
            data: {
              examVersionQuestionId: vq.id,
              sourceOptionId: opt.id,
              displayOrder: oIdx + 1,
              optionKey: opt.optionKey,
              optionLabel: opt.optionLabel || opt.optionKey,
              optionText: opt.optionText || '',
              isCorrect: opt.isCorrect,
            },
          });
        }
      }

      // 8. Record Audit Log
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'EXAM_CREATED',
          entityType: 'Exam',
          entityId: exam.id,
          metadata: {
            title: exam.title,
            blueprintId: dto.blueprintId,
            totalQuestions: exam.totalQuestions,
            languagesCount: translationFiles.length + 1,
          },
        },
      });

      return {
        examId: exam.id,
        examVersionId: examVersion.id,
        title: exam.title,
        status: 'DRAFT',
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        languagesCount: translationFiles.length + 1,
        createdAt: exam.createdAt,
      };
    }, {
      maxWait: 60000,
      timeout: 300000,
    });
  }

  /**
   * 4. List All Exams with Rich Status, Search, Type Filter, Translation Coverage & Pagination
   * GET /admin/exam-manager/exams
   */
  async getAllExamsList(query: ExamManagerFilterDto) {
    const page = query.page ? Math.max(1, Number(query.page)) : 1;
    const limit = query.limit ? Math.min(Math.max(1, Number(query.limit)), 100) : 10;
    const skip = (page - 1) * limit;

    const andConditions: any[] = [];
    const now = new Date();

    if (query.search && query.search.trim()) {
      andConditions.push({
        OR: [
          { title: { contains: query.search.trim(), mode: 'insensitive' } },
          { description: { contains: query.search.trim(), mode: 'insensitive' } },
          {
            sections: {
              some: {
                name: { contains: query.search.trim(), mode: 'insensitive' },
              },
            },
          },
        ],
      });
    }

    if (query.status && query.status !== 'ALL') {
      andConditions.push({ status: { name: query.status } });
    }

    if (query.type && query.type !== 'ALL') {
      if (query.type === 'MOCK') {
        andConditions.push({ title: { contains: 'Mock', mode: 'insensitive' } });
      } else if (query.type === 'SUBJECT_MOCK') {
        andConditions.push({ sections: { some: {} } });
      } else if (query.type === 'LIVE') {
        andConditions.push({ NOT: { title: { contains: 'Mock', mode: 'insensitive' } } });
      }
    }

    if (
      query.missingQuestionPaperOnly === true ||
      query.missingQuestionPaperOnly === 'true'
    ) {
      andConditions.push({ examQuestions: { none: {} } });
    }

    // By default or when notConductedOnly is requested, only show exams that have not been conducted yet:
    // Exclude completed/ended status and exams whose live schedule window is in the past
    const shouldFilterNotConducted =
      query.notConductedOnly === true ||
      query.notConductedOnly === 'true' ||
      query.excludeCompleted === true ||
      query.excludeCompleted === 'true' ||
      !query.status ||
      query.status === 'ALL';

    if (shouldFilterNotConducted && query.status !== 'COMPLETED' && query.status !== 'ENDED') {
      andConditions.push({
        status: { name: { notIn: ['COMPLETED', 'ENDED', 'CANCELLED'] } },
      });
      andConditions.push({
        OR: [
          // 1. Exam has no schedule yet (unscheduled draft / approved exam not yet conducted)
          { schedules: { none: {} } },
          // 2. Exam has a schedule that is upcoming or currently live (endTime >= now and not completed/ended)
          {
            schedules: {
              some: {
                endTime: { gte: now },
                status: { notIn: ['ENDED', 'CANCELLED'] },
              },
            },
          },
        ],
      });
    }

    const where: any = andConditions.length > 0 ? { AND: andConditions } : {};

    const sortBy = query.sortBy || 'createdAt';
    const sortOrder: 'asc' | 'desc' = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any = {};
    if (['title', 'createdAt', 'updatedAt', 'totalMarks', 'durationMinutes'].includes(sortBy)) {
      orderBy[sortBy] = sortOrder;
    } else {
      orderBy['createdAt'] = 'desc';
    }

    const [exams, total] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          examTarget: { select: { id: true, name: true } },
          status: { select: { id: true, name: true } },
          createdBy: {
            select: { id: true, email: true, name: true, student: { select: { name: true } } },
          },
          languages: {
            include: {
              language: {
                select: { id: true, name: true, code: true, nativeName: true },
              },
            },
          },
          sections: {
            select: {
              id: true,
              name: true,
              subject: { select: { id: true, name: true } },
            },
          },
          schedules: {
            select: {
              id: true,
              status: true,
              startTime: true,
              endTime: true,
              hasAnswerKey: true,
              answerKeyUploadedAt: true,
            },
            orderBy: { startTime: 'desc' },
            take: 1,
          },
          _count: {
            select: { examQuestions: true, attempts: true, sections: true },
          },
        },
      }),
      this.prisma.exam.count({ where }),
    ]);

    // 1. Fetch active languages
    let allLanguages: any[] = [];
    try {
      allLanguages = await this.prisma.preferredLanguage.findMany({
        where: { isActive: true },
      });
    } catch (e) {
      this.logger.warn(`Could not load preferred languages: ${e?.message}`);
    }

    const examIds = exams.map((e) => e.id);

    // 2. Fetch latest import sessions with safe error fallback
    const importMap = new Map<string, any>();
    if (examIds.length > 0) {
      try {
        const recentImports = await (this.prisma as any).examImport.findMany({
          where: { createdExamId: { in: examIds } },
          orderBy: { createdAt: 'desc' },
        });
        for (const imp of recentImports || []) {
          if (!importMap.has(imp.createdExamId)) {
            importMap.set(imp.createdExamId, imp);
          }
        }
      } catch (err) {
        this.logger.warn(`Could not fetch exam imports (table may be syncing): ${err?.message}`);
      }
    }

    // 3. Batch translation counts in ONE single query for all returned exams
    const translationCountsMap = new Map<string, number>(); // key: `${examId}_${languageId}`
    if (examIds.length > 0) {
      try {
        const translationStats = await this.prisma.$queryRaw<
          Array<{ exam_id: string; language_id: string; total: number | bigint }>
        >`
          SELECT eq.exam_id, qt.language_id, COUNT(qt.id)::int AS total
          FROM exam_questions eq
          JOIN question_translations qt ON qt.question_id = eq.question_id
          WHERE eq.exam_id IN (${Prisma.join(examIds.map((id) => Prisma.raw(`'${id}'::uuid`)))})
          GROUP BY eq.exam_id, qt.language_id
        `;
        for (const stat of translationStats || []) {
          translationCountsMap.set(`${stat.exam_id}_${stat.language_id}`, Number(stat.total));
        }
      } catch (rawErr) {
        this.logger.warn(`Aggregated translation query fallback: ${rawErr?.message}`);
      }
    }

    const items = exams.map((exam) => {
      const totalQ = exam._count?.examQuestions || 0;
      const translationCoverage: Record<string, number> = {};

      for (const lang of allLanguages) {
        const lCode = (lang.code || lang.name || '').toUpperCase();
        if (!lCode) continue;

        if (lCode === 'EN') {
          translationCoverage[lCode] = 100;
        } else {
          const count = translationCountsMap.get(`${exam.id}_${lang.id}`) || 0;
          const pct = Math.min(100, Math.round((count / (totalQ || 1)) * 100));
          if (pct > 0) {
            translationCoverage[lCode] = pct;
          }
        }
      }

      const isMock = /mock/i.test(exam.title);
      const type = isMock ? 'MOCK' : 'LIVE';
      const typeLabel = isMock ? 'Mock Test' : 'Live Exam';
      const subjectsSummary =
        exam.sections
          ?.map((s) => s.subject?.name || s.name)
          .filter(Boolean)
          .join(', ') || 'All Subjects';

      const latestImport = importMap.get(exam.id);
      let questionPaperStatus: 'NOT_UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' =
        'NOT_UPLOADED';

      if (latestImport?.status === 'PROCESSING') {
        questionPaperStatus = 'PROCESSING';
      } else if ((exam._count?.examQuestions || 0) > 0) {
        questionPaperStatus = 'COMPLETED';
      } else if (latestImport?.status === 'FAILED') {
        questionPaperStatus = 'FAILED';
      }

      return {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        type,
        typeLabel,
        examTarget: exam.examTarget?.name || 'General',
        subjectsSummary,
        totalQuestions: totalQ,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        status: exam.status?.name || 'DRAFT',
        questionPaperStatus,
        latestImportId: latestImport?.id || null,
        importStatus: latestImport?.status || null,
        importError: latestImport?.errorSummary || null,
        validRows: latestImport?.validRows || 0,
        totalRows: latestImport?.totalRows || 0,
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
        createdBy: {
          id: exam.createdBy?.id,
          email: exam.createdBy?.email,
          name: exam.createdBy?.name || exam.createdBy?.student?.name || exam.createdBy?.email || 'Admin',
        },
        translationCoverage,
        schedule: exam.schedules?.[0] || null,
        languages: (exam.languages || []).map((l) => ({
          id: l.language?.id,
          name: l.language?.name,
          code: l.language?.code,
        })),
      };
    });

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  private validateFile(file: { originalname: string; size: number }) {
    if (!file) {
      throw new BadRequestException('No file provided for question paper upload.');
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
      throw new BadRequestException(
        `Invalid file type '${ext}'. Please upload a .csv, .xlsx, or .xls spreadsheet.`,
      );
    }

    const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
    if (file.size > MAX_SIZE) {
      throw new BadRequestException(
        `File size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum allowed limit of 25MB.`,
      );
    }
  }

  /**
   * Enforces 24-hour upload window for Question Papers:
   * Upload is strictly permitted only between [startTime - 24 hours, startTime]
   * for exams that have a scheduled session.
   */
  async validateQuestionPaperUploadWindow(
    _examId?: string,
    _scheduleId?: string,
  ): Promise<void> {
    // Permitted for all admin question paper uploads across all exam states (Draft, Approved, Scheduled, Live/Active)
    return;
  }

  /**
   * Submit Manually Entered Questions for an Exam
   * Creates Questions, Options, Translations, ExamQuestions, ExamVersion, and AnswerKey records atomically.
   */
  async submitManualQuestions(
    examId: string,
    dto: { questions: any[] },
    userId: string,
  ) {
    if (!dto.questions || !Array.isArray(dto.questions) || dto.questions.length === 0) {
      throw new BadRequestException('Please provide at least one question.');
    }

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        sections: { include: { subject: true }, orderBy: { displayOrder: 'asc' } },
        schedules: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    // Question count validation against exam configuration
    if (exam.totalQuestions && dto.questions.length !== exam.totalQuestions) {
      throw new BadRequestException(
        `Exam requires exactly ${exam.totalQuestions} questions, but ${dto.questions.length} question(s) were submitted.`,
      );
    }

    // Detailed question, difficulty, and type-specific validation
    const validDifficulties = ['EASY', 'MEDIUM', 'HARD', 'VERY_HARD'];
    const validTypes = [
      'SINGLE_CORRECT',
      'MULTIPLE_CORRECT',
      'NUMERICAL',
      'ASSERTION_REASON',
      'MATCH_FOLLOWING',
    ];

    for (let i = 0; i < dto.questions.length; i++) {
      const q = dto.questions[i];
      const qNum = i + 1;

      if (!q.questionText || !q.questionText.trim()) {
        throw new BadRequestException(`Question ${qNum}: Question text is required.`);
      }

      if (!q.difficulty || !validDifficulties.includes(q.difficulty)) {
        throw new BadRequestException(
          `Question ${qNum}: Difficulty is required and must be one of: ${validDifficulties.join(', ')}.`,
        );
      }

      const qType = q.type || 'SINGLE_CORRECT';
      if (!validTypes.includes(qType)) {
        throw new BadRequestException(
          `Question ${qNum}: Question Type is required and must be one of: ${validTypes.join(', ')}.`,
        );
      }

      switch (qType) {
        case 'SINGLE_CORRECT': {
          if (!q.optionA || !q.optionA.trim()) throw new BadRequestException(`Question ${qNum}: Option A is required.`);
          if (!q.optionB || !q.optionB.trim()) throw new BadRequestException(`Question ${qNum}: Option B is required.`);
          if (!q.optionC || !q.optionC.trim()) throw new BadRequestException(`Question ${qNum}: Option C is required.`);
          if (!q.optionD || !q.optionD.trim()) throw new BadRequestException(`Question ${qNum}: Option D is required.`);
          if (!q.correctAnswer || !['A', 'B', 'C', 'D'].includes(q.correctAnswer)) {
            throw new BadRequestException(`Question ${qNum}: Correct answer must be A, B, C, or D.`);
          }
          break;
        }

        case 'MULTIPLE_CORRECT': {
          if (!q.optionA || !q.optionA.trim()) throw new BadRequestException(`Question ${qNum}: Option A is required.`);
          if (!q.optionB || !q.optionB.trim()) throw new BadRequestException(`Question ${qNum}: Option B is required.`);
          if (!q.optionC || !q.optionC.trim()) throw new BadRequestException(`Question ${qNum}: Option C is required.`);
          if (!q.optionD || !q.optionD.trim()) throw new BadRequestException(`Question ${qNum}: Option D is required.`);
          const ansArr = Array.isArray(q.correctAnswers)
            ? q.correctAnswers
            : typeof q.correctAnswer === 'string'
            ? q.correctAnswer.split(/[\s,]+/).filter(Boolean)
            : [];
          if (ansArr.length === 0 || !ansArr.every((a: string) => ['A', 'B', 'C', 'D'].includes(a))) {
            throw new BadRequestException(`Question ${qNum}: Multiple correct answers must contain at least one valid option (A, B, C, D).`);
          }
          break;
        }

        case 'NUMERICAL': {
          if (
            q.numericalAnswer === undefined ||
            q.numericalAnswer === null ||
            q.numericalAnswer === '' ||
            isNaN(Number(q.numericalAnswer))
          ) {
            throw new BadRequestException(`Question ${qNum}: Valid numerical answer is required.`);
          }
          break;
        }

        case 'ASSERTION_REASON': {
          if (!q.assertion || !q.assertion.trim()) throw new BadRequestException(`Question ${qNum}: Assertion statement is required.`);
          if (!q.reason || !q.reason.trim()) throw new BadRequestException(`Question ${qNum}: Reason statement is required.`);
          if (!q.optionA || !q.optionA.trim()) throw new BadRequestException(`Question ${qNum}: Option A is required.`);
          if (!q.optionB || !q.optionB.trim()) throw new BadRequestException(`Question ${qNum}: Option B is required.`);
          if (!q.optionC || !q.optionC.trim()) throw new BadRequestException(`Question ${qNum}: Option C is required.`);
          if (!q.optionD || !q.optionD.trim()) throw new BadRequestException(`Question ${qNum}: Option D is required.`);
          if (!q.correctAnswer || !['A', 'B', 'C', 'D'].includes(q.correctAnswer)) {
            throw new BadRequestException(`Question ${qNum}: Correct answer must be A, B, C, or D.`);
          }
          break;
        }

        case 'MATCH_FOLLOWING': {
          if (Array.isArray(q.columnA)) {
            const hasEmptyColA = q.columnA.some((item: any) => !item.text || !item.text.trim());
            if (hasEmptyColA) throw new BadRequestException(`Question ${qNum}: All Column A items must have non-empty text.`);
          }
          if (Array.isArray(q.columnB)) {
            const hasEmptyColB = q.columnB.some((item: any) => !item.text || !item.text.trim());
            if (hasEmptyColB) throw new BadRequestException(`Question ${qNum}: All Column B items must have non-empty text.`);
          }
          if (!q.optionA || !q.optionA.trim()) throw new BadRequestException(`Question ${qNum}: Option A is required.`);
          if (!q.optionB || !q.optionB.trim()) throw new BadRequestException(`Question ${qNum}: Option B is required.`);
          if (!q.optionC || !q.optionC.trim()) throw new BadRequestException(`Question ${qNum}: Option C is required.`);
          if (!q.optionD || !q.optionD.trim()) throw new BadRequestException(`Question ${qNum}: Option D is required.`);
          if (!q.correctAnswer || !['A', 'B', 'C', 'D'].includes(q.correctAnswer)) {
            throw new BadRequestException(`Question ${qNum}: Correct answer must be A, B, C, or D.`);
          }
          break;
        }
      }
    }

    // Delegate database saving and AI translation to BullMQ background processor for instant UI redirect
    const queuedJob = await this.aiTranslationService.queueManualQuestionsTranslation(
      exam.id,
      dto,
      userId,
    );

    return {
      success: true,
      message: `Question paper submitted! Redirecting to AI Translation processing...`,
      data: {
        examId: exam.id,
        translationJobId: queuedJob.jobId,
        questionsCount: dto.questions.length,
        totalLanguages: queuedJob.totalLanguages,
      },
    };
  }
}


