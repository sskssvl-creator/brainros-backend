import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationType,
  NotificationPriority,
  NotificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationTemplateService } from './notification-template.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { ProviderRegistry } from '../providers/provider.registry';
import {
  SendNotificationOptions,
  NotificationPayload,
} from '../interfaces/notification.interface';
import { NotificationFilterDto } from '../dto/notification.dto';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templateService: NotificationTemplateService,
    private readonly preferenceService: NotificationPreferenceService,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Primary entrypoint to dispatch a notification asynchronously with complete failure isolation.
   */
  async sendNotification(options: SendNotificationOptions) {
    try {
      // 1. Preference check (Critical OTPs bypass preference check)
      const allowed = await this.preferenceService.isNotificationAllowed(
        options.recipientUserId,
        options.type,
        options.channel,
      );

      if (!allowed) {
        this.logger.debug(
          `Notification [${options.type}] to ${options.recipientAddress} on ${options.channel} skipped by user preference.`,
        );
        return { status: 'SKIPPED_BY_PREFERENCE' };
      }

      // 2. Resolve template
      const template = await this.templateService.resolveTemplate(
        options.type,
        options.channel,
        options.languageCode || 'en',
      );

      const renderedBody = template
        ? this.templateService.renderTemplate(template.body, options.variables)
        : JSON.stringify(options.variables);

      const renderedSubject = template?.subject
        ? this.templateService.renderTemplate(
            template.subject,
            options.variables,
          )
        : undefined;

      // 3. Idempotency & Deduplication Check
      if (options.idempotencyKey) {
        const existing = await this.prisma.notification.findUnique({
          where: { idempotencyKey: options.idempotencyKey },
        });
        if (existing) {
          this.logger.debug(
            `Duplicate notification detected for key '${options.idempotencyKey}'. Reusing.`,
          );
          return existing;
        }
      }

      const resolvedTitle =
        renderedSubject ||
        (options.variables as any)?.title ||
        (options.variables as any)?.subject ||
        null;
      const resolvedMessage =
        renderedBody || (options.variables as any)?.message || null;
      const resolvedData =
        (options.variables as any)?.data || (options.variables as any) || null;

      // 4. Create Notification record
      const notification = await this.prisma.notification.create({
        data: {
          userId: options.recipientUserId || null,
          recipientUserId: options.recipientUserId || null,
          recipientAddress: options.recipientAddress,
          channel: options.channel,
          type: options.type,
          title: resolvedTitle,
          message: resolvedMessage,
          data: resolvedData,
          templateId: template?.id || null,
          templateVersion: template?.version || 1,
          payload: options.variables as any,
          priority: options.priority || NotificationPriority.NORMAL,
          status: NotificationStatus.QUEUED,
          scheduledAt: options.scheduledAt || null,
          expiresAt: options.expiresAt || null,
          correlationId: options.correlationId || null,
          idempotencyKey: options.idempotencyKey || null,
          scheduleVersion: options.scheduleVersion || 1,
        },
      });

      // 5. Asynchronous dispatch (in-process or BullMQ worker)
      setImmediate(() => {
        this.processNotification(notification.id, {
          notificationId: notification.id,
          recipientUserId: notification.recipientUserId,
          recipientAddress: notification.recipientAddress || '',
          channel: notification.channel,
          type: notification.type,
          subject: renderedSubject,
          body: renderedBody,
          variables: options.variables,
          priority: notification.priority,
          correlationId: notification.correlationId || undefined,
          idempotencyKey: notification.idempotencyKey || undefined,
          scheduleVersion: notification.scheduleVersion,
        }).catch((err) => {
          this.logger.error(
            `Failed processing notification '${notification.id}': ${err.message}`,
          );
        });
      });

      return notification;
    } catch (err: any) {
      // Failure Isolation: Never crash caller on communication failure
      this.logger.error(
        `Zero-impact notification dispatch failure: ${err.message}`,
      );
      return { status: 'FAILED_TO_DISPATCH', error: err.message };
    }
  }

  /**
   * Process individual notification with provider execution, retry, and log generation.
   */
  async processNotification(
    notificationId: string,
    payload: NotificationPayload,
  ) {
    const provider = this.providerRegistry.getProvider(payload.channel);
    const requestTime = new Date();

    try {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.PROCESSING,
          attempts: { increment: 1 },
        },
      });

      const result = await provider.send(payload);
      const responseTime = new Date();

      if (result.success) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: NotificationStatus.SENT,
            sentAt: new Date(),
          },
        });

        await this.prisma.notificationLog.create({
          data: {
            notificationId,
            channel: payload.channel,
            provider: result.provider,
            providerMessageId: result.providerMessageId || null,
            attemptNumber: 1,
            status: NotificationStatus.SENT,
            requestTime,
            responseTime,
          },
        });
      } else {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: result.isRetryable
              ? NotificationStatus.RETRYING
              : NotificationStatus.FAILED,
            lastError: result.errorMessage,
          },
        });

        await this.prisma.notificationLog.create({
          data: {
            notificationId,
            channel: payload.channel,
            provider: result.provider,
            attemptNumber: 1,
            status: NotificationStatus.FAILED,
            requestTime,
            responseTime,
            errorCode: result.errorCode || 'UNKNOWN_ERROR',
            errorMessage: result.errorMessage || 'Failed to dispatch',
          },
        });
      }
    } catch (err: any) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.FAILED,
          lastError: err.message,
        },
      });

      await this.prisma.notificationLog.create({
        data: {
          notificationId,
          channel: payload.channel,
          provider: provider.providerName,
          attemptNumber: 1,
          status: NotificationStatus.FAILED,
          requestTime,
          responseTime: new Date(),
          errorCode: 'UNHANDLED_EXCEPTION',
          errorMessage: err.message,
        },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONVENIENCE BUSINESS EVENT DISPATCHERS
  // ═══════════════════════════════════════════════════════════════════

  async sendOtp(
    phone: string,
    otp: string,
    validMinutes = 10,
    userId?: string,
  ) {
    return this.sendNotification({
      recipientUserId: userId,
      recipientAddress: phone,
      channel: NotificationChannel.SMS,
      type: NotificationType.OTP,
      priority: NotificationPriority.CRITICAL,
      variables: { otp, validMinutes },
      idempotencyKey: `otp-${phone}-${Date.now()}`,
    });
  }

  async sendRegistrationConfirmation(user: {
    id: string;
    email?: string;
    phone?: string;
    name?: string;
  }) {
    if (user.email) {
      return this.sendNotification({
        recipientUserId: user.id,
        recipientAddress: user.email,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.REGISTRATION_CONFIRMATION,
        variables: { name: user.name || 'Student' },
      });
    }
  }

  async sendExamScheduled(exam: any, student: any, timezone = 'Asia/Kolkata') {
    if (student.email) {
      return this.sendNotification({
        recipientUserId: student.userId,
        recipientAddress: student.email,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.EXAM_SCHEDULED,
        variables: {
          studentName: student.name,
          examTitle: exam.title,
          plannedDate: exam.plannedDate || 'Upcoming',
          startTime: exam.startTime || '10:00 AM',
          timezone,
        },
        idempotencyKey: `exam-sched-${exam.id}-${student.id}`,
      });
    }
  }

  async sendExamReminder(
    exam: any,
    student: any,
    startsIn: string,
    scheduleVersion = 1,
  ) {
    return this.sendNotification({
      recipientUserId: student.userId,
      recipientAddress: student.deviceToken || student.email || 'device-token',
      channel: student.deviceToken
        ? NotificationChannel.PUSH
        : NotificationChannel.EMAIL,
      type: NotificationType.EXAM_REMINDER,
      priority: NotificationPriority.HIGH,
      variables: {
        examTitle: exam.title,
        startsIn,
      },
      scheduleVersion,
      idempotencyKey: `exam-remind-${exam.id}-${student.id}-${startsIn}-v${scheduleVersion}`,
    });
  }

  async sendResultAvailable(exam: any, student: any) {
    if (student.email) {
      return this.sendNotification({
        recipientUserId: student.userId,
        recipientAddress: student.email,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.RESULT_AVAILABLE,
        variables: {
          studentName: student.name,
          examTitle: exam.title,
        },
        idempotencyKey: `result-avail-${exam.id}-${student.id}`,
      });
    }
  }

  async sendReportReady(user: any, fileName: string) {
    if (user.email) {
      return this.sendNotification({
        recipientUserId: user.id,
        recipientAddress: user.email,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.REPORT_READY,
        variables: {
          name: user.name || 'User',
          fileName,
        },
      });
    }
  }

  /**
   * Query delivery logs and notification status for admin telemetry
   */
  async getNotifications(filter: NotificationFilterDto) {
    const page = filter.page || 1;
    const limit = filter.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filter.type) where.type = filter.type;
    if (filter.channel) where.channel = filter.channel;
    if (filter.status) where.status = filter.status;
    if (filter.recipientUserId) where.recipientUserId = filter.recipientUserId;

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { logs: { orderBy: { createdAt: 'desc' }, take: 3 } },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // STUDENT / USER IN-APP NOTIFICATION METHODS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get paginated notifications for the authenticated user
   */
  async getUserNotifications(
    userId: string,
    query: { page?: number; limit?: number; unreadOnly?: boolean },
  ) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;
    const skip = (page - 1) * limit;

    const where: any = {
      OR: [{ userId }, { recipientUserId: userId }],
    };

    if (query.unreadOnly) {
      where.isRead = false;
    }

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userId: true,
          type: true,
          title: true,
          message: true,
          data: true,
          isRead: true,
          readAt: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Get live unread notification count for the authenticated user
   */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: {
        OR: [{ userId }, { recipientUserId: userId }],
        isRead: false,
      },
    });

    return { count };
  }

  /**
   * Get single most recent unread notification for the authenticated user
   */
  async getRecentUnread(userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        OR: [{ userId }, { recipientUserId: userId }],
        isRead: false,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        type: true,
        title: true,
        message: true,
        data: true,
        isRead: true,
        readAt: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return notification || null;
  }

  /**
   * Mark a single notification as read (idempotent, ownership validated)
   */
  async markAsRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      return { success: false, message: 'Notification not found' };
    }

    if (
      notification.userId !== userId &&
      notification.recipientUserId !== userId
    ) {
      return { success: false, message: 'Unauthorized' };
    }

    if (notification.isRead) {
      return { success: true, notification };
    }

    const updated = await this.prisma.notification.update({
      where: { id },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { success: true, notification: updated };
  }

  /**
   * Mark all unread notifications as read for the authenticated user
   */
  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        OR: [{ userId }, { recipientUserId: userId }],
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return {
      success: true,
      updatedCount: result.count,
    };
  }

  /**
   * Delete a notification (ownership validated)
   */
  async deleteNotification(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      return { success: false, message: 'Notification not found' };
    }

    if (
      notification.userId !== userId &&
      notification.recipientUserId !== userId
    ) {
      return { success: false, message: 'Unauthorized' };
    }

    await this.prisma.notification.delete({
      where: { id },
    });

    return { success: true };
  }
}

