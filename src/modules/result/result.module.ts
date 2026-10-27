import { Module, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ResultController } from './result.controller';
import { ExamPublicationController } from './controllers/exam-publication.controller';
import { ResultService } from './result.service';
import { AnalysisEngineService } from './services/analysis-engine.service';
import { ResultReadinessService } from './services/result-readiness.service';
import { ResultAccessService } from './services/result-access.service';
import { ExamPublicationService } from './services/exam-publication.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RankEngineModule } from '../rank-engine/rank-engine.module';
import { ExamSchedulingModule } from '../exam-scheduling/exam-scheduling.module';
import { NotificationModule } from '../notification/notification.module';
import { TimeAnalysisModule } from '../time-analysis/time-analysis.module';
import { AttemptStrategyModule } from '../attempt-strategy/attempt-strategy.module';
import { AdminModule } from '../admin/admin.module';
import {
  EVALUATION_QUEUE_NAME,
  ANALYTICS_QUEUE_NAME,
  RANKING_QUEUE_NAME,
  RECONCILIATION_QUEUE_NAME,
  EXAM_WINDOW_END_QUEUE_NAME,
} from './interfaces/result-lifecycle.interface';
import { NOTIFICATION_QUEUE_NAME, WHATSAPP_REMINDER_QUEUE_NAME } from '../notification/interfaces/exam-notification-job.interface';
import { EvaluationProcessor } from './processors/evaluation.processor';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { RankingProcessor } from './processors/ranking.processor';
import { ResultReconciliationProcessor } from './processors/result-reconciliation.processor';
import { ExamWindowEndProcessor } from './processors/exam-window-end.processor';

import { ResultProcessingMonitorService } from './services/result-processing-monitor.service';
import { ExamReportPdfService } from '../admin/services/exam-report-pdf.service';
import { ResendEmailService } from '../admin/services/resend-email.service';
import { GeminiExamAnalysisService } from './services/gemini-exam-analysis.service';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    RankEngineModule,
    TimeAnalysisModule,
    AttemptStrategyModule,
    forwardRef(() => AdminModule),
    forwardRef(() => ExamSchedulingModule),
    forwardRef(() => NotificationModule),
    BullModule.registerQueue(
      { name: EVALUATION_QUEUE_NAME },
      { name: ANALYTICS_QUEUE_NAME },
      { name: RANKING_QUEUE_NAME },
      { name: NOTIFICATION_QUEUE_NAME },
      { name: RECONCILIATION_QUEUE_NAME },
      { name: EXAM_WINDOW_END_QUEUE_NAME },
      { name: WHATSAPP_REMINDER_QUEUE_NAME },
    ),
  ],
  controllers: [ResultController, ExamPublicationController],
  providers: [
    ResultService,
    AnalysisEngineService,
    GeminiExamAnalysisService,
    ResultReadinessService,
    ResultAccessService,
    ExamPublicationService,
    ResultProcessingMonitorService,
    ExamReportPdfService,
    ResendEmailService,
    EvaluationProcessor,
    AnalyticsProcessor,
    RankingProcessor,
    ResultReconciliationProcessor,
    ExamWindowEndProcessor,
  ],
  exports: [
    ResultService,
    AnalysisEngineService,
    GeminiExamAnalysisService,
    ResultReadinessService,
    ResultAccessService,
    ExamPublicationService,
    ResultProcessingMonitorService,
    BullModule,
  ],
})
export class ResultModule implements OnModuleInit, OnModuleDestroy {
  private reconciliationTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectQueue(RECONCILIATION_QUEUE_NAME)
    private readonly reconciliationQueue: Queue,
    private readonly reconciliationProcessor: ResultReconciliationProcessor,
  ) {}

  async onModuleInit() {
    // 1. Initial startup reconciliation check after 2 seconds
    setTimeout(() => {
      this.reconciliationProcessor.runReconciliation('startup_reconciliation').catch(() => {});
    }, 2000);

    // 2. Periodic in-process self-healing reconciliation timer every 20 seconds
    this.reconciliationTimer = setInterval(() => {
      this.reconciliationProcessor.runReconciliation().catch(() => {});
    }, 20000);

    // 3. Register BullMQ repeatable job for distributed worker clusters
    try {
      await this.reconciliationQueue.add(
        'RECONCILE',
        {},
        {
          repeat: { every: 30000 },
          removeOnComplete: true,
        } as any,
      );
    } catch {}
  }

  onModuleDestroy() {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }
}
