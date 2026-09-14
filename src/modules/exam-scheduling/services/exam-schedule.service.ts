import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExamLifecycleService } from './exam-lifecycle.service';
import { ScheduleExamDto, RescheduleExamDto } from '../dto/schedule-exam.dto';
import { AdminScheduleExamDto, CheckQuestionAvailabilityDto } from '../dto/admin-schedule-exam.dto';
import { NotificationQueueService } from '../../notification/queues/notification-queue.service';
import { ScheduleReminderService } from './schedule-reminder.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EXAM_WINDOW_END_QUEUE_NAME } from '../../result/interfaces/result-lifecycle.interface';
import { EXAM_CACHE_PREPARATION_QUEUE_NAME } from '../../exam-cache/interfaces/exam-cache.interface';
import { ExamCacheService } from '../../exam-cache/services/exam-cache.service';

@Injectable()
export class ExamScheduleService {
  private readonly logger = new Logger(ExamScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycleService: ExamLifecycleService,
    private readonly notificationQueue: NotificationQueueService,
    private readonly scheduleReminderService: ScheduleReminderService,
    private readonly examCacheService: ExamCacheService,
    @InjectQueue(EXAM_WINDOW_END_QUEUE_NAME)
    private readonly windowEndQueue: Queue,
    @InjectQueue(EXAM_CACHE_PREPARATION_QUEUE_NAME)
    private readonly cachePrepQueue: Queue,
  ) {}

  /**
   * Check Question Pool Availability for configuration
   */
  async checkQuestionAvailability(dto: CheckQuestionAvailabilityDto) {
    const examTypeUpper = (dto.examType || '').toUpperCase();
    let availableCount = 0;
    const requiredCount = Number(dto.questionCount || dto.requestedCount || 0);

    let resolvedTargetId = dto.examTargetId;
    if (dto.examTargetName) {
      const matched = await this.prisma.examTarget.findFirst({
        where: { name: { contains: dto.examTargetName, mode: 'insensitive' } },
      });
      if (matched) resolvedTargetId = matched.id;
    }

    const breakdown: any[] = [];

    if (examTypeUpper === 'SPECIFIC_CHAPTER') {
      let groups: { subjectId: string; chapterIds: string[]; questionCount?: number }[] = [];
      if (dto.subjectGroups && Array.isArray(dto.subjectGroups) && dto.subjectGroups.length > 0) {
        groups = dto.subjectGroups;
      } else if (dto.subjectId) {
        const rawChIds = dto.chapterIds
          ? Array.isArray(dto.chapterIds)
            ? dto.chapterIds
            : [dto.chapterIds]
          : [];
        const chIds = rawChIds.length > 0 ? rawChIds : dto.chapterId ? [dto.chapterId] : [];
        groups = [{ subjectId: dto.subjectId, chapterIds: chIds }];
      }

      for (const group of groups) {
        if (!group.subjectId) continue;
        const sub = await this.prisma.subject.findUnique({
          where: { id: group.subjectId },
          select: { id: true, name: true },
        });
        if (!sub) continue;

        if (resolvedTargetId) {
          const isAllowed = await this.prisma.examTargetSubject.findUnique({
            where: {
              examTargetId_subjectId: {
                examTargetId: resolvedTargetId,
                subjectId: group.subjectId,
              },
            },
          });
          if (!isAllowed) {
            const target = await this.prisma.examTarget.findUnique({ where: { id: resolvedTargetId }, select: { name: true } });
            throw new BadRequestException(`Subject '${sub.name}' is not permitted for Exam Target '${target?.name || resolvedTargetId}'.`);
          }
        }

        let groupAvailable = 0;
        const chaptersInfo: any[] = [];

        const chIds = group.chapterIds || [];
        for (const chId of chIds) {
          const chapter = await this.prisma.chapter.findUnique({
            where: { id: chId },
            select: { id: true, name: true, subjectId: true },
          });
          if (!chapter) continue;
          if (chapter.subjectId !== group.subjectId) {
            throw new BadRequestException(`Chapter '${chapter.name}' does not belong to Subject '${sub.name}'.`);
          }

          const count = await this.prisma.question.count({
            where: {
              chapterId: chId,
              status: 'APPROVED',
              isActive: true,
            },
          });
          groupAvailable += count;
          availableCount += count;
          chaptersInfo.push({
            chapterId: chapter.id,
            chapterName: chapter.name,
            availableCount: count,
          });
        }

        breakdown.push({
          subjectId: sub.id,
          subjectName: sub.name,
          availableCount: groupAvailable,
          chapters: chaptersInfo,
        });
      }
    } else if (examTypeUpper === 'SPECIFIC_SUBJECT') {
      const subIds: string[] = [];
      if (dto.subjectIds) {
        const rawSubIds = Array.isArray(dto.subjectIds) ? dto.subjectIds : [dto.subjectIds];
        subIds.push(...rawSubIds);
      } else if (dto.subjectId) {
        subIds.push(dto.subjectId);
      }

      const uniqueSubIds = Array.from(new Set(subIds));
      for (const sId of uniqueSubIds) {
        const subject = await this.prisma.subject.findUnique({
          where: { id: sId },
          select: { id: true, name: true },
        });
        if (!subject) continue;

        if (resolvedTargetId) {
          const isAllowed = await this.prisma.examTargetSubject.findUnique({
            where: {
              examTargetId_subjectId: {
                examTargetId: resolvedTargetId,
                subjectId: sId,
              },
            },
          });
          if (!isAllowed) {
            const target = await this.prisma.examTarget.findUnique({ where: { id: resolvedTargetId }, select: { name: true } });
            throw new BadRequestException(`Subject '${subject.name}' is not permitted for Exam Target '${target?.name || resolvedTargetId}'.`);
          }
        }

        const count = await this.prisma.question.count({
          where: {
            subjectId: sId,
            status: 'APPROVED',
            isActive: true,
          },
        });
        availableCount += count;
        breakdown.push({
          subjectId: subject.id,
          subjectName: subject.name,
          availableCount: count,
        });
      }
    } else {
      // FULL_EXAM (JEE / NEET / CET)
      if (resolvedTargetId) {
        availableCount = await this.prisma.question.count({
          where: {
            subject: {
              examTargetSubjects: {
                some: { examTargetId: resolvedTargetId },
              },
            },
            status: 'APPROVED',
            isActive: true,
          },
        });
      }
    }

    const isAvailable = requiredCount > 0 ? availableCount >= requiredCount : true;
    return {
      availableCount,
      totalAvailable: availableCount,
      requiredCount,
      isAvailable,
      breakdown,
      message: availableCount > 0
        ? `${availableCount} question(s) available in bank.`
        : 'Question paper can also be uploaded after scheduling.',
    };
  }

