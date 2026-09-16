import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateExamDto,
  UpdateExamDto,
  GenerateExamQuestionsDto,
  AddExamQuestionsDto,
  ExamFilterDto,
} from './dto/exam.dto';
import {
  ValidateExamGenerationFiltersDto,
  PreviewExamGenerationFiltersDto,
  FinalizeExamGenerationFiltersDto,
  ExamSectionFilterDto,
  CreateExamFromImportDto,
} from './dto/generate-exam-filters.dto';
import { QuestionDifficultyEnum, QuestionTypeEnum } from '@prisma/client';

// Seed-based PRNG using 32-bit MurmurHash3 finalizer for 100% deterministic shuffling
function createSeedPrng(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function shuffleArraySeed<T>(array: T[], seedStr: string): T[] {
  const prng = createSeedPrng(seedStr);
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

@Injectable()
export class ExamService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Create a new exam with sections (starts in DRAFT status)
   */
  async createExam(dto: CreateExamDto, createdById: string) {
    const draftStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'DRAFT' },
    });
    if (!draftStatus)
      throw new BadRequestException('Exam status DRAFT not found. Run seeds.');

    return this.prisma.$transaction(async (tx) => {
      const exam = await tx.exam.create({
        data: {
          examTargetId: dto.examTargetId,
          title: dto.title,
          description: dto.description,
          totalQuestions: dto.totalQuestions,
          totalMarks: dto.totalMarks,
          durationMinutes: dto.durationMinutes,
          defaultMarksPerQuestion: dto.defaultMarksPerQuestion ?? 4,
          defaultNegativeMarks: dto.defaultNegativeMarks ?? 1,
          statusId: draftStatus.id,
          examDate: dto.examDate ? new Date(dto.examDate) : null,
          startTime: dto.startTime ? new Date(dto.startTime) : null,
          endTime: dto.endTime ? new Date(dto.endTime) : null,
          createdById,
        },
      });

      // Create sections
      if (dto.sections?.length) {
        for (let i = 0; i < dto.sections.length; i++) {
          const section = dto.sections[i];
          await tx.examSection.create({
            data: {
              examId: exam.id,
              subjectId: section.subjectId,
              name: section.name,
              totalQuestions: section.totalQuestions,
              displayOrder: section.displayOrder ?? i + 1,
            },
          });
        }
      }

      return this.loadExam(tx, exam.id);
    });
  }

  /**
   * Auto-generate questions for an exam based on its sections
   * Picks random active questions from the question bank for each subject
   */
  async generateExamQuestions(dto: GenerateExamQuestionsDto) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: dto.examId },
      include: {
        status: true,
        sections: { orderBy: { displayOrder: 'asc' } },
        examQuestions: true,
      },
    });

    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'DRAFT') {
      throw new BadRequestException(
        'Can only generate questions for DRAFT exams',
      );
    }

    // Remove existing questions if re-generating
    if (exam.examQuestions.length > 0) {
      await this.prisma.examQuestion.deleteMany({ where: { examId: exam.id } });
    }

    return this.prisma.$transaction(async (tx) => {
      let globalOrder = 1;

      for (const section of exam.sections) {
        // Get random questions for this subject
        const questions = await tx.question.findMany({
          where: {
            subjectId: section.subjectId,
            isActive: true,
          },
          select: { id: true },
        });

        if (questions.length < section.totalQuestions) {
          throw new BadRequestException(
            `Not enough questions for section "${section.name}". ` +
              `Need ${section.totalQuestions}, available ${questions.length}.`,
          );
        }

        // Shuffle and pick required count
        const shuffled = questions.sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, section.totalQuestions);

        // Create exam questions
        for (const q of selected) {
          await tx.examQuestion.create({
            data: {
              examId: exam.id,
              sectionId: section.id,
              questionId: q.id,
              displayOrder: globalOrder++,
              marks: exam.defaultMarksPerQuestion,
              negativeMarks: exam.defaultNegativeMarks,
            },
          });
        }
      }

      return this.loadExam(tx, exam.id);
    });
  }

  /**
   * Manually add specific questions to an exam section
   */
  async addExamQuestions(dto: AddExamQuestionsDto) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: dto.examId },
      include: { status: true, examQuestions: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'DRAFT') {
      throw new BadRequestException('Can only add questions to DRAFT exams');
    }

    const maxOrder = exam.examQuestions.reduce(
      (max, eq) => Math.max(max, eq.displayOrder),
      0,
    );

    let order = maxOrder + 1;
    for (const questionId of dto.questionIds) {
      // Skip if already added
      const exists = exam.examQuestions.find(
        (eq) => eq.questionId === questionId,
      );
      if (exists) continue;

      await this.prisma.examQuestion.create({
        data: {
          examId: dto.examId,
          sectionId: dto.sectionId,
          questionId,
          displayOrder: order++,
          marks: exam.defaultMarksPerQuestion,
          negativeMarks: exam.defaultNegativeMarks,
        },
      });
    }

    return this.findExamById(dto.examId);
  }

  /**
   * List exams with filters and pagination
   */
  async findExams(filter: ExamFilterDto) {
    const page = filter?.page ? Number(filter.page) : 1;
    const limit = filter?.limit ? Number(filter.limit) : 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filter.examTargetId) where.examTargetId = filter.examTargetId;
    if (filter.status) {
      where.status = { name: filter.status };
    }
    if (filter.search) {
      where.title = { contains: filter.search, mode: 'insensitive' };
    }

    const [exams, total] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          examTarget: { select: { id: true, name: true } },
          status: { select: { id: true, name: true } },
          createdBy: { select: { id: true, email: true } },
          schedules: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              examVersion: { select: { id: true, versionNumber: true } },
            },
          },
          _count: {
            select: { examQuestions: true, attempts: true, sections: true },
          },
        },
      }),
      this.prisma.exam.count({ where }),
    ]);

    return {
      data: exams,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single exam with all details
   */
  async findExamById(id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: {
        examTarget: { select: { id: true, name: true } },
        status: { select: { id: true, name: true } },
        createdBy: { select: { id: true, email: true } },
        approvedBy: { select: { id: true, email: true } },
        sections: {
          orderBy: { displayOrder: 'asc' },
          include: {
            subject: { select: { id: true, name: true } },
            _count: { select: { examQuestions: true } },
          },
        },
        _count: { select: { examQuestions: true, attempts: true } },
      },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  /**
   * Get comprehensive Exam details for student view with dynamic access evaluation
   */
  async getExamDetails(id: string, userId?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: {
        examTarget: { select: { id: true, name: true, description: true } },
        status: { select: { id: true, name: true } },
        createdBy: { select: { id: true, email: true } },
        languages: {
          include: {
            language: {
              select: { id: true, name: true, code: true, nativeName: true },
            },
          },
        },
        schedules: {
          where: { status: { in: ['ACTIVE', 'SCHEDULED', 'RESCHEDULED', 'ENDED'] } },
          orderBy: [{ updatedAt: 'desc' }, { startTime: 'desc' }],
          take: 1,
        },
        sections: {
          orderBy: { displayOrder: 'asc' },
          include: {
            subject: { select: { id: true, name: true } },
            _count: { select: { examQuestions: true } },
          },
        },
        _count: { select: { examQuestions: true, attempts: true } },
      },
    });

    if (!exam) throw new NotFoundException(`Exam with ID '${id}' not found`);

    const serverNow = new Date();
    const activeSchedule = exam.schedules?.[0];
    const startTime = activeSchedule?.startTime || exam.startTime || exam.examDate;
    const endTime = activeSchedule?.endTime || exam.endTime;

    let accessStatus = 'AVAILABLE';
    let canStart = true;
    let message = 'Exam is available to attempt.';
    let waitSeconds = 0;
    let existingAttempt: any = null;

    if (userId) {
      const student = await this.prisma.student.findUnique({
        where: { userId },
      });

      if (student) {
        // Check for existing attempt
        const attempt = await this.prisma.attempt.findFirst({
          where: {
            examId: id,
            studentId: student.id,
          },
          orderBy: { createdAt: 'desc' },
          include: {
            status: true,
            result: { select: { id: true, totalScore: true, percentage: true } },
          },
        });

        if (attempt) {
          existingAttempt = {
            id: attempt.id,
            status: attempt.status?.name || 'SUBMITTED',
            createdAt: attempt.createdAt,
            submittedAt: attempt.submittedAt,
            resultId: attempt.result?.id || null,
          };

          const attemptStatusName = attempt.status?.name;
          if (attemptStatusName === 'SUBMITTED' || attemptStatusName === 'EVALUATED' || attemptStatusName === 'COMPLETED') {
            accessStatus = 'ALREADY_ATTEMPTED';
            canStart = false;
            message = 'You have already attempted and submitted this exam.';
          } else if (attemptStatusName === 'IN_PROGRESS') {
            accessStatus = 'IN_PROGRESS';
            canStart = true;
            message = 'You have an active ongoing attempt for this exam.';
          }
        }
      }
    }

    if (accessStatus !== 'ALREADY_ATTEMPTED' && accessStatus !== 'IN_PROGRESS') {
      const statusName = exam.status?.name;

      if (statusName === 'CANCELLED') {
        accessStatus = 'CANCELLED';
        canStart = false;
        message = 'This examination has been cancelled by administration.';
      } else if (statusName === 'DRAFT') {
        accessStatus = 'CANCELLED';
        canStart = false;
        message = 'This examination is currently in draft preparation.';
      } else if (startTime && serverNow.getTime() < new Date(startTime).getTime()) {
        accessStatus = 'NOT_YET_STARTED';
        canStart = false;
        waitSeconds = Math.ceil((new Date(startTime).getTime() - serverNow.getTime()) / 1000);
        message = `Examination starts in ${Math.floor(waitSeconds / 3600)}h ${Math.floor((waitSeconds % 3600) / 60)}m.`;
      } else if (endTime && serverNow.getTime() >= new Date(endTime).getTime()) {
        accessStatus = 'ENDED';
        canStart = false;
        message = 'Examination window has closed.';
      }
    }

    return {
      exam: {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        defaultMarksPerQuestion: exam.defaultMarksPerQuestion,
        defaultNegativeMarks: exam.defaultNegativeMarks,
        examTarget: exam.examTarget,
        status: exam.status,
        languages: exam.languages.map((l) => l.language || l),
        sections: exam.sections.map((s) => ({
          id: s.id,
          name: s.name,
          displayOrder: s.displayOrder,
          totalQuestions: s.totalQuestions || s._count?.examQuestions || 0,
          marksPerQuestion: exam.defaultMarksPerQuestion,
          negativeMarks: exam.defaultNegativeMarks,
          subject: s.subject,
        })),
        schedule: activeSchedule
          ? {
              id: activeSchedule.id,
              startTime: activeSchedule.startTime,
              endTime: activeSchedule.endTime,
              timezone: activeSchedule.timezone,
              status: activeSchedule.status,
            }
          : startTime || endTime
            ? {
                id: '',
                startTime,
                endTime,
                timezone: 'Asia/Kolkata',
                status: exam.status?.name || 'SCHEDULED',
              }
            : null,
      },
      accessDetails: {
        accessStatus,
        canStart,
        message,
        serverTime: serverNow.toISOString(),
        startTime: startTime ? new Date(startTime).toISOString() : null,
        endTime: endTime ? new Date(endTime).toISOString() : null,
        waitSeconds,
        existingAttempt,
      },
    };
  }

  /**
   * Get available languages for an exam (with student preferred language detected)
   */
  async getExamAvailableLanguages(examId: string, userId?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        languages: {
          include: {
            language: true,
          },
          orderBy: { isDefault: 'desc' },
        },
      },
    });

    if (!exam) {
      throw new NotFoundException('Exam not found');
    }

    // Get student's preferred language if userId provided
    let studentPreferredLangId: string | null = null;
    if (userId) {
      const student = await this.prisma.student.findUnique({
        where: { userId },
        include: { preferredLanguage: true },
      });
      if (student?.preferredLanguageId) {
        studentPreferredLangId = student.preferredLanguageId;
      }
    }

    let languagesList: Array<{
      id: string;
      code: string;
      name: string;
      nativeName: string;
      isDefault: boolean;
      isPreferred: boolean;
    }> = [];

    if (exam.languages && exam.languages.length > 0) {
      languagesList = exam.languages
        .filter((el) => el.language && el.language.isActive)
        .map((el) => ({
          id: el.language.id,
          code: el.language.code || 'EN',
          name: el.language.name,
          nativeName: el.language.nativeName || el.language.name,
          isDefault: el.isDefault,
          isPreferred: el.language.id === studentPreferredLangId,
        }));
    }

    // If no explicit languages configured, provide active system languages with English as default
    if (languagesList.length === 0) {
      const activeLangs = await this.prisma.preferredLanguage.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
      });

      languagesList = activeLangs.map((l) => ({
        id: l.id,
        code: l.code || 'EN',
        name: l.name,
        nativeName: l.nativeName || l.name,
        isDefault: (l.code || '').toUpperCase() === 'EN',
        isPreferred: l.id === studentPreferredLangId,
      }));
    }

    const defaultLang =
      languagesList.find((l) => l.isDefault) || languagesList[0];

    return {
      examId,
      languages: languagesList,
      defaultLanguageId: defaultLang?.id,
      studentPreferredLanguageId: studentPreferredLangId,
    };
  }

  /**
   * Update exam metadata (only for DRAFT exams)
   */
  async updateExam(id: string, dto: UpdateExamDto) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: { status: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'DRAFT' && exam.status.name !== 'REJECTED') {
      throw new BadRequestException('Can only edit DRAFT or REJECTED exams');
    }

    const updateData: any = {};
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.durationMinutes !== undefined)
      updateData.durationMinutes = dto.durationMinutes;
    if (dto.defaultMarksPerQuestion !== undefined)
      updateData.defaultMarksPerQuestion = dto.defaultMarksPerQuestion;
    if (dto.defaultNegativeMarks !== undefined)
      updateData.defaultNegativeMarks = dto.defaultNegativeMarks;
    if (dto.examDate !== undefined)
      updateData.examDate = new Date(dto.examDate);
    if (dto.startTime !== undefined)
      updateData.startTime = new Date(dto.startTime);
    if (dto.endTime !== undefined) updateData.endTime = new Date(dto.endTime);

    await this.prisma.exam.update({ where: { id }, data: updateData });
    return this.findExamById(id);
  }

  /**
   * Submit exam for approval (DRAFT → PENDING_APPROVAL)
   */
  async submitForApproval(id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: { status: true, _count: { select: { examQuestions: true } } },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'DRAFT') {
      throw new BadRequestException('Exam must be in DRAFT status');
    }
    if (exam._count.examQuestions === 0) {
      throw new BadRequestException('Exam must have at least one question');
    }
    if (exam._count.examQuestions !== exam.totalQuestions) {
      throw new BadRequestException(
        `Exam has ${exam._count.examQuestions} questions but expects ${exam.totalQuestions}`,
      );
    }

    const pendingStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'PENDING_APPROVAL' },
    });
    await this.prisma.exam.update({
      where: { id },
      data: { statusId: pendingStatus!.id },
    });
    return this.findExamById(id);
  }

  /**
   * Approve exam (PENDING_APPROVAL → APPROVED)
   */
  async approveExam(id: string, approvedById: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: { status: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Exam must be in PENDING_APPROVAL status');
    }

    const approvedStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'APPROVED' },
    });
    await this.prisma.exam.update({
      where: { id },
      data: {
        statusId: approvedStatus!.id,
        approvedById,
        approvedAt: new Date(),
      },
    });
    return this.findExamById(id);
  }

  /**
   * Activate exam (APPROVED → ACTIVE) — makes it available for students
   */
  async activateExam(id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: { status: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'APPROVED') {
      throw new BadRequestException('Exam must be APPROVED before activation');
    }

    const activeStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'ACTIVE' },
    });
    await this.prisma.exam.update({
      where: { id },
      data: { statusId: activeStatus!.id, activatedAt: new Date() },
    });
    return this.findExamById(id);
  }

  /**
   * Complete exam (ACTIVE → COMPLETED)
   */
  async completeExam(id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: { status: true },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status.name !== 'ACTIVE') {
      throw new BadRequestException('Exam must be ACTIVE to complete');
    }

    const completedStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'COMPLETED' },
    });
    await this.prisma.exam.update({
      where: { id },
      data: { statusId: completedStatus!.id },
    });
    return this.findExamById(id);
  }

  /**
   * Cancel exam
   */
  async cancelExam(id: string) {
    const cancelledStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'CANCELLED' },
    });
    await this.prisma.exam.update({
      where: { id },
      data: { statusId: cancelledStatus!.id },
    });
    return this.findExamById(id);
  }

  /**
   * Delete exam (supports all statuses with cascading cleanup)
   */
  async deleteExam(id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    return this.prisma.$transaction(async (tx) => {
      // 1. Delete student answers & attempts
      const attempts = await tx.attempt.findMany({
        where: { examId: id },
        select: { id: true },
      });
      const attemptIds = attempts.map((a) => a.id);
      if (attemptIds.length > 0) {
        await tx.questionTimeLog.deleteMany({
          where: { attemptId: { in: attemptIds } },
        });
        await tx.answer.deleteMany({
          where: { attemptId: { in: attemptIds } },
        });
        await tx.attempt.deleteMany({ where: { examId: id } });
      }

      // 2. Delete schedules first to release foreign keys on exam_versions
      await tx.examSchedule.deleteMany({ where: { examId: id } });

      // 3. Delete exam version questions & exam versions
      const versions = await tx.examVersion.findMany({
        where: { examId: id },
        select: { id: true },
      });
      const versionIds = versions.map((v) => v.id);
      if (versionIds.length > 0) {
        await tx.examVersionQuestion.deleteMany({
          where: { examVersionId: { in: versionIds } },
        });
        await tx.examVersion.deleteMany({ where: { examId: id } });
      }

      // 4. Delete questions, sections
      await tx.examQuestion.deleteMany({ where: { examId: id } });
      await tx.examSection.deleteMany({ where: { examId: id } });

      // 5. Delete the exam record
      await tx.exam.delete({ where: { id } });
      return { message: 'Exam deleted successfully' };
    });
  }

  /**
   * Get exams available for students (ACTIVE status, SCHEDULED upcoming, COMPLETED).
   * Note: APPROVED live exams are strictly hidden from students until scheduled.
   * Enriches each exam with schedule window and countdown information.
   */
  async getAvailableExams(examTargetId: string) {
    const availableStatuses = await this.prisma.examStatus.findMany({
      where: { name: { in: ['ACTIVE', 'SCHEDULED', 'COMPLETED'] } },
    });
    const statusIds = availableStatuses.map((s) => s.id);

    const where: any = {
      statusId: { in: statusIds },
    };
    if (
      examTargetId &&
      examTargetId !== 'all' &&
      examTargetId !== 'ALL' &&
      examTargetId !== 'undefined'
    ) {
      where.examTargetId = examTargetId;
    }

    const exams = await this.prisma.exam.findMany({
      where,
      include: {
        examTarget: { select: { id: true, name: true } },
        status: { select: { id: true, name: true } },
        sections: {
          include: {
            subject: { select: { id: true, name: true } },
          },
        },
        schedules: {
          where: { status: { in: ['ACTIVE', 'SCHEDULED', 'RESCHEDULED'] } },
          orderBy: [{ updatedAt: 'desc' }, { startTime: 'asc' }],
          take: 1,
        },
        _count: { select: { examQuestions: true, attempts: true } },
      },
      orderBy: { examDate: 'asc' },
    });

    const now = new Date();
    return exams.map((exam) => {
      const schedule = exam.schedules?.[0] ?? null;
      const isMock =
        exam.title.toUpperCase().includes('MOCK') ||
        exam.title.toUpperCase().includes('PRACTICE') ||
        (exam.sections && exam.sections.length === 1);

      const isLive = !isMock;
      const isScheduled = exam.status.name === 'SCHEDULED';
      const isActive = exam.status.name === 'ACTIVE';

      const scheduleStartTime = schedule ? new Date(schedule.startTime) : exam.startTime ? new Date(exam.startTime) : null;
      const scheduleEndTime = schedule ? new Date(schedule.endTime) : exam.endTime ? new Date(exam.endTime) : null;

      const startsInSeconds = scheduleStartTime
        ? Math.max(0, Math.floor((scheduleStartTime.getTime() - now.getTime()) / 1000))
        : 0;

      const timeRemainingSeconds = scheduleEndTime
        ? Math.max(0, Math.floor((scheduleEndTime.getTime() - now.getTime()) / 1000))
        : exam.durationMinutes * 60;

      // Student can start if status is ACTIVE and (for scheduled exams) current time is within live window
      const canStart = isActive && (isMock || (scheduleStartTime ? now >= scheduleStartTime : true));

      return {
        ...exam,
        isMock,
        isLive,
        canStart,
        schedules: undefined,
        activeSchedule: schedule
          ? {
              id: schedule.id,
              startTime: schedule.startTime,
              endTime: schedule.endTime,
              timezone: schedule.timezone || 'Asia/Kolkata',
              status: schedule.status,
              startsInSeconds,
              timeRemainingSeconds,
            }
          : null,
      };
    });
  }

  /**
   * Get exam questions for the exam interface (student-facing, no correct answers)
   * Supports multilingual presentation with 4-tier fallback (Attempt Language -> Exam Default -> Question Default -> English)
   */
  async getExamQuestionsForAttempt(examId: string, languageId: string) {
    const [questions, examLanguages] = await Promise.all([
      this.prisma.examQuestion.findMany({
        where: { examId },
        orderBy: { displayOrder: 'asc' },
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
                orderBy: { displayOrder: 'asc' },
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
      }),
      this.prisma.examLanguage.findMany({
        where: { examId },
        orderBy: { isDefault: 'desc' },
      }),
    ]);

    const examDefaultLanguageId = examLanguages.find(
      (el) => el.isDefault,
    )?.languageId;

    return questions.map((eq) => {
      const q = eq.question;

      // 4-Tier Fallback:
      // 1. Attempt Language
      // 2. Exam Default Language
      // 3. Question Default Language
      // 4. First Available Translation
      const matchedTranslation =
        q.translations.find(
          (t) => t.languageId === languageId || t.language?.code === languageId,
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
          passageText?: string | null;
          assertionText?: string | null;
          reasonText?: string | null;
        }
      > = {};
      q.translations.forEach((t) => {
        const transObj = {
          questionText: t.questionText,
          passageText: t.passageText || null,
          assertionText: t.assertionText || null,
          reasonText: t.reasonText || null,
        };
        qTranslationsMap[t.languageId] = transObj;
        if (t.language?.code) {
          qTranslationsMap[t.language.code.toLowerCase()] = transObj;
        }
      });

      return {
        examQuestionId: eq.id,
        questionId: q.id,
        displayOrder: eq.displayOrder,
        marks: eq.marks,
        negativeMarks: eq.negativeMarks,
        section: eq.section,
        type: q.type,
        questionType: q.questionType,
        passage: matchedTranslation?.passageText || q.passage || null,
        assertion: matchedTranslation?.assertionText || q.assertion || null,
        reason: matchedTranslation?.reasonText || q.reason || null,
        questionText:
          matchedTranslation?.questionText || (q as any).questionText || '',
        translations: qTranslationsMap,
        options: (q.options || []).map((o) => {
          // Option translation fallback
          const matchedOptTranslation =
            o.translations?.find(
              (ot) =>
                ot.languageId === languageId ||
                ot.language?.code === languageId,
            ) ||
            (examDefaultLanguageId
              ? o.translations?.find(
                  (ot) => ot.languageId === examDefaultLanguageId,
                )
              : null) ||
            o.translations?.find(
              (ot) => ot.languageId === q.defaultLanguageId,
            ) ||
            o.translations?.[0];

          const optTranslationsMap: Record<string, { optionText: string }> = {};
          (o.translations || []).forEach((ot) => {
            const optTransObj = {
              optionText: ot.optionText || o.optionText || o.optionLabel || '',
            };
            optTranslationsMap[ot.languageId] = optTransObj;
            if (ot.language?.code) {
              optTranslationsMap[ot.language.code.toLowerCase()] = optTransObj;
            }
          });

          return {
            id: o.id,
            optionKey: o.optionKey,
            optionLabel: o.optionLabel || o.optionKey || '',
            optionText:
              matchedOptTranslation?.optionText ||
              o.optionText ||
              o.optionLabel ||
              o.optionKey ||
              '',
            translations: optTranslationsMap,
            matchColumn: o.matchColumn,
            matchPairKey: o.matchPairKey,
            displayOrder: o.displayOrder,
            // isCorrect is EXCLUDED from student-facing API
          };
        }),
      };
    });
  }

  /**
   * Internal helper to load full exam
   */
  private async loadExam(tx: any, id: string) {
    return tx.exam.findUnique({
      where: { id },
      include: {
        examTarget: { select: { id: true, name: true } },
        status: { select: { id: true, name: true } },
        sections: {
          orderBy: { displayOrder: 'asc' },
          include: {
            subject: { select: { id: true, name: true } },
            _count: { select: { examQuestions: true } },
          },
        },
        _count: { select: { examQuestions: true } },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // SMART FILTER-BASED EXAM GENERATION ENGINE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Calculate required question counts per difficulty for a section
   */
  private resolveSectionDifficultyRequirements(section: ExamSectionFilterDto) {
    const diff = section.difficultyDistribution;
    const total = section.totalQuestions;

    if (!diff) {
      // Default: no strict difficulty breakdown
      return {
        EASY: 0,
        MEDIUM: 0,
        HARD: 0,
        VERY_HARD: 0,
        hasExplicitDifficultyRules: false,
      };
    }

    // Check if explicit counts are provided
    if (
      diff.easyCount !== undefined ||
      diff.mediumCount !== undefined ||
      diff.hardCount !== undefined ||
      diff.veryHardCount !== undefined
    ) {
      return {
        EASY: diff.easyCount || 0,
        MEDIUM: diff.mediumCount || 0,
        HARD: diff.hardCount || 0,
        VERY_HARD: diff.veryHardCount || 0,
        hasExplicitDifficultyRules: true,
      };
    }

    // Otherwise calculate from percentages
    const easyCount = Math.round((total * (diff.easyPercentage || 0)) / 100);
    const mediumCount = Math.round((total * (diff.mediumPercentage || 0)) / 100);
    const hardCount = Math.round((total * (diff.hardPercentage || 0)) / 100);
    const veryHardCount = Math.max(
      0,
      total - (easyCount + mediumCount + hardCount),
    );

    return {
      EASY: easyCount,
      MEDIUM: mediumCount,
      HARD: hardCount,
      VERY_HARD: veryHardCount,
      hasExplicitDifficultyRules:
        (diff.easyPercentage || 0) +
          (diff.mediumPercentage || 0) +
          (diff.hardPercentage || 0) +
          (diff.veryHardPercentage || 0) >
        0,
    };
  }

  /**
   * Pre-flight pool validation checking if Question Bank satisfies generation filters
   */
  async validateExamGenerationFromFilters(
    dto: ValidateExamGenerationFiltersDto,
  ) {
    const sectionReports: any[] = [];
    const errorMessages: string[] = [];
    let overallValid = true;
    let totalQuestionsCount = 0;

    const baseStatusFilter = dto.onlyApprovedQuestions !== false
      ? 'APPROVED'
      : { in: ['APPROVED', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] };

    for (let i = 0; i < dto.sections.length; i++) {
      const section = dto.sections[i];
      totalQuestionsCount += section.totalQuestions;

      const subject = await this.prisma.subject.findUnique({
        where: { id: section.subjectId },
        select: { id: true, name: true },
      });
      const subjectName = subject?.name || `Subject #${i + 1}`;

      const baseWhere: any = {
        subjectId: section.subjectId,
        isActive: true,
        status: baseStatusFilter,
      };

      if (section.chapterIds && section.chapterIds.length > 0) {
        baseWhere.chapterId = { in: section.chapterIds };
      }
      if (section.topicIds && section.topicIds.length > 0) {
        baseWhere.topicId = { in: section.topicIds };
      }
      if (dto.requiredLanguageIds && dto.requiredLanguageIds.length > 0) {
        baseWhere.translations = {
          some: { languageId: { in: dto.requiredLanguageIds } },
        };
      }

      // Total available in bank for this subject/chapter filter
      const totalAvailable = await this.prisma.question.count({
        where: baseWhere,
      });

      const diffRequirements = this.resolveSectionDifficultyRequirements(section);
      const diffBreakdown: Record<string, any> = {};
      const sectionDeficits: string[] = [];
      let sectionSatisfied = totalAvailable >= section.totalQuestions;

      if (!sectionSatisfied) {
        const msg = `Section "${section.name}" (${subjectName}): Requires ${section.totalQuestions} questions, but only ${totalAvailable} available in question bank.`;
        sectionDeficits.push(msg);
        errorMessages.push(msg);
        overallValid = false;
      }

      if (diffRequirements.hasExplicitDifficultyRules) {
        for (const [diffKey, reqCount] of Object.entries({
          EASY: diffRequirements.EASY,
          MEDIUM: diffRequirements.MEDIUM,
          HARD: diffRequirements.HARD,
          VERY_HARD: diffRequirements.VERY_HARD,
        })) {
          if (reqCount > 0) {
            const availableDiffCount = await this.prisma.question.count({
              where: {
                ...baseWhere,
                difficultyLevel: diffKey as QuestionDifficultyEnum,
              },
            });

            const isDiffSatisfied = availableDiffCount >= reqCount;
            diffBreakdown[diffKey] = {
              required: reqCount,
              available: availableDiffCount,
              isSatisfied: isDiffSatisfied,
            };

            if (!isDiffSatisfied) {
              sectionSatisfied = false;
              overallValid = false;
              const diffMsg = `Section "${section.name}" (${subjectName}): Requires ${reqCount} ${diffKey} questions, but only ${availableDiffCount} available.`;
              sectionDeficits.push(diffMsg);
              errorMessages.push(diffMsg);
            }
          }
        }
      }

      // Question types breakdown if specified
      if (section.questionTypes && section.questionTypes.length > 0) {
        for (const qTypeItem of section.questionTypes) {
          const availableTypeCount = await this.prisma.question.count({
            where: {
              ...baseWhere,
              type: qTypeItem.type,
            },
          });
          if (availableTypeCount < qTypeItem.count) {
            sectionSatisfied = false;
            overallValid = false;
            const typeMsg = `Section "${section.name}" (${subjectName}): Requires ${qTypeItem.count} ${qTypeItem.type} questions, but only ${availableTypeCount} available.`;
            sectionDeficits.push(typeMsg);
            errorMessages.push(typeMsg);
          }
        }
      }

      sectionReports.push({
        sectionIndex: i + 1,
        sectionName: section.name,
        subjectId: section.subjectId,
        subjectName,
        totalQuestions: section.totalQuestions,
        availableTotal: totalAvailable,
        isSatisfied: sectionSatisfied,
        difficultyBreakdown: diffBreakdown,
        deficits: sectionDeficits,
      });
    }

    return {
      isValid: overallValid,
      totalQuestions: totalQuestionsCount,
      sectionsCount: dto.sections.length,
      sectionReports,
      errorMessages,
    };
  }

  /**
   * Preview deterministic question selection for exam paper before final commit
   */
  async previewExamGenerationFromFilters(
    dto: PreviewExamGenerationFiltersDto,
  ) {
    // 1. First validate question inventory
    const validation = await this.validateExamGenerationFromFilters(dto);
    if (!validation.isValid) {
      throw new BadRequestException(
        `Unable to generate exam. Question bank inventory is insufficient:\n${validation.errorMessages.join('\n')}`,
      );
    }

    const generationSeed =
      dto.generationSeed?.trim() ||
      `seed_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const selectedQuestionIds = new Set<string>();
    const previewSections: any[] = [];
    let calculatedTotalMarks = 0;

    const baseStatusFilter = dto.onlyApprovedQuestions !== false
      ? 'APPROVED'
      : { in: ['APPROVED', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] };

    for (let secIdx = 0; secIdx < dto.sections.length; secIdx++) {
      const section = dto.sections[secIdx];
      const subject = await this.prisma.subject.findUnique({
        where: { id: section.subjectId },
        select: { id: true, name: true },
      });

      const marksPerQ =
        section.marksPerQuestion ?? dto.defaultMarksPerQuestion ?? 4;
      const negMarks = section.negativeMarks ?? dto.defaultNegativeMarks ?? 1;

      const baseWhere: any = {
        subjectId: section.subjectId,
        isActive: true,
        status: baseStatusFilter,
        id: { notIn: Array.from(selectedQuestionIds) },
      };

      if (section.chapterIds && section.chapterIds.length > 0) {
        baseWhere.chapterId = { in: section.chapterIds };
      }
      if (section.topicIds && section.topicIds.length > 0) {
        baseWhere.topicId = { in: section.topicIds };
      }
      if (dto.requiredLanguageIds && dto.requiredLanguageIds.length > 0) {
        baseWhere.translations = {
          some: { languageId: { in: dto.requiredLanguageIds } },
        };
      }

      const diffReq = this.resolveSectionDifficultyRequirements(section);
      const sectionQuestions: any[] = [];

      if (diffReq.hasExplicitDifficultyRules) {
        for (const [diffLevel, reqCount] of Object.entries({
          EASY: diffReq.EASY,
          MEDIUM: diffReq.MEDIUM,
          HARD: diffReq.HARD,
          VERY_HARD: diffReq.VERY_HARD,
        })) {
          if (reqCount > 0) {
            const candidates = await this.prisma.question.findMany({
              where: {
                ...baseWhere,
                difficultyLevel: diffLevel as QuestionDifficultyEnum,
                id: { notIn: Array.from(selectedQuestionIds) },
              },
              include: {
                subject: { select: { name: true } },
                chapter: { select: { name: true } },
                topic: { select: { name: true } },
                options: {
                  orderBy: { displayOrder: 'asc' },
                  include: { translations: true },
                },
                translations: true,
                answer: true,
                explanation: true,
              },
            });

            const shuffled = shuffleArraySeed(
              candidates,
              `${generationSeed}_sec_${secIdx}_${diffLevel}`,
            );
            const picked = shuffled.slice(0, reqCount);

            for (const q of picked) {
              selectedQuestionIds.add(q.id);
              sectionQuestions.push(q);
            }
          }
        }
      } else {
        // Uniform / general selection
        const candidates = await this.prisma.question.findMany({
          where: {
            ...baseWhere,
            id: { notIn: Array.from(selectedQuestionIds) },
          },
          include: {
            subject: { select: { name: true } },
            chapter: { select: { name: true } },
            topic: { select: { name: true } },
            options: {
              orderBy: { displayOrder: 'asc' },
              include: { translations: true },
            },
            translations: true,
            answer: true,
            explanation: true,
          },
        });

        const shuffled = shuffleArraySeed(
          candidates,
          `${generationSeed}_sec_${secIdx}`,
        );
        const picked = shuffled.slice(0, section.totalQuestions);

        for (const q of picked) {
          selectedQuestionIds.add(q.id);
          sectionQuestions.push(q);
        }
      }

      calculatedTotalMarks += sectionQuestions.length * marksPerQ;

      // Map question records for preview display
      const mappedQuestions = sectionQuestions.map((q, qIdx) => {
        const defaultTrans =
          q.translations?.find(
            (t: any) =>
              dto.requiredLanguageIds &&
              dto.requiredLanguageIds.includes(t.languageId),
          ) || q.translations?.[0];

        return {
          id: q.id,
          sequenceNumber: qIdx + 1,
          subjectId: q.subjectId,
          subjectName: q.subject?.name || subject?.name || '',
          chapterName: q.chapter?.name || '',
          topicName: q.topic?.name || '',
          difficultyLevel: q.difficultyLevel,
          type: q.type,
          marks: marksPerQ,
          negativeMarks: negMarks,
          questionText: defaultTrans?.questionText || q.passage || 'Question statement',
          passage: q.passage || defaultTrans?.passageText || null,
          assertion: q.assertion || defaultTrans?.assertionText || null,
          reason: q.reason || defaultTrans?.reasonText || null,
          options: (q.options || []).map((opt: any) => ({
            id: opt.id,
            key: opt.optionKey,
            label: opt.optionLabel || opt.optionKey,
            text: opt.optionText || opt.translations?.[0]?.optionText || '',
            isCorrect: opt.isCorrect,
          })),
          correctAnswer: q.correctAnswer || q.answer?.correctOptionIds || null,
          explanation: q.explanation?.explanation || defaultTrans?.explanation || null,
        };
      });

      previewSections.push({
        name: section.name,
        subjectId: section.subjectId,
        subjectName: subject?.name || section.name,
        totalQuestions: section.totalQuestions,
        marksPerQuestion: marksPerQ,
        negativeMarks: negMarks,
        questions: mappedQuestions,
      });
    }

    return {
      examTitle: dto.title,
      examTargetId: dto.examTargetId,
      description: dto.description || '',
      durationMinutes: dto.durationMinutes,
      totalQuestions: selectedQuestionIds.size,
      totalMarks: calculatedTotalMarks,
      generationSeed,
      sections: previewSections,
    };
  }

  /**
   * Transactionally finalize and persist auto-generated Exam Paper into production database
   */
  async createExamFromGenerationFilters(
    dto: FinalizeExamGenerationFiltersDto,
    createdById: string,
  ) {
    // 1. Generate preview & deterministic question selection
    const preview = await this.previewExamGenerationFromFilters(dto);

    // 2. Fetch or verify ExamStatus
    const statusName = dto.publishImmediately ? 'PUBLISHED' : 'DRAFT';
    let targetStatus = await this.prisma.examStatus.findUnique({
      where: { name: statusName },
    });
    if (!targetStatus) {
      targetStatus = await this.prisma.examStatus.findFirst({
        where: { name: 'DRAFT' },
      });
    }
    if (!targetStatus) {
      targetStatus = await this.prisma.examStatus.create({
        data: { name: statusName },
      });
    }

    // 3. Atomically create Exam, ExamSections, ExamQuestions, ScoringRules & Immutable Version Snapshot
    return this.prisma.$transaction(async (tx) => {
      // 3.1 Create Exam
      const exam = await tx.exam.create({
        data: {
          examTargetId: dto.examTargetId,
          title: dto.title,
          description:
            dto.description ||
            `Auto-generated exam with ${preview.totalQuestions} questions`,
          totalQuestions: preview.totalQuestions,
          totalMarks: preview.totalMarks,
          durationMinutes: dto.durationMinutes,
          defaultMarksPerQuestion: dto.defaultMarksPerQuestion ?? 4,
          defaultNegativeMarks: dto.defaultNegativeMarks ?? 1,
          statusId: targetStatus.id,
          createdById,
        },
      });

      let globalQuestionSequence = 1;

      // 3.2 Create Sections and ExamQuestions
      for (let sIdx = 0; sIdx < preview.sections.length; sIdx++) {
        const sec = preview.sections[sIdx];
        const examSection = await tx.examSection.create({
          data: {
            examId: exam.id,
            subjectId: sec.subjectId,
            name: sec.name,
            totalQuestions: sec.questions.length,
            displayOrder: sIdx + 1,
          },
        });

        for (const q of sec.questions) {
          await tx.examQuestion.create({
            data: {
              examId: exam.id,
              sectionId: examSection.id,
              questionId: q.id,
              displayOrder: globalQuestionSequence++,
              marks: q.marks,
              negativeMarks: q.negativeMarks,
            },
          });
        }
      }

      // 3.4 Create Immutable ExamVersion snapshot for zero-drift guarantee
      const examVersion = await tx.examVersion.create({
        data: {
          examId: exam.id,
          versionNumber: 1,
          status: dto.publishImmediately ? 'PUBLISHED' : 'GENERATED',
          generationSeed: preview.generationSeed,
          totalQuestions: preview.totalQuestions,
          durationMinutes: dto.durationMinutes,
          totalMarks: preview.totalMarks,
          generatedById: createdById,
        },
      });

      // Populate snapshot version questions
      let vSeq = 1;
      for (const sec of preview.sections) {
        for (const q of sec.questions) {
          const vQuestion = await tx.examVersionQuestion.create({
            data: {
              examVersionId: examVersion.id,
              sourceQuestionId: q.id,
              sequenceNumber: vSeq++,
              sectionName: sec.name,
              subjectName: sec.subjectName,
              type: q.type as QuestionTypeEnum,
              difficultyLevel: q.difficultyLevel as QuestionDifficultyEnum,
              marks: q.marks,
              negativeMarks: q.negativeMarks,
              passage: q.passage,
              assertion: q.assertion,
              reason: q.reason,
              questionText: q.questionText,
              explanation: q.explanation,
              correctAnswer: q.correctAnswer,
            },
          });

          for (let optIdx = 0; optIdx < q.options.length; optIdx++) {
            const opt = q.options[optIdx];
            await tx.examVersionOption.create({
              data: {
                examVersionQuestionId: vQuestion.id,
                sourceOptionId: opt.id,
                displayOrder: optIdx + 1,
                optionKey: opt.key,
                optionLabel: opt.label,
                optionText: opt.text,
                isCorrect: opt.isCorrect,
              },
            });
          }
        }
      }

      return {
        examId: exam.id,
        examVersionId: examVersion.id,
        title: exam.title,
        status: statusName,
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        generationSeed: preview.generationSeed,
        createdAt: exam.createdAt,
      };
    });
  }

  /**
   * Directly create and finalize an Exam Paper using ONLY the questions from a specific uploaded file / import session
   */
  async createExamDirectlyFromImport(
    importId: string,
    dto: CreateExamFromImportDto,
    userId: string,
  ) {
    const importRecord = await this.prisma.questionImport.findUnique({
      where: { id: importId },
    });

    if (!importRecord) {
      throw new NotFoundException(`Import session '${importId}' not found.`);
    }

    // 1. If rows were staged but not finalized to question bank yet, ensure questions exist
    const candidateRows = await this.prisma.questionImportRow.findMany({
      where: {
        importId,
        status: { in: ['VALID', 'UPDATE_AVAILABLE'] },
      },
      orderBy: { rowNumber: 'asc' },
    });

    if (candidateRows.length === 0) {
      throw new BadRequestException(
        'No valid questions found in this import session to generate an exam.',
      );
    }

    // Ensure all rows are created in Question table
    for (const row of candidateRows) {
      if (!row.resultQuestionId && row.dtoData) {
        const qDto = row.dtoData as any;
        const created = await this.prisma.question.create({
          data: {
            subjectId: qDto.subjectId,
            chapterId: qDto.chapterId,
            topicId: qDto.topicId || undefined,
            difficultyLevel: qDto.difficultyLevel,
            type: qDto.type,
            defaultLanguageId: qDto.defaultLanguageId,
            marks: qDto.marks || 4,
            negativeMarks: qDto.negativeMarks || 1,
            passage: qDto.passage || undefined,
            assertion: qDto.assertion || undefined,
            reason: qDto.reason || undefined,
            correctAnswer: qDto.answer?.correctOptionIds || null,
            createdById: userId,
            status: 'APPROVED',
            options: {
              create: (qDto.options || []).map((o: any, idx: number) => ({
                optionKey: o.optionKey || String.fromCharCode(65 + idx),
                optionLabel:
                  o.optionLabel || o.optionKey || String.fromCharCode(65 + idx),
                optionText: o.optionText || '',
                isCorrect: o.isCorrect || false,
                displayOrder: o.displayOrder || idx + 1,
              })),
            },
            translations: {
              create: (qDto.translations || []).map((t: any) => ({
                languageId: t.languageId,
                questionText: t.questionText || '',
                explanation: t.explanation || '',
              })),
            },
            explanation: qDto.explanation
              ? { create: { explanation: qDto.explanation.explanation } }
              : undefined,
          },
        });
        await this.prisma.questionImportRow.update({
          where: { id: row.id },
          data: {
            importStatus: 'SUCCESS',
            resultQuestionId: created.id,
          },
        });
      }
    }

    await this.prisma.questionImport.update({
      where: { id: importId },
      data: { status: 'COMPLETED' },
    });

    // 2. Fetch all successfully linked questions
    const importedRows = await this.prisma.questionImportRow.findMany({
      where: {
        importId,
        resultQuestionId: { not: null },
      },
      orderBy: { rowNumber: 'asc' },
    });

    const questionIds = importedRows
      .map((r) => r.resultQuestionId as string)
      .filter(Boolean);

    const questions = await this.prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: {
        subject: { select: { id: true, name: true } },
        chapter: { select: { id: true, name: true } },
        topic: { select: { id: true, name: true } },
        options: { orderBy: { displayOrder: 'asc' } },
        translations: true,
        explanation: true,
        answer: true,
      },
    });

    // Preserve row order
    const questionMap = new Map<string, any>(questions.map((q) => [q.id, q]));
    const orderedQuestions: any[] = [];
    for (const qId of questionIds) {
      const q = questionMap.get(qId);
      if (q) orderedQuestions.push(q);
    }

    // 3. Resolve Target Curriculum
    let targetExamId = dto.examTargetId;
    if (!targetExamId && orderedQuestions[0]?.subject?.examTargetId) {
      targetExamId = orderedQuestions[0].subject.examTargetId;
    }
    if (!targetExamId) {
      const defaultTarget = await this.prisma.examTarget.findFirst();
      targetExamId = defaultTarget?.id || '';
    }

    // 4. Group questions into Sections by Subject
    const sectionsMap = new Map<
      string,
      { subjectId: string; subjectName: string; questions: any[] }
    >();
    for (const q of orderedQuestions) {
      const subId = q.subjectId;
      const subName = q.subject?.name || 'General';
      if (!sectionsMap.has(subId)) {
        sectionsMap.set(subId, {
          subjectId: subId,
          subjectName: subName,
          questions: [],
        });
      }
      sectionsMap.get(subId)!.questions.push(q);
    }

    const marksPerQ = dto.defaultMarksPerQuestion ?? 4;
    const negMarks = dto.defaultNegativeMarks ?? 1;
    const totalMarks = orderedQuestions.reduce(
      (sum, q) => sum + (q.marks || marksPerQ),
      0,
    );
    const duration =
      dto.durationMinutes || Math.max(30, orderedQuestions.length * 2);

    const statusName = dto.publishImmediately !== false ? 'PUBLISHED' : 'DRAFT';
    let targetStatus = await this.prisma.examStatus.findUnique({
      where: { name: statusName },
    });
    if (!targetStatus) {
      targetStatus = await this.prisma.examStatus.findFirst();
    }
    if (!targetStatus) {
      throw new NotFoundException('ExamStatus not found in database');
    }

    // 5. Transactionally create Exam, Sections, Questions, Scoring Rules, and Version Snapshot
    return this.prisma.$transaction(async (tx) => {
      const exam = await tx.exam.create({
        data: {
          examTargetId: targetExamId,
          title: dto.title,
          description:
            dto.description ||
            `Exam generated directly from uploaded file: ${importRecord.fileName} (${orderedQuestions.length} Questions)`,
          totalQuestions: orderedQuestions.length,
          totalMarks,
          durationMinutes: duration,
          defaultMarksPerQuestion: marksPerQ,
          defaultNegativeMarks: negMarks,
          statusId: targetStatus.id,
          createdById: userId,
        },
      });

      let globalOrder = 1;
      const createdSections: any[] = [];
      const sectionsList = Array.from(sectionsMap.values());

      for (let sIdx = 0; sIdx < sectionsList.length; sIdx++) {
        const secData = sectionsList[sIdx];
        const examSection = await tx.examSection.create({
          data: {
            examId: exam.id,
            subjectId: secData.subjectId,
            name: secData.subjectName,
            totalQuestions: secData.questions.length,
            displayOrder: sIdx + 1,
          },
        });

        for (const q of secData.questions) {
          await tx.examQuestion.create({
            data: {
              examId: exam.id,
              sectionId: examSection.id,
              questionId: q.id,
              displayOrder: globalOrder++,
              marks: q.marks || marksPerQ,
              negativeMarks: q.negativeMarks || negMarks,
            },
          });
        }

        createdSections.push({
          id: examSection.id,
          name: examSection.name,
          totalQuestions: secData.questions.length,
        });
      }

      // Create Immutable ExamVersion snapshot
      const examVersion = await tx.examVersion.create({
        data: {
          examId: exam.id,
          versionNumber: 1,
          status: dto.publishImmediately !== false ? 'PUBLISHED' : 'GENERATED',
          generationSeed: `import_${importId}`,
          totalQuestions: orderedQuestions.length,
          durationMinutes: duration,
          totalMarks,
          generatedById: userId,
        },
      });

      let vSeq = 1;
      for (const q of orderedQuestions) {
        const defaultTrans = q.translations?.[0];
        const vQuestion = await tx.examVersionQuestion.create({
          data: {
            examVersionId: examVersion.id,
            sourceQuestionId: q.id,
            sequenceNumber: vSeq++,
            sectionName: q.subject?.name || 'General',
            subjectName: q.subject?.name || 'General',
            type: q.type,
            difficultyLevel: q.difficultyLevel,
            marks: q.marks || marksPerQ,
            negativeMarks: q.negativeMarks || negMarks,
            passage: q.passage,
            assertion: q.assertion,
            reason: q.reason,
            questionText:
              defaultTrans?.questionText ||
              q.passage ||
              'Question statement',
            explanation:
              q.explanation?.explanation || defaultTrans?.explanation || null,
            correctAnswer: q.correctAnswer || q.answer?.correctOptionIds || null,
          },
        });

        for (let optIdx = 0; optIdx < (q.options || []).length; optIdx++) {
          const opt = q.options[optIdx];
          await tx.examVersionOption.create({
            data: {
              examVersionQuestionId: vQuestion.id,
              sourceOptionId: opt.id,
              displayOrder: optIdx + 1,
              optionKey: opt.optionKey,
              optionLabel: opt.optionLabel || opt.optionKey,
              optionText: opt.optionText || '',
              isCorrect: opt.isCorrect,
            },
          });
        }
      }

      return {
        examId: exam.id,
        examVersionId: examVersion.id,
        title: exam.title,
        status: statusName,
        totalQuestions: exam.totalQuestions,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.durationMinutes,
        sectionsCount: createdSections.length,
        fileName: importRecord.fileName,
        createdAt: exam.createdAt,
      };
    });
  }
}

