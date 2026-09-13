import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { NotificationService } from '../services/notification.service';
import { NotificationTemplateService } from '../services/notification-template.service';
import {
  CreateNotificationTemplateDto,
  NotificationFilterDto,
} from '../dto/notification.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

export interface AdminActionAlert {
  id: string;
  category: 'QUESTION_PAPER' | 'ANSWER_KEY' | 'APPROVAL' | 'SYSTEM';
  type: string;
  title: string;
  message: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'INFO';
  link: string;
  actionText: string;
  resourceId?: string;
  scheduleId?: string;
  examId?: string;
  startTime?: string;
  endTime?: string;
  hoursRemaining?: number;
  createdAt: string;
}

@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminNotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly templateService: NotificationTemplateService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'ACCOUNTANT', 'SALES_AGENT')
  async getNotifications(@Query() filter: NotificationFilterDto) {
    return this.notificationService.getNotifications(filter);
  }

  /**
   * GET /admin/notifications/action-alerts
   * Real-time computed action items & operational notifications for Super Admin
   */
  @Get('action-alerts')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getActionAlerts(): Promise<{
    alerts: AdminActionAlert[];
    summary: {
      total: number;
      questionPapersPending: number;
      answerKeysPending: number;
      approvalsPending: number;
    };
  }> {
    const now = new Date();
    const alerts: AdminActionAlert[] = [];

    // 1. Fetch upcoming scheduled exams that are missing question paper or AI translations
    const upcomingSchedules = await this.prisma.examSchedule.findMany({
      where: {
        status: { in: ['SCHEDULED', 'ACTIVE', 'RESCHEDULED'] },
      },
      include: {
        exam: {
          include: {
            examQuestions: { select: { id: true } },
          },
        },
      },
      orderBy: { startTime: 'asc' },
    });

    const examIds = upcomingSchedules.map((s) => s.examId);
    const translationJobs = await this.prisma.aiTranslationJob.findMany({
      where: { examId: { in: examIds } },
    });
    const jobExamSet = new Set(translationJobs.map((j) => j.examId));

    let qpCount = 0;
    for (const s of upcomingSchedules) {
      if (!s.exam) continue;

      const hasQuestions = (s.exam.examQuestions && s.exam.examQuestions.length > 0);
      const hasJob = jobExamSet.has(s.examId);

      // If no questions uploaded or translation not initiated
      if (!hasQuestions || !hasJob) {
        const diffMs = new Date(s.startTime).getTime() - now.getTime();
        const hoursRemaining = Math.max(0, Math.round(diffMs / (1000 * 60 * 60)));
        const isWithin24h = hoursRemaining <= 24;

        qpCount++;
        alerts.push({
          id: `qp-${s.id}`,
          category: 'QUESTION_PAPER',
          type: 'QUESTION_PAPER_PENDING',
          title:
            isWithin24h
              ? `${Math.max(1, hoursRemaining)}h remaining to start "${s.exam.title}" - Please upload question paper`
              : `Upcoming Exam "${s.exam.title}" - Please upload question paper`,
          message: `Exam schedule starts on ${new Date(s.startTime).toLocaleDateString()} at ${new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Question paper and regional language translations are pending.`,
          priority: isWithin24h ? 'CRITICAL' : 'HIGH',
          link: `/super-admin/ai-question-paper-translation?scheduleId=${s.id}`,
          actionText: 'Upload Question Paper',
          scheduleId: s.id,
          examId: s.examId,
          startTime: s.startTime ? new Date(s.startTime).toISOString() : undefined,
          hoursRemaining,
          createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : new Date().toISOString(),
        });
      }
    }

    // 2. Fetch pending approval requests
    const pendingApprovals = await this.prisma.approvalRequest.findMany({
      where: {
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    let appCount = 0;
    for (const ar of pendingApprovals) {
      appCount++;
      alerts.push({
        id: `app-${ar.id}`,
        category: 'APPROVAL',
        type: 'APPROVAL_REQUEST',
        title: `Approval Request: ${ar.resourceType || 'Item'} pending review - Please checkout`,
        message: `A new ${ar.resourceType || 'submission'} approval request is waiting for Super Admin review. Click to verify and take action.`,
        priority: 'HIGH',
        link: '/super-admin/approval-queue',
        actionText: 'Review Approval',
        resourceId: ar.resourceId,
        createdAt: ar.createdAt ? new Date(ar.createdAt).toISOString() : new Date().toISOString(),
      });
    }

    // Sort by priority (CRITICAL first, then HIGH, then newest)
    alerts.sort((a, b) => {
      const pWeight: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, INFO: 1 };
      const diff = (pWeight[b.priority] || 0) - (pWeight[a.priority] || 0);
      if (diff !== 0) return diff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return {
      alerts,
      summary: {
        total: alerts.length,
        questionPapersPending: qpCount,
        answerKeysPending: 0,
        approvalsPending: appCount,
      },
    };
  }

  @Get('templates')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'ACCOUNTANT', 'SALES_AGENT')
  async getTemplates() {
    return this.prisma.notificationTemplate.findMany({
      orderBy: [{ notificationType: 'asc' }, { version: 'desc' }],
    });
  }

  @Post('templates')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER')
  async createTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.templateService.saveTemplate(dto);
  }
}