  /**
   * Schedule an Approved Exam: APPROVED -> SCHEDULED
   */
  async scheduleExam(
    examId: string,
    dto: ScheduleExamDto,
    scheduledById: string,
  ) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        status: true,
        versions: dto.examVersionId ? { where: { id: dto.examVersionId } } : true,
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    if (
      exam.status.name === 'CANCELLED' ||
      exam.status.name === 'ENDED' ||
      exam.status.name === 'COMPLETED' ||
      exam.status.name === 'DRAFT' ||
      exam.status.name === 'SUBMITTED'
    ) {
      throw new BadRequestException(
        `Cannot schedule exam with status '${exam.status.name}'. Exam must be APPROVED or PUBLISHED first.`,
      );
    }

    let versionId = dto.examVersionId;
    if (!versionId || exam.versions.length === 0) {
      let version = await this.prisma.examVersion.findFirst({
        where: { examId },
        orderBy: { versionNumber: 'desc' },
      });
      if (!version) {
        version = await this.prisma.examVersion.create({
          data: {
            examId,
            versionNumber: 1,
            status: 'PUBLISHED',
            totalQuestions: exam.totalQuestions,
            durationMinutes: exam.durationMinutes,
            totalMarks: exam.totalMarks,
            generatedById: scheduledById,
          },
        });
      }
      versionId = version.id;
    }

    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      throw new BadRequestException(
        'Invalid startTime or endTime ISO timestamp format.',
      );
    }

    if (startTime >= endTime) {
      throw new BadRequestException(
        `Invalid live window: startTime (${startTime.toISOString()}) must be strictly before endTime (${endTime.toISOString()}).`,
      );
    }

    if (endTime.getTime() <= Date.now()) {
      throw new BadRequestException(
        'Cannot schedule an exam in the past. The schedule end time must be in the future.',
      );
    }

    const scheduled = await this.prisma.$transaction(async (tx) => {
      // Check for overlapping active or scheduled sessions for this exam
      const existingOverlapping = await tx.examSchedule.findFirst({
        where: {
          examId,
          status: { in: ['SCHEDULED', 'ACTIVE'] },
          AND: [
            { startTime: { lt: endTime } },
            { endTime: { gt: startTime } },
          ],
        },
      });

      if (existingOverlapping) {
        throw new BadRequestException(
          'An active or scheduled session already overlaps with the specified time window for this exam.',
        );
      }

      // 1. Create schedule record
      const schedule = await tx.examSchedule.create({
        data: {
          examId,
          examVersionId: versionId,
          startTime,
          endTime,
          timezone: dto.timezone || 'Asia/Kolkata',
          status: 'SCHEDULED',
          scheduledById,
        },
        include: {
          exam: { select: { id: true, title: true } },
          examVersion: { select: { id: true, versionNumber: true } },
        },
      });

      // 2. Transition Exam status to SCHEDULED
      const scheduledStatus = await this.lifecycleService.getOrCreateExamStatus(
        'SCHEDULED',
        tx,
      );

      await tx.exam.update({
        where: { id: examId },
        data: {
          statusId: scheduledStatus.id,
          startTime,
          endTime,
        },
      });

      // 3. Record lifecycle audit history
      await this.lifecycleService.recordHistory(
        {
          examId,
          examVersionId: versionId,
          scheduleId: schedule.id,
          action: 'SCHEDULE',
          fromStatus: exam.status.name,
          toStatus: 'SCHEDULED',
          performedById: scheduledById,
          comment: `Scheduled for window ${startTime.toISOString()} - ${endTime.toISOString()} (${dto.timezone || 'Asia/Kolkata'})`,
          metadata: {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            timezone: dto.timezone,
          },
        },
        tx,
      );

      // 4. Sync ExamCalendar entry
      await this.syncToCalendar(
        tx,
        examId,
        startTime,
        endTime,
        dto.timezone || 'Asia/Kolkata',
        'CONFIRMED',
        scheduledById,
      );

      // 4. Record AuditLog for Super Admin Exam Time Control
      await tx.auditLog.create({
        data: {
          actorUserId: scheduledById,
          action: 'EXAM_SCHEDULE_CHANGE',
          entityType: 'EXAM_SCHEDULE',
          entityId: schedule.id,
          beforeState: { startTime: null, endTime: null },
          afterState: { startTime: startTime.toISOString(), endTime: endTime.toISOString() },
          metadata: {
            previousStartTime: null,
            newStartTime: startTime.toISOString(),
            previousEndTime: null,
            newEndTime: endTime.toISOString(),
            changedBy: scheduledById,
            changedAt: new Date().toISOString(),
          },
        },
      });

      // 5. Create pending ApprovalRequest for Super Admin approval queue
      const isMock =
        exam.title.toUpperCase().includes('MOCK') ||
        exam.title.toUpperCase().includes('PRACTICE');

      await tx.approvalRequest.create({
        data: {
          resourceType: isMock ? 'MOCK_TEST' : 'EXAM',
          resourceId: examId,
          requestedById: scheduledById,
          status: 'PENDING',
          metadata: {
            examId,
            title: exam.title,
            scheduleId: schedule.id,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            totalQuestions: exam.totalQuestions,
            durationMinutes: exam.durationMinutes,
            isMock,
          },
          submittedAt: new Date(),
        },
      });

      this.logger.log(
        `Exam '${examId}' scheduled (Schedule ID: '${schedule.id}') by user '${scheduledById}'`,
      );
      return schedule;
    }, { maxWait: 10000, timeout: 30000 });

    // 1. Direct in-app notification creation for all active students
    try {
      const students = await this.prisma.student.findMany({
        where: { status: 'ACTIVE' },
        select: { userId: true, name: true },
      });

      if (students.length > 0) {
        const formattedDate = startTime.toLocaleString('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: dto.timezone || 'Asia/Kolkata',
        });

        const records = students.map((s) => ({
          userId: s.userId,
          recipientUserId: s.userId,
          channel: 'IN_APP' as any,
          type: 'EXAM_SCHEDULED' as any,
          title: `New Exam Scheduled: ${exam.title}`,
          message: `${exam.title} has been scheduled for ${formattedDate} (${dto.timezone || 'Asia/Kolkata'}). Duration: ${exam.durationMinutes} mins.`,
          data: {
            entityType: 'EXAM',
            entityId: exam.id,
            action: 'VIEW',
            examTitle: exam.title,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            durationMinutes: exam.durationMinutes,
          },
          payload: {
            examTitle: exam.title,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            durationMinutes: exam.durationMinutes,
          },
          priority: 'NORMAL' as any,
          status: 'DELIVERED' as any,
          isRead: false,
          idempotencyKey: `sched_${exam.id}_${s.userId}_${scheduled.id}`,
        }));

        await this.prisma.notification.createMany({
          data: records,
          skipDuplicates: true,
        });
      }
    } catch (err: any) {
      this.logger.warn(`Direct schedule notification creation error: ${err.message}`);
    }

    // 2. Asynchronously dispatch BullMQ notification job to all eligible students
    this.notificationQueue.dispatchExamNotificationJob({
      type: 'EXAM_SCHEDULED',
      examId,
      scheduleId: scheduled.id,
    });

    // 3. Schedule delayed BullMQ job to trigger automated batch evaluation when window closes
    try {
      const nowMs = Date.now();
      const endMs = endTime.getTime();
      const delay = Math.max(0, endMs - nowMs);
      const windowEndJobId = `window_end_${examId}_${scheduled.id}`;

      // Remove existing job if any
      const existingJob = await this.windowEndQueue.getJob(windowEndJobId);
      if (existingJob) {
        await existingJob.remove();
      }

      await this.windowEndQueue.add(
        'EXAM_WINDOW_END',
        {
          examId,
          scheduleId: scheduled.id,
          triggeredAt: endTime.toISOString(),
        },
        {
          jobId: windowEndJobId,
          delay,
          removeOnComplete: true,
        },
      );
      this.logger.log(
        `[ScheduleExam] Scheduled window-end job '${windowEndJobId}' with delay ${delay}ms (${endTime.toISOString()})`,
      );
    } catch (queueErr: any) {
      this.logger.error(
        `[ScheduleExam] Failed to schedule window-end BullMQ job: ${queueErr.message}`,
      );
    }

    // 4. Schedule WhatsApp exam reminders (24H + 1H) for eligible students (non-blocking)
    const examForReminder = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: { examTarget: true },
    }).catch(() => null);

    if (examForReminder?.examTargetId) {
      this.scheduleReminderService.scheduleExamWhatsAppReminders({
        examId,
        scheduleId: scheduled.id,
        examTargetId: examForReminder.examTargetId,
        examTitle: examForReminder.title,
        examTargetName: examForReminder.examTarget?.name || '',
        startTime,
        scheduleVersion: 1,
      }).catch((reminderErr: any) => {
        this.logger.warn(`[ScheduleExam] WhatsApp reminder scheduling error (non-blocking): ${reminderErr.message}`);
      });
    }

    return scheduled;
  }

  /**
   * Admin Exam Scheduling Flow: SPECIFIC_SUBJECT | SPECIFIC_CHAPTER | FULL_EXAM (JEE / NEET / CET)
   * Supports Create and Edit (when dto.examId is passed)
   */
  async scheduleAdminExam(dto: AdminScheduleExamDto, scheduledById: string) {
    const startTime = new Date(dto.startTime);
    if (isNaN(startTime.getTime())) {
      throw new BadRequestException('Invalid startTime ISO timestamp format.');
    }

    let title = dto.examName?.trim() || dto.title?.trim();
    let durationMinutes = Number(dto.duration || dto.durationMinutes || 180);
    let totalQuestions = Number(dto.questionCount || dto.totalQuestions || 100);
    let examTargetId = dto.examTargetId;

    let targetName = dto.examTargetName || 'General';

    const examTypeUpper = (dto.examType || '').toUpperCase();

    // Resolve Target ID if target name was provided (e.g. JEE, NEET, CET)
    if (dto.examTargetName) {
      const matched = await this.prisma.examTarget.findFirst({
        where: { name: { contains: dto.examTargetName, mode: 'insensitive' } },
      });
      if (matched) {
        examTargetId = matched.id;
        targetName = matched.name;
      }
    }

    const resolvedSubjects: any[] = [];
    const resolvedSubjectGroups: { subject: any; chapters: any[]; questionCount?: number }[] = [];

    // Resolve Target ID if not already resolved
    if (!examTargetId) {
      const targetSearch = dto.examTargetName || (examTypeUpper === 'FULL_EXAM' ? 'NEET' : examTypeUpper);
      const matched = await this.prisma.examTarget.findFirst({
        where: { name: { contains: targetSearch === 'JEE_NEET_CET' ? 'NEET' : targetSearch, mode: 'insensitive' } },
      });
      if (matched) {
        examTargetId = matched.id;
        targetName = matched.name;
      } else {
        const fallback = await this.prisma.examTarget.findFirst();
        if (fallback) {
          examTargetId = fallback.id;
          targetName = fallback.name;
        }
      }
    }

    if (examTypeUpper === 'SPECIFIC_SUBJECT') {
      const subjectList: { subjectId: string; questionCount?: number }[] = [];
      if (dto.subjects && Array.isArray(dto.subjects) && dto.subjects.length > 0) {
        for (const item of dto.subjects) {
          if (typeof item === 'string') subjectList.push({ subjectId: item });
          else if (item?.subjectId) subjectList.push({ subjectId: item.subjectId, questionCount: item.questionCount });
        }
      } else if (dto.subjectIds && Array.isArray(dto.subjectIds) && dto.subjectIds.length > 0) {
        for (const sId of dto.subjectIds) {
          subjectList.push({ subjectId: sId });
        }
      } else if (dto.subjectId) {
        subjectList.push({ subjectId: dto.subjectId });
      }

      if (subjectList.length === 0) {
        throw new BadRequestException('At least one Subject is required for Specific Subject exams.');
      }

      // Check duplicates
      const seenSubjects = new Set<string>();
      for (const s of subjectList) {
        if (seenSubjects.has(s.subjectId)) {
          throw new BadRequestException('Duplicate subjects are not allowed.');
        }
        seenSubjects.add(s.subjectId);

        const subObj = await this.prisma.subject.findUnique({
          where: { id: s.subjectId },
        });
        if (!subObj) {
          throw new NotFoundException(`Subject with ID '${s.subjectId}' not found.`);
        }
        if (examTargetId) {
          const isAllowed = await this.prisma.examTargetSubject.findUnique({
            where: {
              examTargetId_subjectId: {
                examTargetId,
                subjectId: s.subjectId,
              },
            },
          });
          if (!isAllowed) {
            throw new BadRequestException(`Subject '${subObj.name}' is not permitted for Exam Target '${targetName}'.`);
          }
        }
        resolvedSubjects.push({ ...subObj, customQuestionCount: s.questionCount });
      }

      if (!title) {
        title = `${resolvedSubjects.map((s) => s.name).join(' & ')} Subject Exam`;
      }
      if (totalQuestions <= 0) {
        throw new BadRequestException('Question count must be greater than 0.');
      }
      if (durationMinutes <= 0) {
        throw new BadRequestException('Duration in minutes must be greater than 0.');
      }
    } else if (examTypeUpper === 'SPECIFIC_CHAPTER') {
      let groups: { subjectId: string; chapterIds: string[]; questionCount?: number }[] = [];
      if (dto.subjectGroups && Array.isArray(dto.subjectGroups) && dto.subjectGroups.length > 0) {
        groups = dto.subjectGroups;
      } else if (dto.subjectId) {
        const chIds = dto.chapterIds && dto.chapterIds.length > 0 ? dto.chapterIds : (dto.chapterId ? [dto.chapterId] : []);
        groups = [{ subjectId: dto.subjectId, chapterIds: chIds, questionCount: dto.questionCount }];
      }

      if (groups.length === 0) {
        throw new BadRequestException('At least one Subject group is required for Specific Chapter exams.');
      }

      const seenSubjects = new Set<string>();
      const allSelectedChapterIds: string[] = [];

      for (const group of groups) {
        if (!group.subjectId) {
          throw new BadRequestException('Subject is required for all chapter groups.');
        }
        if (seenSubjects.has(group.subjectId)) {
          throw new BadRequestException('Duplicate subjects in chapter groups are not allowed.');
        }
        seenSubjects.add(group.subjectId);

        const subObj = await this.prisma.subject.findUnique({
          where: { id: group.subjectId },
        });
        if (!subObj) {
          throw new NotFoundException(`Subject with ID '${group.subjectId}' not found.`);
        }
        if (examTargetId) {
          const isAllowed = await this.prisma.examTargetSubject.findUnique({
            where: {
              examTargetId_subjectId: {
                examTargetId,
                subjectId: group.subjectId,
              },
            },
          });
          if (!isAllowed) {
            throw new BadRequestException(`Subject '${subObj.name}' is not permitted for Exam Target '${targetName}'.`);
          }
        }

        const chIds = group.chapterIds || [];
        if (chIds.length === 0) {
          throw new BadRequestException(`Please select at least one Chapter for Subject '${subObj.name}'.`);
        }

        const seenChapters = new Set<string>();
        const groupChapters: any[] = [];

        for (const chId of chIds) {
          if (seenChapters.has(chId)) {
            throw new BadRequestException(`Duplicate chapter selection detected in Subject '${subObj.name}'.`);
          }
          seenChapters.add(chId);
          allSelectedChapterIds.push(chId);

          const chapterObj = await this.prisma.chapter.findUnique({
            where: { id: chId },
          });
          if (!chapterObj) {
            throw new NotFoundException(`Chapter with ID '${chId}' not found.`);
          }
          if (chapterObj.subjectId !== group.subjectId) {
            throw new BadRequestException(`Chapter '${chapterObj.name}' does not belong to Subject '${subObj.name}'.`);
          }
          groupChapters.push(chapterObj);
        }

        resolvedSubjectGroups.push({
          subject: subObj,
          chapters: groupChapters,
          questionCount: group.questionCount,
        });
      }

      if (!title) {
        const parts = resolvedSubjectGroups.map(
          (g) => `${g.subject.name} (${g.chapters.map((c) => c.name).join(', ')})`,
        );
        title = `${parts.join(' + ')} Chapter Exam`;
      }
      if (totalQuestions <= 0) {
        throw new BadRequestException('Question count must be greater than 0.');
      }
      if (durationMinutes <= 0) {
        throw new BadRequestException('Duration in minutes must be greater than 0.');
      }
    } else {
      // FULL_EXAM — JEE / NEET / CET
      if (!title) {
        title = `${targetName} Full Exam`;
      }

      if (totalQuestions <= 0) {
        throw new BadRequestException('Question count must be greater than 0.');
      }
      if (durationMinutes <= 0) {
        throw new BadRequestException('Duration in minutes must be greater than 0.');
      }
    }

    // Dynamic End Time: strictly Start Time + Duration
    const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

    if (startTime >= endTime) {
      throw new BadRequestException('End time must be greater than start time.');
    }

    if (endTime.getTime() <= Date.now()) {
      throw new BadRequestException('Cannot schedule an exam in the past. End time must be in the future.');
    }

    // Resolve or fallback exam target
    if (!examTargetId) {
      const fallbackTarget = await this.prisma.examTarget.findFirst();
      if (fallbackTarget) {
        examTargetId = fallbackTarget.id;
      } else {
        const createdTarget = await this.prisma.examTarget.create({
          data: { name: 'General Exam Target', description: 'Default Target' },
        });
        examTargetId = createdTarget.id;
      }
    }

    let validLanguageId: string | null = null;
    if (dto.languageId) {
      const lang = await this.prisma.preferredLanguage.findUnique({
        where: { id: dto.languageId },
        select: { id: true },
      });
      if (lang) {
        validLanguageId = lang.id;
      }
    }

    const scheduledStatus = await this.lifecycleService.getOrCreateExamStatus('SCHEDULED');

    // Create or Edit Exam, Version & Schedule in a transaction
    const scheduleRecord: any = await this.prisma.$transaction(
      async (tx) => {
        const marksPerQ = dto.marksPerQuestion !== undefined && dto.marksPerQuestion >= 0 ? Number(dto.marksPerQuestion) : 4;
        const negMarks = dto.negativeMarks !== undefined && dto.negativeMarks >= 0 ? Number(dto.negativeMarks) : 1;

        let exam: any;
        let isEdit = false;

        if (dto.examId) {
          // Edit existing exam
          exam = await tx.exam.findUnique({
            where: { id: dto.examId },
            include: { sections: true, schedules: true },
          });
          if (!exam) {
            throw new NotFoundException(`Exam with ID '${dto.examId}' not found.`);
          }
          isEdit = true;

          exam = await tx.exam.update({
            where: { id: dto.examId },
            data: {
              examTargetId,
              title,
              description: dto.description?.trim() || exam.description,
              totalQuestions: Number(totalQuestions),
              totalMarks: Number(totalQuestions) * marksPerQ,
              durationMinutes,
              defaultMarksPerQuestion: marksPerQ,
              defaultNegativeMarks: negMarks,
              startTime,
              endTime,
              performanceThresholds: JSON.parse(
                JSON.stringify({
                  examType: dto.examType,
                  subjectGroups: dto.subjectGroups,
                  subjects: dto.subjects,
                  subjectIds: dto.subjectIds,
                }),
              ),
            },
          });

          // Delete existing sections to rebuild
          await tx.examSection.deleteMany({ where: { examId: exam.id } });
        } else {
          // Create new Exam record
          exam = await tx.exam.create({
            data: {
              examTargetId,
              title,
              description: dto.description?.trim() || `Scheduled via Admin Exam Manager (${dto.examType})`,
              totalQuestions: Number(totalQuestions),
              totalMarks: Number(totalQuestions) * marksPerQ,
              durationMinutes,
              defaultMarksPerQuestion: marksPerQ,
              defaultNegativeMarks: negMarks,
              statusId: scheduledStatus.id,
              startTime,
              endTime,
              createdById: scheduledById,
              performanceThresholds: JSON.parse(
                JSON.stringify({
                  examType: dto.examType,
                  subjectGroups: dto.subjectGroups,
                  subjects: dto.subjects,
                  subjectIds: dto.subjectIds,
                }),
              ),
            },
          });
        }

        if (validLanguageId) {
          await tx.examLanguage.deleteMany({ where: { examId: exam.id } });
          await tx.examLanguage.create({
            data: {
              examId: exam.id,
              languageId: validLanguageId,
              isDefault: true,
              displayOrder: 1,
            },
          });
        }

        // 2. Create Sections
        const sectionRows: any[] = [];
        if (examTypeUpper === 'SPECIFIC_SUBJECT') {
          const sectionQ = Math.floor(Number(totalQuestions) / (resolvedSubjects.length || 1));
          for (let i = 0; i < resolvedSubjects.length; i++) {
            const s = resolvedSubjects[i];
            sectionRows.push({
              examId: exam.id,
              subjectId: s.id,
              name: `${s.name} Section`,
              totalQuestions: s.customQuestionCount || sectionQ,
              displayOrder: i + 1,
            });
          }
        } else if (examTypeUpper === 'SPECIFIC_CHAPTER') {
          const sectionQ = Math.floor(Number(totalQuestions) / (resolvedSubjectGroups.length || 1));
          for (let i = 0; i < resolvedSubjectGroups.length; i++) {
            const g = resolvedSubjectGroups[i];
            sectionRows.push({
              examId: exam.id,
              subjectId: g.subject.id,
              name: `${g.subject.name} Section`,
              totalQuestions: g.questionCount || sectionQ,
              displayOrder: i + 1,
            });
          }
        } else {
          // FULL_EXAM (JEE / NEET / CET)
          const targetSubjects = await tx.examTargetSubject.findMany({
            where: { examTargetId },
            include: { subject: true },
            orderBy: { displayOrder: 'asc' },
          });
          const sectionQuestions = Math.floor(Number(totalQuestions) / (targetSubjects.length || 1));
          for (let i = 0; i < targetSubjects.length; i++) {
            sectionRows.push({
              examId: exam.id,
              subjectId: targetSubjects[i].subjectId,
              name: `${targetSubjects[i].subject.name} Section`,
              totalQuestions: sectionQuestions,
              displayOrder: i + 1,
            });
          }
        }

        if (sectionRows.length > 0) {
          await tx.examSection.createMany({ data: sectionRows });
        }

      // 3. Create or update ExamVersion
      let version = await tx.examVersion.findFirst({ where: { examId: exam.id } });
      if (version) {
        version = await tx.examVersion.update({
          where: { id: version.id },
          data: {
            totalQuestions: Number(totalQuestions),
            durationMinutes,
            totalMarks: Number(totalQuestions) * marksPerQ,
          },
        });
      } else {
        version = await tx.examVersion.create({
          data: {
            examId: exam.id,
            versionNumber: 1,
            status: 'PUBLISHED',
            totalQuestions: Number(totalQuestions),
            durationMinutes,
            totalMarks: Number(totalQuestions) * marksPerQ,
            generatedById: scheduledById,
          },
        });
      }

      // 4. Create or update ExamSchedule
      let schedule = await tx.examSchedule.findFirst({ where: { examId: exam.id } });
      if (schedule) {
        schedule = await tx.examSchedule.update({
          where: { id: schedule.id },
          data: {
            examVersionId: version.id,
            startTime,
            endTime,
            timezone: dto.timezone || 'Asia/Kolkata',
            status: 'SCHEDULED',
          },
          include: {
            exam: {
              include: {
                status: true,
                examTarget: true,
                sections: { include: { subject: true } },
              },
            },
            examVersion: true,
          },
        });
      } else {
        schedule = await tx.examSchedule.create({
          data: {
            examId: exam.id,
            examVersionId: version.id,
            startTime,
            endTime,
            timezone: dto.timezone || 'Asia/Kolkata',
            status: 'SCHEDULED',
            scheduledById,
          },
          include: {
            exam: {
              include: {
                status: true,
                examTarget: true,
                sections: { include: { subject: true } },
              },
            },
            examVersion: true,
          },
        });
      }

      // 5. Create or update pending ApprovalRequest
      const isMockTest =
        title.toUpperCase().includes('MOCK') ||
        title.toUpperCase().includes('PRACTICE');

      const existingApproval = await tx.approvalRequest.findFirst({
        where: { resourceId: exam.id },
      });

      if (!existingApproval) {
        await tx.approvalRequest.create({
          data: {
            resourceType: isMockTest ? 'MOCK_TEST' : 'EXAM',
            resourceId: exam.id,
            requestedById: scheduledById,
            status: 'PENDING',
            metadata: {
              examId: exam.id,
              title: exam.title,
              scheduleId: schedule.id,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              totalQuestions: Number(totalQuestions),
              durationMinutes,
              isMock: isMockTest,
            },
            submittedAt: new Date(),
          },
        });
      }

      // 6. Sync ExamCalendar
      await this.syncToCalendar(
        tx,
        exam.id,
        startTime,
        endTime,
        dto.timezone || 'Asia/Kolkata',
        'CONFIRMED',
        scheduledById,
      );

      // 7. Record AuditLog
      await tx.auditLog.create({
        data: {
          actorUserId: scheduledById,
          action: isEdit ? 'EXAM_SCHEDULE_UPDATE' : 'EXAM_SCHEDULE_CHANGE',
          entityType: 'EXAM_SCHEDULE',
          entityId: schedule.id,
          beforeState: { isEdit },
          afterState: { startTime: startTime.toISOString(), endTime: endTime.toISOString() },
          metadata: {
            examType: dto.examType,
            title,
            totalQuestions,
            durationMinutes,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            changedBy: scheduledById,
            changedAt: new Date().toISOString(),
          },
        },
      });

      return schedule;
    }, { maxWait: 10000, timeout: 30000 });

    // Asynchronous student notification
    try {
      this.notificationQueue.dispatchExamNotificationJob({
        type: 'EXAM_SCHEDULED',
        examId: scheduleRecord.examId,
        scheduleId: scheduleRecord.id,
      });
    } catch (nErr: any) {
      this.logger.warn(`Notification dispatch error: ${nErr.message}`);
    }

    // Asynchronously dispatch BullMQ exam question cache preparation job
    try {
      const cacheJobId = `cache_prep_${scheduleRecord.examId}_${scheduleRecord.examVersionId}`;
      await this.cachePrepQueue.add(
        'PREPARE_EXAM_CACHE',
        {
          examId: scheduleRecord.examId,
          examVersionId: scheduleRecord.examVersionId,
          scheduleId: scheduleRecord.id,
          officialExamEndTime: scheduleRecord.endTime.toISOString(),
          userId: scheduledById,
        },
        {
          jobId: cacheJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      );
    } catch (cErr: any) {
      this.logger.warn(`Failed to enqueue cache preparation job: ${cErr.message}`);
    }

    // Schedule WhatsApp exam reminders (24H + 1H) for eligible students (non-blocking)
    if (scheduleRecord.exam?.examTarget?.id || scheduleRecord.exam?.examTargetId) {
      const targetId = (scheduleRecord.exam as any).examTargetId || scheduleRecord.exam?.examTarget?.id;
      const targetName = scheduleRecord.exam?.examTarget?.name || '';
      this.scheduleReminderService.scheduleExamWhatsAppReminders({
        examId: scheduleRecord.examId,
        scheduleId: scheduleRecord.id,
        examTargetId: targetId,
        examTitle: scheduleRecord.exam?.title || '',
        examTargetName: targetName,
        startTime: scheduleRecord.startTime,
        scheduleVersion: 1,
      }).catch((reminderErr: any) => {
        this.logger.warn(`[AdminScheduleExam] WhatsApp reminder scheduling error (non-blocking): ${reminderErr.message}`);
      });
    }

    return scheduleRecord;
  }

  /**
   * Fetch complete structured schedule configuration for editing
   */
  async getExamScheduleDetail(examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examTarget: true,
        status: true,
        sections: { include: { subject: true } },
        languages: { include: { language: true } },
        schedules: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found.`);
    }

    const schedule = exam.schedules?.[0];
    const thresholdMetadata = (exam.performanceThresholds as any) || {};

    return {
      examId: exam.id,
      title: exam.title,
      description: exam.description,
      examTargetId: exam.examTargetId,
      examTargetName: exam.examTarget?.name,
      totalQuestions: exam.totalQuestions,
      durationMinutes: exam.durationMinutes,
      defaultMarksPerQuestion: exam.defaultMarksPerQuestion,
      defaultNegativeMarks: exam.defaultNegativeMarks,
      startTime: schedule?.startTime || exam.startTime,
      endTime: schedule?.endTime || exam.endTime,
      timezone: schedule?.timezone || 'Asia/Kolkata',
      languageId: exam.languages?.[0]?.languageId,
      examType: thresholdMetadata.examType || (exam.sections.length > 1 ? 'FULL_EXAM' : 'SPECIFIC_SUBJECT'),
      subjectGroups: thresholdMetadata.subjectGroups || [],
      subjects: thresholdMetadata.subjects || exam.sections.map((s) => ({ subjectId: s.subjectId, name: s.subject?.name, questionCount: s.totalQuestions })),
      subjectIds: thresholdMetadata.subjectIds || exam.sections.map((s) => s.subjectId),
      sections: exam.sections,
    };
  }

  /**
   * Reschedule a Scheduled Exam: SCHEDULED -> SCHEDULED with updated window
   */
  async rescheduleExam(
    scheduleId: string,
    dto: RescheduleExamDto,
    performedById: string,
  ) {
    const schedule = await this.prisma.examSchedule.findUnique({
      where: { id: scheduleId },
      include: { exam: { include: { status: true } } },
    });

    if (!schedule) {
      throw new NotFoundException(`Schedule with ID '${scheduleId}' not found`);
    }

    if (schedule.status !== 'SCHEDULED') {
      throw new BadRequestException(
        `Cannot reschedule an exam with status '${schedule.status}'. Only 'SCHEDULED' exams can be rescheduled.`,
      );
    }

    const newStartTime = new Date(dto.startTime);
    let newEndTime: Date;
    if (dto.endTime) {
      newEndTime = new Date(dto.endTime);
    } else {
      const durationMins = schedule.exam?.durationMinutes || 180;
      newEndTime = new Date(newStartTime.getTime() + durationMins * 60 * 1000);
    }

    if (isNaN(newStartTime.getTime()) || isNaN(newEndTime.getTime())) {
      throw new BadRequestException(
        'Invalid startTime or endTime ISO timestamp format.',
      );
    }

    if (newStartTime >= newEndTime) {
      throw new BadRequestException(
        `Invalid live window: newStartTime must be strictly before newEndTime.`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const oldWindow = {
        startTime: schedule.startTime.toISOString(),
        endTime: schedule.endTime.toISOString(),
        timezone: schedule.timezone,
      };

      const updatedSchedule = await tx.examSchedule.update({
        where: { id: scheduleId },
        data: {
          startTime: newStartTime,
          endTime: newEndTime,
          timezone: dto.timezone || schedule.timezone,
        },
      });

      await tx.exam.update({
        where: { id: schedule.examId },
        data: {
          startTime: newStartTime,
          endTime: newEndTime,
        },
      });

      await this.lifecycleService.recordHistory(
        {
          examId: schedule.examId,
          examVersionId: schedule.examVersionId,
          scheduleId: schedule.id,
          action: 'RESCHEDULE',
          fromStatus: 'SCHEDULED',
          toStatus: 'SCHEDULED',
          performedById,
          comment: dto.reason || 'Exam rescheduled by administrator.',
          metadata: {
            previousWindow: oldWindow,
            newWindow: {
              startTime: newStartTime.toISOString(),
              endTime: newEndTime.toISOString(),
              timezone: dto.timezone || schedule.timezone,
            },
          },
        },
        tx,
      );

      // Record AuditLog for Super Admin Exam Reschedule
      await tx.auditLog.create({
        data: {
          actorUserId: performedById,
          action: 'EXAM_SCHEDULE_CHANGE',
          entityType: 'EXAM_SCHEDULE',
          entityId: schedule.id,
          beforeState: {
            startTime: schedule.startTime.toISOString(),
            endTime: schedule.endTime.toISOString(),
          },
          afterState: {
            startTime: newStartTime.toISOString(),
            endTime: newEndTime.toISOString(),
          },
          reason: dto.reason || 'Exam rescheduled by administrator.',
          metadata: {
            previousStartTime: schedule.startTime.toISOString(),
            newStartTime: newStartTime.toISOString(),
            previousEndTime: schedule.endTime.toISOString(),
            newEndTime: newEndTime.toISOString(),
            changedBy: performedById,
            changedAt: new Date().toISOString(),
          },
        },
      });

      // Sync ExamCalendar on reschedule
      await this.syncToCalendar(
        tx,
        schedule.examId,
        newStartTime,
        newEndTime,
        dto.timezone || schedule.timezone,
        'RESCHEDULED',
        performedById,
      );

      this.logger.log(
        `Schedule '${scheduleId}' rescheduled by user '${performedById}'`,
      );
      return updatedSchedule;
    }, { maxWait: 10000, timeout: 30000 });

    // Asynchronously dispatch BullMQ notification job
    this.notificationQueue.dispatchExamNotificationJob({
      type: 'EXAM_RESCHEDULED',
      examId: schedule.examId,
      scheduleId,
    });

    // Update Redis question cache expiration based on new official end time
    await this.examCacheService
      .updateExamCacheTTL(schedule.examId, schedule.examVersionId, newEndTime)
      .catch((tErr: any) => {
        this.logger.warn(`Failed to update exam cache TTL on reschedule: ${tErr.message}`);
      });

    // Update delayed BullMQ job to trigger automated batch evaluation at newEndTime
    try {
      const nowMs = Date.now();
      const endMs = newEndTime.getTime();
      const delay = Math.max(0, endMs - nowMs);
      const windowEndJobId = `window_end_${schedule.examId}_${schedule.id}`;

      const existingJob = await this.windowEndQueue.getJob(windowEndJobId);
      if (existingJob) {
        await existingJob.remove();
      }

      await this.windowEndQueue.add(
        'EXAM_WINDOW_END',
        {
          examId: schedule.examId,
          scheduleId: schedule.id,
          triggeredAt: newEndTime.toISOString(),
        },
        {
          jobId: windowEndJobId,
          delay,
          removeOnComplete: true,
        },
      );
      this.logger.log(
        `[RescheduleExam] Rescheduled window-end job '${windowEndJobId}' with delay ${delay}ms (${newEndTime.toISOString()})`,
      );
    } catch (queueErr: any) {
      this.logger.error(
        `[RescheduleExam] Failed to reschedule window-end BullMQ job: ${queueErr.message}`,
      );
    }

    // Cancel old WhatsApp reminders and schedule new ones for the updated time (non-blocking)
    const examForReminder = await this.prisma.exam.findUnique({
      where: { id: schedule.examId },
      include: { examTarget: true },
    }).catch(() => null);

    if (examForReminder?.examTargetId) {
      // Use updatedAt timestamp as an incrementing version signal
      const newVersion = Math.floor(Date.now() / 1000);
      this.scheduleReminderService.handleExamRescheduled(
        schedule.examId,
        scheduleId,
        examForReminder.examTargetId,
        examForReminder.title,
        examForReminder.examTarget?.name || '',
        newStartTime,
        newVersion - 1,   // cancel reminders from any older version
        newVersion,       // new version for fresh reminders
      ).catch((reminderErr: any) => {
        this.logger.warn(`[RescheduleExam] WhatsApp reminder reschedule error (non-blocking): ${reminderErr.message}`);
      });
    }

    return updated;
  }

  /**
   * Super Admin activates Exam: SCHEDULED -> ACTIVE
   * Implements strict concurrency protection and idempotency
   */
  async activateExam(scheduleId: string, performedById: string) {
    const schedule = await this.prisma.examSchedule.findUnique({
      where: { id: scheduleId },
      include: {
        exam: { include: { status: true } },
        examVersion: true,
      },
    });

    if (!schedule) {
      throw new NotFoundException(`Schedule with ID '${scheduleId}' not found`);
    }

    // Idempotency: If already active, return cleanly
    if (schedule.status === 'ACTIVE') {
      return {
        message: 'Exam is already activated.',
        schedule,
      };
    }

    if (schedule.status !== 'SCHEDULED') {
      throw new BadRequestException(
        `Cannot activate schedule with status '${schedule.status}'. Only 'SCHEDULED' exams can be activated.`,
      );
    }

    // Verify that question paper has been prepared and uploaded before activating
    if (this.prisma.examQuestion?.count) {
      const qCount = await this.prisma.examQuestion.count({
        where: { examId: schedule.examId },
      });
      if (qCount === 0) {
        throw new BadRequestException(
          'Cannot activate exam: No question paper has been uploaded or prepared for this exam yet. Please upload the question paper first.',
        );
      }
    }

    const activated = await this.prisma.$transaction(async (tx) => {
      // 1. Conditional atomic update for schedule
      const updatedSchedule = await tx.examSchedule.update({
        where: { id: scheduleId },
        data: {
          status: 'ACTIVE',
          activatedById: performedById,
          activatedAt: new Date(),
        },
      });

      // 2. Transition Exam to ACTIVE
      const activeStatus = await this.lifecycleService.getOrCreateExamStatus(
        'ACTIVE',
        tx,
      );

      await tx.exam.update({
        where: { id: schedule.examId },
        data: {
          statusId: activeStatus.id,
          activatedAt: new Date(),
        },
      });

      // 3. Record audit trail
      await this.lifecycleService.recordHistory(
        {
          examId: schedule.examId,
          examVersionId: schedule.examVersionId,
          scheduleId: schedule.id,
          action: 'ACTIVATE',
          fromStatus: 'SCHEDULED',
          toStatus: 'ACTIVE',
          performedById,
          comment: 'Super Admin activated the exam.',
          metadata: {
            activatedAt: new Date().toISOString(),
            startTime: schedule.startTime.toISOString(),
            endTime: schedule.endTime.toISOString(),
          },
        },
        tx,
      );

      this.logger.log(
        `Exam '${schedule.examId}' (Schedule: '${scheduleId}') activated by Super Admin '${performedById}'`,
      );

      // 4. Mark any pending approval request as APPROVED
      await tx.approvalRequest.updateMany({
        where: {
          resourceType: { in: ['EXAM', 'MOCK_TEST', 'MOCK'] },
          resourceId: schedule.examId,
          status: 'PENDING',
        },
        data: {
          status: 'APPROVED',
          reviewedById: performedById,
          reviewedAt: new Date(),
        },
      });

      return {
        message: 'Exam successfully activated by Super Admin.',
        schedule: updatedSchedule,
      };
    }, { maxWait: 10000, timeout: 30000 });

    // Asynchronously dispatch BullMQ notification job for activation
    this.notificationQueue.dispatchExamNotificationJob({
      type: 'EXAM_STARTING_SOON',
      examId: schedule.examId,
      scheduleId,
    });

    return activated;
  }

  /**
   * Get current active or scheduled schedule for an exam
   */
  async getExamSchedule(examId: string) {
    const schedule = await this.prisma.examSchedule.findFirst({
      where: {
        examId,
        status: { in: ['ACTIVE', 'SCHEDULED'] },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        examVersion: {
          select: {
            id: true,
            versionNumber: true,
            status: true,
            totalQuestions: true,
          },
        },
        scheduledBy: { select: { id: true, email: true } },
        activatedBy: { select: { id: true, email: true } },
      },
    });

    if (!schedule) {
      throw new NotFoundException(
        `No active or scheduled schedule found for Exam '${examId}'`,
      );
    }

    return schedule;
  }

  /**
   * Get Approved Live Exams Awaiting Scheduling for Super Admin
   */
  async getSchedulingCandidates(query?: { search?: string; subjectId?: string }) {
    const approvedStatus = await this.prisma.examStatus.findUnique({
      where: { name: 'APPROVED' },
    });

    if (!approvedStatus) {
      return [];
    }

    const where: any = {
      statusId: approvedStatus.id,
    };

    if (query?.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
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
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
        },
        _count: {
          select: { examQuestions: true },
        },
      },
      orderBy: { approvedAt: 'desc' },
    });

    return exams.map((exam) => ({
      id: exam.id,
      title: exam.title,
      description: exam.description,
      examTarget: exam.examTarget?.name || 'General',
      durationMinutes: exam.durationMinutes,
      totalMarks: exam.totalMarks,
      totalQuestions: exam.totalQuestions || exam._count.examQuestions || 0,
      approvedAt: exam.approvedAt || exam.createdAt,
      createdAt: exam.createdAt,
      status: exam.status.name,
      subjects: exam.sections.map((s) => s.subject.name),
      latestVersion: exam.versions[0]
        ? {
            id: exam.versions[0].id,
            versionNumber: exam.versions[0].versionNumber,
            status: exam.versions[0].status,
          }
        : null,
    }));
  }

  /**
   * Super Admin activates Exam directly by examId: SCHEDULED -> ACTIVE
   */
  async activateExamDirectly(examId: string, performedById: string) {
    const schedule = await this.prisma.examSchedule.findFirst({
      where: { examId, status: 'SCHEDULED' },
      orderBy: { createdAt: 'desc' },
    });

    if (schedule) {
      return this.activateExam(schedule.id, performedById);
    }

    // If no explicit schedule record exists, transition exam directly to ACTIVE
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: { status: true },
    });

    if (!exam) {
      throw new NotFoundException(`Exam with ID '${examId}' not found`);
    }

    // Verify that question paper has been prepared and uploaded before activating
    if (this.prisma.examQuestion?.count) {
      const qCount = await this.prisma.examQuestion.count({
        where: { examId },
      });
      if (qCount === 0) {
        throw new BadRequestException(
          'Cannot activate exam: No question paper has been uploaded or prepared for this exam yet. Please upload the question paper first.',
        );
      }
    }

    const activeStatus = await this.lifecycleService.getOrCreateExamStatus('ACTIVE');

    await this.prisma.exam.update({
      where: { id: examId },
      data: {
        statusId: activeStatus.id,
        activatedAt: new Date(),
      },
    });

    await this.lifecycleService.recordHistory({
      examId,
      action: 'ACTIVATE',
      fromStatus: exam.status.name,
      toStatus: 'ACTIVE',
      performedById,
      comment: 'Exam activated directly by Super Admin',
    });

    return { message: 'Exam successfully activated by Super Admin.' };
  }

  /**
   * Helper to keep ExamCalendar synchronized whenever an exam schedule is created or updated
   */
  private async syncToCalendar(
    tx: any,
    examId: string,
    startTime: Date,
    endTime: Date,
    timezone: string = 'Asia/Kolkata',
    status: string = 'CONFIRMED',
    userId?: string,
  ) {
    try {
      const year = startTime.getFullYear();
      const academicYear = `${year}-${year + 1}`;
      let cycle = await tx.examCycle.findFirst({
        where: { academicYear },
      });
      if (!cycle) {
        cycle = await tx.examCycle.create({
          data: {
            name: `Academic Year ${academicYear}`,
            academicYear,
            startDate: new Date(`${year}-01-01T00:00:00.000Z`),
            endDate: new Date(`${year}-12-31T23:59:59.999Z`),
            status: 'ACTIVE',
            createdById: userId || '00000000-0000-0000-0000-000000000000',
          },
        });
      }

      const dateStr = startTime.toISOString().split('T')[0];
      const plannedDate = new Date(`${dateStr}T00:00:00.000Z`);

      const existingCal = await tx.examCalendar.findFirst({
        where: { examId },
      });

      if (existingCal) {
        await tx.examCalendar.update({
          where: { id: existingCal.id },
          data: {
            cycleId: cycle.id,
            plannedDate,
            plannedStartTime: startTime,
            plannedEndTime: endTime,
            timezone,
            status: status as any,
          },
        });
      } else {
        await tx.examCalendar.create({
          data: {
            cycleId: cycle.id,
            examId,
            plannedDate,
            plannedStartTime: startTime,
            plannedEndTime: endTime,
            timezone,
            status: status as any,
            scheduleVersion: 1,
          },
        });
      }
    } catch (err: any) {
      this.logger.warn(`Failed to sync ExamCalendar (non-fatal): ${err.message}`);
    }
  }
}
