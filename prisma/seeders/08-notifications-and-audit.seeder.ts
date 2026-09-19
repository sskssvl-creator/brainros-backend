import { SeedContext, SeederResult } from './types';
import {
  NotificationChannel,
  NotificationType,
  NotificationStatus,
  NotificationPriority,
  ReportType,
  ReportFormat,
  ReportJobStatus,
  FeatureCode,
} from '@prisma/client';

export async function seedNotificationsAndAudit(ctx: SeedContext): Promise<SeederResult> {
  const start = Date.now();
  const created: Record<string, number> = {};
  const reused: Record<string, number> = {};

  const inc = (type: string, isNew: boolean) => {
    if (isNew) created[type] = (created[type] || 0) + 1;
    else reused[type] = (reused[type] || 0) + 1;
  };

  const { prisma } = ctx;
  const superAdmin = ctx.users.get('superadmin@brainros.test')!;
  const instAllen = ctx.institutions.get('INST_ALLEN')!;

  // 1. Notification Preferences & Notification Logs for Students
  const studentsList = Array.from(ctx.students.values()).slice(0, 10);

  for (const st of studentsList) {
    const existingNp = await prisma.notificationPreference.findFirst({
      where: {
        userId: st.userId,
        notificationType: NotificationType.RESULT_AVAILABLE,
        channel: NotificationChannel.EMAIL,
      },
    });
    if (existingNp) {
      await prisma.notificationPreference.update({
        where: { id: existingNp.id },
        data: { enabled: true },
      });
      inc('notification_preferences', false);
    } else {
      await prisma.notificationPreference.create({
        data: {
          userId: st.userId,
          notificationType: NotificationType.RESULT_AVAILABLE,
          channel: NotificationChannel.EMAIL,
          enabled: true,
        },
      });
      inc('notification_preferences', true);
    }

    // Mock Sent Notification (Scorecard)
    const notification = await prisma.notification.create({
      data: {
        recipientUserId: st.userId,
        recipientAddress: `student${st.studentId}@brainros.test`,
        channel: NotificationChannel.EMAIL,
        type: NotificationType.RESULT_AVAILABLE,
        payload: {
          studentName: st.name,
          examTitle: 'NEET Grand Mock Test 01',
          score: 68,
          maxScore: 80,
        },
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.DELIVERED,
        sentAt: new Date('2026-04-10T12:00:00Z'),
      },
    });
    inc('notifications', true);

    // Delivery Log
    await prisma.notificationLog.create({
      data: {
        notificationId: notification.id,
        channel: NotificationChannel.EMAIL,
        provider: 'DEV_MOCK_PROVIDER',
        providerMessageId: `msg_${notification.id}`,
        attemptNumber: 1,
        status: NotificationStatus.DELIVERED,
        requestTime: new Date('2026-04-10T12:00:00Z'),
        responseTime: new Date('2026-04-10T12:00:01Z'),
      },
    });
    inc('notification_logs', true);
  }

  // 2. Report Jobs for B2B Institutions
  const reportTypes = [
    ReportType.STUDENT_WISE,
    ReportType.BATCH_WISE,
    ReportType.SUBJECT_ANALYSIS,
    ReportType.RANK_LIST,
  ];

  for (const rType of reportTypes) {
    await prisma.reportJob.create({
      data: {
        institutionId: instAllen.id,
        requestedById: superAdmin.id,
        reportType: rType,
        format: ReportFormat.XLSX,
        status: ReportJobStatus.COMPLETED,
        progress: 100,
        fileName: `${instAllen.code}_${rType}_Report.xlsx`,
        fileSize: 1024 * 150,
        storageKey: `reports/mock/${instAllen.code}_${rType}.xlsx`,
        startedAt: new Date('2026-04-11T08:00:00Z'),
        completedAt: new Date('2026-04-11T08:02:00Z'),
      },
    });
    inc('report_jobs', true);
  }

  // 3. Platform Audit Logs
  const auditActions = [
    { action: 'ACTIVATE_EXAM', entityType: 'EXAM', entityId: 'EXAM_NEET_MOCK_01', reason: 'Official schedule commenced' },
    { action: 'APPROVE_INSTITUTION', entityType: 'INSTITUTION', entityId: 'INST_ALLEN', reason: 'Verified B2B onboarding agreement' },
    { action: 'BULK_ACTIVATE', entityType: 'BULK_UPLOAD', entityId: 'BATCH_NEET_ALPHA', reason: 'Student roster validated with 0 errors' },
    { action: 'PUBLISH_RANK_SNAPSHOT', entityType: 'RANK_SNAPSHOT', entityId: 'SNAPSHOT_v1', reason: 'All candidate scores reconciled' },
  ];

  for (const a of auditActions) {
    await prisma.auditLog.create({
      data: {
        actorUserId: superAdmin.id,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        reason: a.reason,
        ipAddress: '127.0.0.1',
        userAgent: 'Brainros Admin Console / Chrome 130',
      },
    });
    inc('audit_logs', true);
  }

  // 4. Feature Activations
  const features = [
    FeatureCode.EXAM_ACCESS,
    FeatureCode.RESULT_ACCESS,
    FeatureCode.RANKING,
    FeatureCode.PREDICTED_RANK,
    FeatureCode.PARENT_ACCESS,
    FeatureCode.INSTITUTION_REPORTS,
  ];

  for (const f of features) {
    const existingFa = await prisma.featureActivation.findFirst({
      where: {
        featureCode: f,
        targetType: 'GLOBAL',
        targetId: 'GLOBAL',
      },
    });
    if (existingFa) {
      await prisma.featureActivation.update({
        where: { id: existingFa.id },
        data: { isActive: true },
      });
      inc('feature_activations', false);
    } else {
      await prisma.featureActivation.create({
        data: {
          featureCode: f,
          targetType: 'GLOBAL',
          targetId: 'GLOBAL',
          isActive: true,
          activatedById: superAdmin.id,
          activatedAt: new Date(),
          reason: 'Default platform activation for test/dev environment',
        },
      });
      inc('feature_activations', true);
    }
  }

  return {
    seederName: 'NotificationsAndAuditSeeder',
    createdCounts: created,
    reusedCounts: reused,
    timeMs: Date.now() - start,
  };
}
