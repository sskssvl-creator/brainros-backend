import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ScheduleReminderService } from './schedule-reminder.service';
import { RedisService } from '../../redis/redis.service';
import {
  CreateExamCalendarEventDto,
  UpdateCalendarEventDto,
  RescheduleCalendarEventDto,
  CalendarFilterDto,
} from '../dto/calendar.dto';

@Injectable()
export class ExamCalendarService {
  private readonly logger = new Logger(ExamCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly reminderService?: ScheduleReminderService,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async syncExamAndSchedule(
    examId: string,
    plannedDate: Date,
    startTime: Date,
    endTime: Date,
    timezone?: string,
  ): Promise<void> {
    try {
      // 1. Update Exam record with the new schedule window
      await this.prisma.exam.update({
        where: { id: examId },
        data: {
          examDate: plannedDate,
          startTime,
          endTime,
        },
      });

      // 2. Update existing active/scheduled/rescheduled schedule records if present
      const schedules = await this.prisma.examSchedule.findMany({
        where: {
          examId,
          status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const schedule of schedules) {
        await this.prisma.examSchedule.update({
          where: { id: schedule.id },
          data: {
            startTime,
            endTime,
            timezone: timezone || schedule.timezone || 'Asia/Kolkata',
          },
        });
      }

      // 3. Invalidate Redis student dashboard cache
      if (this.redisService?.delByPattern) {
        await this.redisService.delByPattern('student:*:dashboard');
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to sync calendar event to exam/schedule for '${examId}': ${err.message}`,
      );
    }
  }

  private computeEndTime(start: Date, durationMinutes: number): Date {
    return new Date(start.getTime() + durationMinutes * 60_000);
  }

  private async getOrCreateDefaultCycle(year: number, userId?: string) {
    const academicYear = `${year}-${year + 1}`;
    let cycle = await this.prisma.examCycle.findFirst({
      where: { academicYear },
    });
    if (!cycle) {
      cycle = await this.prisma.examCycle.create({
        data: {
          name: `Academic Year ${academicYear}`,
          academicYear,
          startDate: new Date(`${year}-01-01`),
          endDate: new Date(`${year}-12-31`),
          status: 'ACTIVE',
          createdById: userId || '00000000-0000-0000-0000-000000000000',
        },
      });
      this.logger.log(`Auto-created exam cycle for ${academicYear}`);
    }
    return cycle;
  }

  private async writeAuditLog(params: {
    actorUserId?: string;
    action: string;
    entityId: string;
    beforeState?: object;
    afterState?: object;
    reason?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: params.actorUserId || undefined,
          action: params.action,
          entityType: 'ExamCalendar',
          entityId: params.entityId,
          beforeState: params.beforeState || undefined,
          afterState: params.afterState || undefined,
          reason: params.reason || undefined,
        },
      });
    } catch (err) {
      this.logger.warn('AuditLog write failed (non-fatal): ' + err?.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Available years (for the year-filter dropdown)
  // ─────────────────────────────────────────────────────────────────────────────

  async getAvailableYears(): Promise<number[]> {
    const events = await this.prisma.examCalendar.findMany({
      select: { plannedDate: true },
      distinct: ['plannedDate'],
    });

    const yearSet = new Set<number>();
    const currentYear = new Date().getFullYear();
    yearSet.add(currentYear);
    yearSet.add(currentYear - 1);
    yearSet.add(currentYear + 1);

    events.forEach((e) => {
      yearSet.add(new Date(e.plannedDate).getFullYear());
    });

    // Also ensure years from existing cycles are included
    const cycles = await this.prisma.examCycle.findMany({
      select: { academicYear: true },
    });
    cycles.forEach((c) => {
      const parts = c.academicYear.split('-');
      if (parts[0]) yearSet.add(Number(parts[0]));
    });

    return Array.from(yearSet).sort((a, b) => b - a); // newest first
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Create
  // ─────────────────────────────────────────────────────────────────────────────

  async createCalendarEvent(
    dto: CreateExamCalendarEventDto,
    actorUserId?: string,
  ) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: dto.examId },
    });
    if (!exam) {
      throw new NotFoundException(`Exam '${dto.examId}' not found.`);
    }

    const start = new Date(dto.plannedStartTime);

    // Calculate end time from durationMinutes or fall back to explicit endTime
    let end: Date;
    if (dto.durationMinutes && dto.durationMinutes > 0) {
      end = this.computeEndTime(start, dto.durationMinutes);
    } else if (dto.plannedEndTime) {
      end = new Date(dto.plannedEndTime);
    } else {
      // Use exam duration as fallback
      end = this.computeEndTime(start, exam.durationMinutes || 180);
    }

    if (start >= end) {
      throw new BadRequestException(
        'plannedStartTime must be strictly before plannedEndTime.',
      );
    }

    const plannedDate = new Date(dto.plannedDate);

    // Validate year consistency
    const startYear = new Date(dto.plannedStartTime).getFullYear();
    const dateYear = plannedDate.getFullYear();
    if (startYear !== dateYear) {
      throw new BadRequestException(
        `Year mismatch: plannedDate year (${dateYear}) does not match plannedStartTime year (${startYear}).`,
      );
    }

    // Resolve or create cycle for this year
    let cycle: { id: string; startDate: Date; endDate: Date };
    if (dto.cycleId) {
      const found = await this.prisma.examCycle.findUnique({
        where: { id: dto.cycleId },
      });
      if (!found) throw new NotFoundException(`Exam cycle '${dto.cycleId}' not found.`);
      cycle = found;
    } else {
      cycle = await this.getOrCreateDefaultCycle(startYear, actorUserId);
    }

    // Date within cycle window check
    if (plannedDate < cycle.startDate || plannedDate > cycle.endDate) {
      if (dto.cycleId) {
        throw new BadRequestException(
          `plannedDate ${plannedDate.toISOString()} is outside the cycle window (${cycle.startDate.toISOString()} to ${cycle.endDate.toISOString()}).`,
        );
      }
      // Widen the cycle window if the date is out of bounds (auto-fix)
      this.logger.warn(
        `plannedDate ${plannedDate.toISOString()} is outside cycle window. Auto-adjusting cycle window.`,
      );
      if (this.prisma.examCycle?.update) {
        await this.prisma.examCycle.update({
          where: { id: cycle.id },
          data: {
            startDate: plannedDate < cycle.startDate ? plannedDate : cycle.startDate,
            endDate: plannedDate > cycle.endDate ? plannedDate : cycle.endDate,
          },
        });
      }
    }

    // Overlap / conflict detection (warn only, don't block)
    const overlapping = await this.prisma.examCalendar.findFirst({
      where: {
        examId: dto.examId,
        status: { notIn: ['CANCELLED'] },
        OR: [
          { plannedStartTime: { lte: start }, plannedEndTime: { gt: start } },
          { plannedStartTime: { lt: end }, plannedEndTime: { gte: end } },
          { plannedStartTime: { gte: start }, plannedEndTime: { lte: end } },
        ],
      },
      include: { exam: { select: { title: true } } },
    });

    if (overlapping) {
      throw new BadRequestException(
        `This exam already has a conflicting calendar entry during the selected time window. ` +
          `Please choose a different date/time or resolve the conflict first.`,
      );
    }

    const event = await this.prisma.examCalendar.create({
      data: {
        cycleId: cycle.id,
        examId: dto.examId,
        plannedDate,
        plannedStartTime: start,
        plannedEndTime: end,
        timezone: dto.timezone || 'Asia/Kolkata',
        status: 'CONFIRMED',
        notes: dto.notes || null,
        scheduleVersion: 1,
      },
      include: {
        exam: { select: { id: true, title: true, durationMinutes: true } },
        cycle: { select: { id: true, name: true } },
      },
    });

    await this.writeAuditLog({
      actorUserId,
      action: 'ACADEMIC_CALENDAR_CREATE',
      entityId: event.id,
      afterState: {
        examId: event.examId,
        plannedDate: event.plannedDate,
        plannedStartTime: event.plannedStartTime,
        plannedEndTime: event.plannedEndTime,
        status: event.status,
      },
    });

    if ((this.reminderService as any)?.scheduleExamReminders) {
      try {
        await (this.reminderService as any).scheduleExamReminders(event);
      } catch (remErr) {
        this.logger.warn(`Failed to schedule reminders for calendar event: ${remErr?.message}`);
      }
    }

    await this.syncExamAndSchedule(
      event.examId,
      event.plannedDate,
      event.plannedStartTime,
      event.plannedEndTime,
      event.timezone,
    );

    return event;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Update
  // ─────────────────────────────────────────────────────────────────────────────

  async updateCalendarEvent(
    eventId: string,
    dto: UpdateCalendarEventDto,
    actorUserId?: string,
  ) {
    const existing = await this.prisma.examCalendar.findUnique({
      where: { id: eventId },
      include: { exam: true },
    });
    if (!existing) {
      throw new NotFoundException(`Calendar event '${eventId}' not found.`);
    }

    // Block edits on completed/cancelled or ended window
    if (['COMPLETED', 'CANCELLED', 'ENDED', 'EXPIRED'].includes(existing.status)) {
      throw new BadRequestException(
        `Cannot edit a calendar event in status '${existing.status}'.`,
      );
    }
    if (existing.plannedEndTime && new Date() > new Date(existing.plannedEndTime)) {
      throw new BadRequestException(
        'Cannot edit a calendar event whose exam window has ended.',
      );
    }

    const newExamId = dto.examId || existing.examId;
    const rawStart = dto.plannedStartTime
      ? new Date(dto.plannedStartTime)
      : existing.plannedStartTime;
    const rawDate = dto.plannedDate
      ? new Date(dto.plannedDate)
      : existing.plannedDate;

    let newEnd: Date;
    if (dto.durationMinutes && dto.durationMinutes > 0) {
      newEnd = this.computeEndTime(rawStart, dto.durationMinutes);
    } else if (dto.plannedEndTime) {
      newEnd = new Date(dto.plannedEndTime);
    } else {
      newEnd = existing.plannedEndTime;
    }

    if (rawStart >= newEnd) {
      throw new BadRequestException(
        'plannedStartTime must be strictly before plannedEndTime.',
      );
    }

    // Check overlap (excluding self)
    const overlapping = await this.prisma.examCalendar.findFirst({
      where: {
        id: { not: eventId },
        examId: newExamId,
        status: { notIn: ['CANCELLED'] },
        OR: [
          { plannedStartTime: { lte: rawStart }, plannedEndTime: { gt: rawStart } },
          { plannedStartTime: { lt: newEnd }, plannedEndTime: { gte: newEnd } },
          { plannedStartTime: { gte: rawStart }, plannedEndTime: { lte: newEnd } },
        ],
      },
    });

    if (overlapping) {
      throw new BadRequestException(
        'The updated schedule conflicts with an existing calendar entry for this exam.',
      );
    }

    const beforeState = {
      examId: existing.examId,
      plannedDate: existing.plannedDate,
      plannedStartTime: existing.plannedStartTime,
      plannedEndTime: existing.plannedEndTime,
      status: existing.status,
    };

    const updated = await this.prisma.examCalendar.update({
      where: { id: eventId },
      data: {
        examId: newExamId,
        plannedDate: rawDate,
        plannedStartTime: rawStart,
        plannedEndTime: newEnd,
        timezone: dto.timezone || existing.timezone,
        notes: dto.notes !== undefined ? dto.notes : existing.notes,
        scheduleVersion: existing.scheduleVersion + 1,
        status: 'RESCHEDULED',
      },
      include: {
        exam: { select: { id: true, title: true, durationMinutes: true } },
        cycle: { select: { id: true, name: true } },
      },
    });

    await this.writeAuditLog({
      actorUserId,
      action: 'ACADEMIC_CALENDAR_UPDATE',
      entityId: eventId,
      beforeState,
      afterState: {
        examId: updated.examId,
        plannedDate: updated.plannedDate,
        plannedStartTime: updated.plannedStartTime,
        plannedEndTime: updated.plannedEndTime,
        status: updated.status,
      },
    });

    await this.syncExamAndSchedule(
      updated.examId,
      updated.plannedDate,
      updated.plannedStartTime,
      updated.plannedEndTime,
      updated.timezone,
    );

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Delete (calendar entry only — does NOT delete Exam)
  // ─────────────────────────────────────────────────────────────────────────────

  async deleteCalendarEvent(eventId: string, actorUserId?: string) {
    const existing = await this.prisma.examCalendar.findUnique({
      where: { id: eventId },
      include: { exam: { select: { id: true, title: true } } },
    });
    if (!existing) {
      throw new NotFoundException(`Calendar event '${eventId}' not found.`);
    }

    if (['COMPLETED', 'CONFIRMED'].includes(existing.status)) {
      // Allow delete but log a warning
      this.logger.warn(
        `Deleting calendar event ${eventId} that is in status '${existing.status}'.`,
      );
    }

    await this.prisma.examCalendar.delete({ where: { id: eventId } });

    await this.writeAuditLog({
      actorUserId,
      action: 'ACADEMIC_CALENDAR_DELETE',
      entityId: eventId,
      beforeState: {
        examId: existing.examId,
        examTitle: existing.exam?.title,
        plannedDate: existing.plannedDate,
        plannedStartTime: existing.plannedStartTime,
        status: existing.status,
      },
    });

    return { deleted: true, id: eventId };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reschedule (legacy)
  // ─────────────────────────────────────────────────────────────────────────────

  async rescheduleEvent(
    eventId: string,
    dto: RescheduleCalendarEventDto,
    actorUserId: string,
  ) {
    const existing = await this.prisma.examCalendar.findUnique({
      where: { id: eventId },
      include: { exam: true },
    });

    if (!existing) {
      throw new NotFoundException(`Calendar event '${eventId}' not found.`);
    }

    const newStart = new Date(dto.plannedStartTime);
    const newEnd = new Date(dto.plannedEndTime);
    const newPlannedDate = new Date(dto.plannedDate);

    if (newStart >= newEnd) {
      throw new BadRequestException(
        'plannedStartTime must be strictly before plannedEndTime.',
      );
    }

    const newVersion = existing.scheduleVersion + 1;

    const updated = await this.prisma.examCalendar.update({
      where: { id: eventId },
      data: {
        plannedDate: newPlannedDate,
        plannedStartTime: newStart,
        plannedEndTime: newEnd,
        timezone: dto.timezone || existing.timezone,
        status: 'RESCHEDULED',
        scheduleVersion: newVersion,
        notes: dto.reason,
      },
      include: { exam: true, cycle: true },
    });

    if ((this.reminderService as any)?.handleExamRescheduled) {
      try {
        await (this.reminderService as any).handleExamRescheduled(
          updated,
          existing.scheduleVersion,
        );
      } catch (reschedErr) {
        this.logger.warn(`Failed to handle rescheduled reminders: ${reschedErr?.message}`);
      }
    }

    await this.syncExamAndSchedule(
      updated.examId,
      updated.plannedDate,
      updated.plannedStartTime,
      updated.plannedEndTime,
      updated.timezone,
    );

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // List (with year-based filter)
  // ─────────────────────────────────────────────────────────────────────────────

  async getCalendarEvents(filter: CalendarFilterDto) {
    const page = filter.page ? Math.max(1, Number(filter.page)) : 1;
    const limit = filter.limit ? Math.min(500, Math.max(1, Number(filter.limit))) : 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filter.cycleId) where.cycleId = filter.cycleId;
    if (filter.examId) where.examId = filter.examId;
    if (filter.status) where.status = filter.status;

    // Year filter: derive date range from year
    if (filter.year) {
      where.plannedDate = {
        gte: new Date(`${filter.year}-01-01T00:00:00.000Z`),
        lte: new Date(`${filter.year}-12-31T23:59:59.999Z`),
      };
    } else if (filter.from || filter.to) {
      where.plannedDate = {};
      if (filter.from) where.plannedDate.gte = new Date(filter.from);
      if (filter.to) where.plannedDate.lte = new Date(filter.to);
    }

    // Search by exam title
    if (filter.search) {
      where.exam = {
        title: { contains: filter.search, mode: 'insensitive' },
      };
    }

    const [events, total] = await Promise.all([
      this.prisma.examCalendar.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ plannedDate: 'asc' }, { plannedStartTime: 'asc' }],
        include: {
          exam: {
            select: {
              id: true,
              title: true,
              durationMinutes: true,
              totalQuestions: true,
            },
          },
          cycle: { select: { id: true, name: true, academicYear: true } },
        },
      }),
      this.prisma.examCalendar.count({ where }),
    ]);

    return {
      data: events,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}
