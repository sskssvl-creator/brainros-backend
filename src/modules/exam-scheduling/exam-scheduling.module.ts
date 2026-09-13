import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';
import { AdminModule } from '../admin/admin.module';
import {
  EXAM_WINDOW_END_QUEUE_NAME,
  EVALUATION_QUEUE_NAME,
} from '../result/interfaces/result-lifecycle.interface';
import { WHATSAPP_REMINDER_QUEUE_NAME } from '../notification/interfaces/exam-notification-job.interface';

// Existing Services
import { ExamLifecycleService } from './services/exam-lifecycle.service';
import { ExamScheduleService } from './services/exam-schedule.service';
import { ExamAccessService } from './services/exam-access.service';

// New Calendar & Activation Services
import { ExamCycleService } from './services/exam-cycle.service';
import { ExamCalendarService } from './services/exam-calendar.service';
import { ScheduleReminderService } from './services/schedule-reminder.service';
import { FeatureActivationService } from './services/feature-activation.service';

// Controllers
import { ExamSchedulingController } from './controllers/exam-scheduling.controller';
import { ExamCycleController } from './controllers/exam-cycle.controller';
import { ExamCalendarController } from './controllers/exam-calendar.controller';
import { FeatureActivationController } from './controllers/feature-activation.controller';
import { ExamCacheModule } from '../exam-cache/exam-cache.module';

@Module({
  imports: [
    PrismaModule,
    NotificationModule,
    forwardRef(() => AdminModule),
    ExamCacheModule,
    BullModule.registerQueue(
      { name: EXAM_WINDOW_END_QUEUE_NAME },
      { name: EVALUATION_QUEUE_NAME },
      // WhatsApp reminder queue — needed by ScheduleReminderService via @InjectQueue
      { name: WHATSAPP_REMINDER_QUEUE_NAME },
    ),
  ],
  controllers: [
    ExamSchedulingController,
    ExamCycleController,
    ExamCalendarController,
    FeatureActivationController,
  ],
  providers: [
    ExamLifecycleService,
    ExamScheduleService,
    ExamAccessService,
    ExamCycleService,
    ExamCalendarService,
    ScheduleReminderService,
    FeatureActivationService,
  ],
  exports: [
    ExamLifecycleService,
    ExamScheduleService,
    ExamAccessService,
    ExamCycleService,
    ExamCalendarService,
    ScheduleReminderService,
    FeatureActivationService,
  ],
})
export class ExamSchedulingModule {}
