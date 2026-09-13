import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditLogService } from '../admin/audit/services/audit-log.service';
import {
  CreateSubjectDto,
  UpdateSubjectDto,
  CreateChapterDto,
  UpdateChapterDto,
  ChapterQueryDto,
  CreateTopicDto,
  UpdateTopicDto,
  CreateSubTopicDto,
  UpdateSubTopicDto,
} from './dto/academic.dto';

const CHAPTER_CACHE_TTL = 300; // 5 minutes

@Injectable()
export class AcademicService {
  private readonly logger = new Logger(AcademicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // SUBJECTS
  // ═══════════════════════════════════════════════════════════════

  async createSubject(dto: CreateSubjectDto, actorUserId?: string) {
    const examTarget = await this.prisma.examTarget.findUnique({
      where: { id: dto.examTargetId },
    });
    if (!examTarget) {
      throw new NotFoundException(`Target Exam with ID '${dto.examTargetId}' does not exist.`);
    }

    const trimmedName = dto.name.trim();
    const existing = await this.prisma.subject.findFirst({
      where: {
        examTargetId: dto.examTargetId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (existing) {
      throw new ConflictException(
        `A subject with the name "${trimmedName}" already exists for ${examTarget.name}.`,
      );
    }

    let displayOrder = dto.displayOrder;
    if (displayOrder === undefined || displayOrder === null) {
      const maxOrder = await this.prisma.subject.aggregate({
        where: { examTargetId: dto.examTargetId },
        _max: { displayOrder: true },
      });
      displayOrder = (maxOrder._max.displayOrder || 0) + 1;
    }

    const subject = await this.prisma.subject.create({
      data: {
        examTargetId: dto.examTargetId,
        name: trimmedName,
        code: dto.code?.trim() || null,
        displayOrder,
      },
      include: { examTarget: { select: { id: true, name: true } } },
    });

    await this.auditLogService.logAction({
      actorUserId: actorUserId || null,
      action: 'SUBJECT_CREATED',
      entityType: 'Subject',
      entityId: subject.id,
      afterState: subject,
      metadata: { examTargetId: dto.examTargetId, examTargetName: examTarget.name, name: subject.name },
    });

    return subject;
  }

  async findAllSubjects(examTargetId?: string) {
    return this.prisma.subject.findMany({
      where: examTargetId ? { examTargetId } : undefined,
      include: {
        examTarget: { select: { id: true, name: true } },
        _count: { select: { chapters: true, questions: true } },
      },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async findSubjectById(id: string) {
    const subject = await this.prisma.subject.findUnique({
      where: { id },
      include: {
        examTarget: { select: { id: true, name: true } },
        chapters: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
          include: { _count: { select: { topics: true, questions: true } } },
        },
        _count: { select: { questions: true } },
      },
    });
    if (!subject) throw new NotFoundException('Subject not found');
    return subject;
  }

  async updateSubject(id: string, dto: UpdateSubjectDto) {
    await this.findSubjectById(id);
    return this.prisma.subject.update({
      where: { id },
      data: dto,
      include: { examTarget: { select: { id: true, name: true } } },
    });
  }

  async deleteSubject(id: string) {
    await this.findSubjectById(id);
    await this.prisma.subject.delete({ where: { id } });
    return { message: 'Subject deleted successfully' };
  }

  // ═══════════════════════════════════════════════════════════════
  // CHAPTERS MASTER DATA MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  private getChapterCacheKey(subjectId: string, includeInactive: boolean): string {
    return `subject:${subjectId}:chapters:${includeInactive ? 'all' : 'active'}`;
  }

  async invalidateSubjectChaptersCache(subjectId: string): Promise<void> {
    try {
      await Promise.all([
        this.redisService.del(`subject:${subjectId}:chapters:active`),
        this.redisService.del(`subject:${subjectId}:chapters:all`),
        this.redisService.del(`subject:${subjectId}:chapters`),
      ]);
      const matchedKeys = await this.redisService.keys(`subject:${subjectId}:*`);
      for (const k of matchedKeys) {
        await this.redisService.del(k);
      }
    } catch (err: any) {
      this.logger.warn(`Redis cache invalidation warning for subject ${subjectId}: ${err.message}`);
    }
  }

  /**
   * Find all chapters across subjects or for a specific subject with search and status filtering
   */
  async findAllChapters(query?: ChapterQueryDto) {
    const where: any = {};

    if (query?.subjectId) {
      where.subjectId = query.subjectId;
    }

    if (query?.status) {
      const upperStatus = query.status.toUpperCase();
      if (upperStatus === 'ACTIVE') {
        where.isActive = true;
      } else if (upperStatus === 'INACTIVE' || upperStatus === 'ARCHIVED') {
        where.isActive = false;
      }
    } else if (query?.includeInactive === false) {
      where.isActive = true;
    }

    if (query?.search?.trim()) {
      const s = query.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { code: { contains: s, mode: 'insensitive' } },
        { subject: { name: { contains: s, mode: 'insensitive' } } },
      ];
    }

    const page = query?.page;
    const limit = query?.limit;

    if (page && limit) {
      const skip = (page - 1) * limit;
      const [chapters, total] = await Promise.all([
        this.prisma.chapter.findMany({
          where,
          include: {
            subject: {
              select: {
                id: true,
                name: true,
                code: true,
                examTarget: { select: { id: true, name: true } },
              },
            },
            _count: { select: { topics: true, questions: true } },
          },
          orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
          skip,
          take: limit,
        }),
        this.prisma.chapter.count({ where }),
      ]);

      return {
        data: chapters,
        meta: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      };
    }

    return this.prisma.chapter.findMany({
      where,
      include: {
        subject: {
          select: {
            id: true,
            name: true,
            code: true,
            examTarget: { select: { id: true, name: true } },
          },
        },
        _count: { select: { topics: true, questions: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Find chapters for a specific subject (with caching for active chapters)
   */
  async findChaptersBySubject(subjectId: string, includeInactive: boolean = false) {
    if (!subjectId) return [];

    let targetSubjectId = subjectId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId);
    if (!isUuid) {
      const subject = await this.prisma.subject.findFirst({
        where: {
          OR: [
            { code: { equals: subjectId, mode: 'insensitive' } },
            { name: { equals: subjectId, mode: 'insensitive' } },
          ],
        },
      });
      if (!subject) {
        return [];
      }
      targetSubjectId = subject.id;
    }

    const cacheKey = this.getChapterCacheKey(targetSubjectId, includeInactive);

    // Try Redis cache
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err: any) {
      this.logger.warn(`Redis get failed for key ${cacheKey}: ${err.message}`);
    }

    const chapters = await this.prisma.chapter.findMany({
      where: {
        subjectId: targetSubjectId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: {
        subject: { select: { id: true, name: true, code: true } },
        _count: { select: { topics: true, questions: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    // Write to Redis cache
    try {
      await this.redisService.set(cacheKey, JSON.stringify(chapters), CHAPTER_CACHE_TTL);
    } catch (err: any) {
      this.logger.warn(`Redis set failed for key ${cacheKey}: ${err.message}`);
    }

    return chapters;
  }

  async findChapterById(id: string) {
    const chapter = await this.prisma.chapter.findUnique({
      where: { id },
      include: {
        subject: {
          select: {
            id: true,
            name: true,
            code: true,
            examTarget: { select: { id: true, name: true } },
          },
        },
        topics: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
          include: {
            _count: { select: { subTopics: true, questions: true } },
          },
        },
        _count: { select: { questions: true, topics: true } },
      },
    });
    if (!chapter) throw new NotFoundException('Chapter not found');
    return chapter;
  }

  async createChapter(dto: CreateChapterDto, actorUserId?: string) {
    // 1. Verify subject exists
    const subject = await this.prisma.subject.findUnique({
      where: { id: dto.subjectId },
    });
    if (!subject) {
      throw new NotFoundException(`Subject with ID '${dto.subjectId}' does not exist.`);
    }

    // 2. Prevent duplicate chapters under the same subject
    const trimmedName = dto.name.trim();
    const existing = await this.prisma.chapter.findFirst({
      where: {
        subjectId: dto.subjectId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (existing) {
      throw new ConflictException(
        `A chapter with the name "${trimmedName}" already exists for ${subject.name}.`,
      );
    }

    // 3. Determine display order if not specified
    let displayOrder = dto.displayOrder;
    if (displayOrder === undefined || displayOrder === null) {
      const maxOrder = await this.prisma.chapter.aggregate({
        where: { subjectId: dto.subjectId },
        _max: { displayOrder: true },
      });
      displayOrder = (maxOrder._max.displayOrder || 0) + 1;
    }

    const chapter = await this.prisma.chapter.create({
      data: {
        subjectId: dto.subjectId,
        name: trimmedName,
        code: dto.code?.trim() || null,
        description: dto.description?.trim() || null,
        displayOrder,
        isActive: dto.isActive ?? true,
      },
      include: {
        subject: { select: { id: true, name: true, code: true } },
        _count: { select: { topics: true, questions: true } },
      },
    });

    // Invalidate Redis cache
    await this.invalidateSubjectChaptersCache(dto.subjectId);

    // Audit log
    await this.auditLogService.logAction({
      actorUserId: actorUserId || null,
      action: 'CHAPTER_CREATED',
      entityType: 'Chapter',
      entityId: chapter.id,
      afterState: chapter,
      metadata: { subjectId: dto.subjectId, subjectName: subject.name, name: chapter.name },
    });

    return chapter;
  }

  async updateChapter(id: string, dto: UpdateChapterDto, actorUserId?: string) {
    const existing = await this.findChapterById(id);
    const targetSubjectId = dto.subjectId || existing.subjectId;
    const targetName = dto.name !== undefined ? dto.name.trim() : existing.name;

    // 1. Prevent duplicate under the same subject if name or subject changes
    if (dto.name !== undefined || dto.subjectId !== undefined) {
      const duplicate = await this.prisma.chapter.findFirst({
        where: {
          subjectId: targetSubjectId,
          name: { equals: targetName, mode: 'insensitive' },
          id: { not: id },
        },
      });

      if (duplicate) {
        throw new ConflictException(
          `A chapter with the name "${targetName}" already exists for this subject.`,
        );
      }
    }

    // 2. Prevent moving subject if questions are already associated
    if (dto.subjectId && dto.subjectId !== existing.subjectId) {
      const questionCount = await this.prisma.question.count({
        where: { chapterId: id },
      });
      if (questionCount > 0) {
        throw new BadRequestException(
          `Cannot move chapter to a different subject because it is already referenced by ${questionCount} question(s).`,
        );
      }
    }

    const updated = await this.prisma.chapter.update({
      where: { id },
      data: {
        subjectId: dto.subjectId || undefined,
        name: dto.name !== undefined ? dto.name.trim() : undefined,
        code: dto.code !== undefined ? dto.code?.trim() || null : undefined,
        description: dto.description !== undefined ? dto.description?.trim() || null : undefined,
        displayOrder: dto.displayOrder !== undefined ? dto.displayOrder : undefined,
        isActive: dto.isActive !== undefined ? dto.isActive : undefined,
      },
      include: {
        subject: { select: { id: true, name: true, code: true } },
        _count: { select: { topics: true, questions: true } },
      },
    });

    // Invalidate Redis cache
    await this.invalidateSubjectChaptersCache(existing.subjectId);
    if (dto.subjectId && dto.subjectId !== existing.subjectId) {
      await this.invalidateSubjectChaptersCache(dto.subjectId);
    }

    // Audit log
    let auditAction = 'CHAPTER_UPDATED';
    if (dto.isActive === false && existing.isActive === true) {
      auditAction = 'CHAPTER_DEACTIVATED';
    } else if (dto.isActive === true && existing.isActive === false) {
      auditAction = 'CHAPTER_ACTIVATED';
    }

    await this.auditLogService.logAction({
      actorUserId: actorUserId || null,
      action: auditAction,
      entityType: 'Chapter',
      entityId: id,
      beforeState: existing,
      afterState: updated,
      metadata: { subjectId: targetSubjectId, name: updated.name },
    });

    return updated;
  }

  /**
   * Safe Delete Strategy:
   * - If chapter is referenced by questions, topics, or blueprint rules: deactivate/archive instead of hard deletion.
   * - If completely unreferenced: perform permanent deletion.
   */
  async deleteChapter(id: string, actorUserId?: string) {
    const existing = await this.findChapterById(id);

    const [questionsCount, topicsCount, chapterResultsCount] =
      await Promise.all([
        this.prisma.question.count({ where: { chapterId: id } }),
        this.prisma.topic.count({ where: { chapterId: id } }),
        this.prisma.chapterResult.count({ where: { chapterId: id } }),
      ]);

    const totalDependencies =
      questionsCount + topicsCount + chapterResultsCount;

    if (totalDependencies > 0) {
      // Deactivate/archive instead of hard-deleting
      const deactivated = await this.prisma.chapter.update({
        where: { id },
        data: { isActive: false },
        include: { subject: { select: { id: true, name: true } } },
      });

      await this.invalidateSubjectChaptersCache(existing.subjectId);

      await this.auditLogService.logAction({
        actorUserId: actorUserId || null,
        action: 'CHAPTER_DEACTIVATED',
        entityType: 'Chapter',
        entityId: id,
        reason: `Deactivated due to ${totalDependencies} existing dependency reference(s) (Questions: ${questionsCount}, Topics: ${topicsCount}).`,
        beforeState: existing,
        afterState: deactivated,
      });

      return {
        message: `Chapter "${existing.name}" is currently referenced by ${questionsCount} question(s) and ${topicsCount} topic(s). It cannot be permanently deleted and has been deactivated/archived instead.`,
        deactivated: true,
        chapter: deactivated,
      };
    }

    // No dependencies: safely hard delete
    await this.prisma.chapter.delete({ where: { id } });

    await this.invalidateSubjectChaptersCache(existing.subjectId);

    await this.auditLogService.logAction({
      actorUserId: actorUserId || null,
      action: 'CHAPTER_DELETED',
      entityType: 'Chapter',
      entityId: id,
      beforeState: existing,
      afterState: null,
    });

    return {
      message: `Chapter "${existing.name}" was permanently deleted successfully.`,
      deleted: true,
    };
  }

  /**
   * Transactional chapter reordering
   */
  async reorderChapters(subjectId: string, chapterIds: string[], actorUserId?: string) {
    const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) {
      throw new NotFoundException(`Subject with ID '${subjectId}' does not exist.`);
    }

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < chapterIds.length; i++) {
        await tx.chapter.update({
          where: { id: chapterIds[i] },
          data: { displayOrder: i + 1 },
        });
      }
    });

    await this.invalidateSubjectChaptersCache(subjectId);

    await this.auditLogService.logAction({
      actorUserId: actorUserId || null,
      action: 'CHAPTER_REORDERED',
      entityType: 'Subject',
      entityId: subjectId,
      metadata: { chapterIds, count: chapterIds.length },
    });

    return this.findChaptersBySubject(subjectId, true);
  }

  // ═══════════════════════════════════════════════════════════════
  // TOPICS
  // ═══════════════════════════════════════════════════════════════

  async createTopic(dto: CreateTopicDto) {
    return this.prisma.topic.create({
      data: dto,
      include: { chapter: { select: { id: true, name: true } } },
    });
  }

  async findTopicsByChapter(chapterId: string) {
    return this.prisma.topic.findMany({
      where: { chapterId },
      include: {
        chapter: { select: { id: true, name: true } },
        _count: { select: { subTopics: true, questions: true } },
      },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async findTopicById(id: string) {
    const topic = await this.prisma.topic.findUnique({
      where: { id },
      include: {
        chapter: { select: { id: true, name: true } },
        subTopics: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
        _count: { select: { questions: true } },
      },
    });
    if (!topic) throw new NotFoundException('Topic not found');
    return topic;
  }

  async updateTopic(id: string, dto: UpdateTopicDto) {
    await this.findTopicById(id);
    return this.prisma.topic.update({
      where: { id },
      data: dto,
      include: { chapter: { select: { id: true, name: true } } },
    });
  }

  async deleteTopic(id: string) {
    await this.findTopicById(id);
    await this.prisma.topic.delete({ where: { id } });
    return { message: 'Topic deleted successfully' };
  }

  // ═══════════════════════════════════════════════════════════════
  // SUB-TOPICS
  // ═══════════════════════════════════════════════════════════════

  async createSubTopic(dto: CreateSubTopicDto) {
    return this.prisma.subTopic.create({
      data: dto,
      include: { topic: { select: { id: true, name: true } } },
    });
  }

  async findSubTopicsByTopic(topicId: string) {
    return this.prisma.subTopic.findMany({
      where: { topicId },
      include: {
        topic: { select: { id: true, name: true } },
        _count: { select: { questions: true } },
      },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async findSubTopicById(id: string) {
    const subTopic = await this.prisma.subTopic.findUnique({
      where: { id },
      include: {
        topic: { select: { id: true, name: true } },
        _count: { select: { questions: true } },
      },
    });
    if (!subTopic) throw new NotFoundException('Sub-topic not found');
    return subTopic;
  }

  async updateSubTopic(id: string, dto: UpdateSubTopicDto) {
    await this.findSubTopicById(id);
    return this.prisma.subTopic.update({
      where: { id },
      data: dto,
      include: { topic: { select: { id: true, name: true } } },
    });
  }

  async deleteSubTopic(id: string) {
    await this.findSubTopicById(id);
    await this.prisma.subTopic.delete({ where: { id } });
    return { message: 'Sub-topic deleted successfully' };
  }

  // ═══════════════════════════════════════════════════════════════
  // LOOKUP DATA
  // ═══════════════════════════════════════════════════════════════

  async getDifficultyLevels() {
    return this.prisma.difficultyLevel.findMany({
      orderBy: { displayOrder: 'asc' },
    });
  }

  async getQuestionTypes() {
    return this.prisma.questionType.findMany({ orderBy: { name: 'asc' } });
  }

  async getExamStatuses() {
    return this.prisma.examStatus.findMany({ orderBy: { name: 'asc' } });
  }

  async getExamTargets() {
    return this.prisma.examTarget.findMany({
      where: {
        name: { in: ['JEE', 'NEET', 'CET'], mode: 'insensitive' },
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Returns the entire academic hierarchy for a given exam target as a tree
   */
  async getHierarchy(examTargetId: string) {
    const subjects = await this.prisma.subject.findMany({
      where: { examTargetId, isActive: true },
      orderBy: { displayOrder: 'asc' },
      include: {
        chapters: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
          include: {
            topics: {
              where: { isActive: true },
              orderBy: { displayOrder: 'asc' },
              include: {
                subTopics: {
                  where: { isActive: true },
                  orderBy: { displayOrder: 'asc' },
                },
              },
            },
          },
        },
      },
    });
    return subjects;
  }
}
