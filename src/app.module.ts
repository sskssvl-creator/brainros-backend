import './common/infrastructure/init-bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MockQueue, MockWorker } from './common/infrastructure/mock-queue';
import { InfrastructureModule } from './common/infrastructure/infrastructure.module';
import { parseBooleanFlag } from './modules/feature-flag/feature-flag.constants';
import { PrismaModule } from './modules/prisma/prisma.module';
import { RedisModule } from './modules/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { StudentModule } from './modules/student/student.module';
import { NotificationModule } from './modules/notification/notification.module';
import { InstitutionModule } from './modules/institution/institution.module';
import { AdminModule } from './modules/admin/admin.module';
import { AcademicModule } from './modules/academic/academic.module';
import { ExamModule } from './modules/exam/exam.module';
import { ExamSchedulingModule } from './modules/exam-scheduling/exam-scheduling.module';
import { ExamAttemptModule } from './modules/exam-attempt/exam-attempt.module';
import { TimeAnalysisModule } from './modules/time-analysis/time-analysis.module';
import { AttemptStrategyModule } from './modules/attempt-strategy/attempt-strategy.module';
import { ResultModule } from './modules/result/result.module';
import { RankEngineModule } from './modules/rank-engine/rank-engine.module';
import { PredictedRankModule } from './modules/predicted-rank/predicted-rank.module';
import { PerformanceTrendModule } from './modules/performance-trend/performance-trend.module';
import { ParentDashboardModule } from './modules/parent-dashboard/parent-dashboard.module';
import { RegionalLanguageModule } from './modules/regional-language/regional-language.module';
import { ExamSecurityModule } from './modules/exam-security/exam-security.module';
import { FeatureFlagModule } from './modules/feature-flag/feature-flag.module';
import { HealthModule } from './modules/health/health.module';
import { LoggerModule } from './common/logger/logger.module';
import { JobProgressModule } from './modules/job-progress/job-progress.module';
import { RecommendationModule } from './modules/recommendation/recommendation.module';
import { BillingModule } from './modules/billing/billing.module';
import { ExamCacheModule } from './modules/exam-cache/exam-cache.module';
import { ExportModule } from './modules/export/export.module';
import { AiTranslationModule } from './modules/ai-translation/ai-translation.module';
import { SalesAgentModule } from './modules/sales-agent/sales-agent.module';

@Module({
  imports: [
    LoggerModule,
    InfrastructureModule,
    HealthModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local', '.env.production'],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const enabledRaw = configService.get<string>('REDIS_ENABLED') ?? process.env.REDIS_ENABLED;
        const enabled = enabledRaw !== undefined ? parseBooleanFlag(enabledRaw) : true;

        if (!enabled) {
          BullModule.queueClass = MockQueue as any;
          BullModule.workerClass = MockWorker as any;
          return {
            connection: {},
          };
        }

        const redisUrl =
          configService.get<string>('REDIS_URL') || process.env.REDIS_URL;
        if (redisUrl) {
          try {
            const parsed = new URL(redisUrl);
            const isTls =
              redisUrl.startsWith('rediss://') ||
              parsed.hostname.includes('upstash.io') ||
              parsed.hostname.includes('aivencloud.com');
            const targetHost =
              parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
            return {
              connection: {
                host: targetHost,
                port: parseInt(parsed.port || '6379', 10),
                username: parsed.username
                  ? decodeURIComponent(parsed.username)
                  : undefined,
                password: parsed.password
                  ? decodeURIComponent(parsed.password)
                  : undefined,
                tls: isTls ? { rejectUnauthorized: false } : undefined,
                // Do not block startup — connect lazily
                lazyConnect: true,
                // Fail fast if Redis is down; don't queue commands during outage
                enableReadyCheck: false,
                enableOfflineQueue: true,
                maxRetriesPerRequest: null,
                connectTimeout: 5000,
                keepAlive: 30000,
                // Auto-reconnect with bounded exponential backoff
                retryStrategy: (times: number) => {
                  return Math.min(times * 1000, 15000);
                },
              },
            };
          } catch (e) {
            // Fallback if URL parsing fails
          }
        }

        return {
          connection: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
            lazyConnect: true,
            enableReadyCheck: false,
            enableOfflineQueue: true,
            maxRetriesPerRequest: null,
            connectTimeout: 5000,
            keepAlive: 30000,
            retryStrategy: (times: number) => {
              return Math.min(times * 1000, 15000);
            },
          },
        };
      },
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    StudentModule,
    NotificationModule,
    InstitutionModule,
    AdminModule,
    AcademicModule,
    ExamModule,
    ExamSchedulingModule,
    ExamAttemptModule,
    ExamSecurityModule,
    TimeAnalysisModule,
    AttemptStrategyModule,
    ResultModule,
    RankEngineModule,
    PredictedRankModule,
    PerformanceTrendModule,
    ParentDashboardModule,
    RegionalLanguageModule,
    FeatureFlagModule,
    JobProgressModule,
    RecommendationModule,
    BillingModule,
    ExamCacheModule,
    ExportModule,
    AiTranslationModule,
    SalesAgentModule,
  ],
  providers: [],
})
export class AppModule {}
