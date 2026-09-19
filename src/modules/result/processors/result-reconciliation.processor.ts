import { Processor, WorkerHost, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ResultService } from '../result.service';
import { ResultReadinessService } from '../services/result-readiness.service';
import { ResultAccessService } from '../services/result-access.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { TimeAnalysisService } from '../../time-analysis/services/time-analysis.service';
import { StrategyAnalyzerService } from '../../attempt-strategy/services/strategy-analyzer.service';
import { RankGenerationService } from '../../rank-engine/services/rank-generation.service';
import {
  RECONCILIATION_QUEUE_NAME,
  EVALUATION_QUEUE_NAME,
  ANALYTICS_QUEUE_NAME,
  RANKING_QUEUE_NAME,
  EXAM_WINDOW_END_QUEUE_NAME,
  ReconciliationJobPayload,
  ResultStatusEnum,
} from '../interfaces/result-lifecycle.interface';

@Processor(RECONCILIATION_QUEUE_NAME, {
  concurrency: 1,
})
@Injectable()
export class ResultReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ResultReconciliationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly resultService: ResultService,
    private readonly readinessService: ResultReadinessService,
    private readonly resultAccessService: ResultAccessService,
    private readonly timeAnalysisService: TimeAnalysisService,
    private readonly strategyAnalyzerService: StrategyAnalyzerService,
    private readonly rankGenerationService: RankGenerationService,
    @InjectQueue(EVALUATION_QUEUE_NAME)
    private readonly evaluationQueue: Queue,
    @InjectQueue(ANALYTICS_QUEUE_NAME)
    private readonly analyticsQueue: Queue,
    @InjectQueue(RANKING_QUEUE_NAME)
    private readonly rankingQueue: Queue,
    @InjectQueue(EXAM_WINDOW_END_QUEUE_NAME)
    private readonly windowEndQueue: Queue,
    private readonly jobProgressService: JobProgressService,
  ) {
    super();
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.warn(`Reconciliation worker connection/runtime error: ${err.message}`);
  }

  async process(job: Job<ReconciliationJobPayload>): Promise<any> {
    const jobId = String(job?.id || `reconcile_${Date.now()}`);
    return this.runReconciliation(jobId);
  }

  /**
   * Execute full reconciliation and end-of-exam pipeline.
   * Can be called by BullMQ, interval scheduler, or manual trigger.
   */
  async runReconciliation(jobId: string = `reconcile_${Date.now()}`): Promise<any> {
    const lockKey = 'lock:result-reconciliation-run';
    let hasRedisLock = false;

    try {
      const isLocked = await this.redisService.get(lockKey);
      if (isLocked) {
        this.logger.debug('[Reconciliation] Skipping run: another worker is active.');
        return { skipped: true, reason: 'LOCKED' };
      }
      await this.redisService.set(lockKey, 'locked', 45);
      hasRedisLock = true;
    } catch {
      // Non-blocking fallback if Redis is down
    }

    try {
      await this.jobProgressService.publishStarted(RECONCILIATION_QUEUE_NAME, jobId, {
        type: 'RESULT_RECONCILIATION',
        stage: 'CHECKING_STUCK_RESULTS',
        message: 'Checking for stuck attempts, ended exams, and un-evaluated results...',
      });
    } catch {}

    try {
      const stats = {
        repairedMockPublished: 0,
        repairedLiveReady: 0,
        requeuedMissingResults: 0,
        autoSubmittedAttempts: 0,
        endedExamsTriggered: 0,
        processedTotal: 0,
      };

      const now = new Date();
      const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

      // ─── 1. Find IN_PROGRESS attempts whose serverEndTime or exam schedule has passed and auto-submit ───
      const autoSubmittedStatus = await this.prisma.attemptStatus.findUnique({
        where: { name: 'AUTO_SUBMITTED' },
      });

      if (autoSubmittedStatus) {
        const expiredInProgressAttempts = await this.prisma.attempt.findMany({
          where: {
            status: { name: 'IN_PROGRESS' },
            OR: [
              { serverEndTime: { lte: now } },
              {
                exam: {
                  schedules: {
                    some: {
                      status: { in: ['SCHEDULED', 'ACTIVE', 'ENDED'] },
                      endTime: { lte: now },
                    },
                  },
                },
              },
            ],
          },
          include: {
            exam: {
              include: {
                schedules: { orderBy: { endTime: 'desc' }, take: 1 },
              },
            },
          },
          take: 50,
        });

        for (const exp of expiredInProgressAttempts) {
          try {
            const effectiveEnd = exp.serverEndTime && exp.serverEndTime <= now ? exp.serverEndTime : now;
            await this.prisma.attempt.update({
              where: { id: exp.id },
              data: {
                statusId: autoSubmittedStatus.id,
                submittedAt: effectiveEnd,
              },
            });

            const isLive = await this.readinessService.isLiveExam(exp.examId);
            if (isLive) {
              await this.prisma.result.upsert({
                where: { attemptId: exp.id },
                update: { resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE },
                create: {
                  attemptId: exp.id,
                  resultStatus: ResultStatusEnum.PENDING_WINDOW_CLOSE,
                  totalQuestions: 0,
                  correctAnswers: 0,
                  wrongAnswers: 0,
                  unattempted: 0,
                  totalScore: 0,
                  maxScore: 0,
                  percentage: 0,
                  accuracy: 0,
                  metadata: {
                    deferred: true,
                    autoSubmittedByReconciliation: true,
                    reason: 'Auto-submitted after exam window ended',
                  },
                },
              });
            } else {
              // Mock test: evaluate immediately
              try {
                await this.resultService.calculateResult(exp.id);
              } catch {}
            }
            stats.autoSubmittedAttempts++;
          } catch (autoErr: any) {
            this.logger.warn(`[Reconciliation] Auto-submit error for attempt '${exp.id}': ${autoErr.message}`);
          }
        }
      }

      // ─── 2. Find all Scheduled Exams whose endTime <= now and ensure schedule/exam status is ENDED ───
      const endedSchedules = await this.prisma.examSchedule.findMany({
        where: {
          endTime: { lte: now },
          status: { in: ['SCHEDULED', 'ACTIVE'] },
        },
        select: { id: true, examId: true },
      });

      if (endedSchedules.length > 0) {
        await this.prisma.examSchedule.updateMany({
          where: { id: { in: endedSchedules.map((s) => s.id) } },
          data: { status: 'ENDED' },
        });

        const distinctExamIds = Array.from(new Set(endedSchedules.map((s) => s.examId)));
        const endedExamStatus = await this.prisma.examStatus.findUnique({ where: { name: 'ENDED' } });
        if (endedExamStatus) {
          await this.prisma.exam.updateMany({
            where: { id: { in: distinctExamIds }, status: { name: 'ACTIVE' } },
            data: {
              statusId: endedExamStatus.id,
            },
          });
        }
      }

      // ─── 3. Find Ended Live Exams with pending attempts and trigger batch evaluation ───
      const endedLiveExamsNeedingEvaluation = await this.prisma.exam.findMany({
        where: {
          schedules: {
            some: {
              status: { in: ['SCHEDULED', 'ACTIVE', 'ENDED'] },
              endTime: { lte: now },
            },
          },
          attempts: {
            some: {
              status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
              OR: [
                { result: null },
                {
                  result: {
                    resultStatus: {
                      in: [
                        ResultStatusEnum.PENDING_WINDOW_CLOSE,
                        ResultStatusEnum.FAILED,
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
        include: {
          attempts: {
            where: {
              status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
              OR: [
                { result: null },
                {
                  result: {
                    resultStatus: {
                      in: [
                        ResultStatusEnum.PENDING_WINDOW_CLOSE,
                        ResultStatusEnum.FAILED,
                      ],
                    },
                  },
                },
              ],
            },
            select: { id: true },
          },
        },
        take: 20,
      });

      for (const endedExam of endedLiveExamsNeedingEvaluation) {
        stats.endedExamsTriggered++;
        this.logger.log(
          `[Reconciliation] Processing ${endedExam.attempts.length} pending attempts for ended exam '${endedExam.title}' (${endedExam.id}).`,
        );

        // Update result placeholder to PROCESSING
        for (const att of endedExam.attempts) {
          await this.prisma.result.upsert({
            where: { attemptId: att.id },
            update: {
              resultStatus: ResultStatusEnum.PROCESSING,
              metadata: {
                batchEvaluated: true,
                automatedPostWindow: true,
                enqueuedAt: now.toISOString(),
              },
            },
            create: {
              attemptId: att.id,
              resultStatus: ResultStatusEnum.PROCESSING,
              totalQuestions: 0,
              correctAnswers: 0,
              wrongAnswers: 0,
              unattempted: 0,
              totalScore: 0,
              maxScore: 0,
              percentage: 0,
              accuracy: 0,
              metadata: {
                batchEvaluated: true,
                automatedPostWindow: true,
                enqueuedAt: now.toISOString(),
              },
            },
          });

          // Dispatch to BullMQ or execute calculation
          let queueDispatched = false;
          try {
            const evalJobId = `eval_${att.id}_${Date.now()}`;
            await this.evaluationQueue.add(
              'EVALUATE_ATTEMPT',
              {
                attemptId: att.id,
                triggeredAt: now.toISOString(),
                evaluationMode: 'AUTOMATED_POST_WINDOW',
              },
              {
                jobId: evalJobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: true,
              },
            );
            queueDispatched = true;
          } catch (qErr: any) {
            this.logger.warn(`Queue dispatch fallback to direct calculation: ${qErr.message}`);
          }

          // Direct calculation fallback if queue is unavailable or mock
          if (!queueDispatched) {
            try {
              await this.resultService.calculateResult(att.id);
              await this.timeAnalysisService.generateTimeAnalysis(att.id).catch(() => {});
              await this.strategyAnalyzerService.generateStrategyAnalysis(att.id).catch(() => {});
            } catch (calcErr: any) {
              this.logger.error(`Direct calculation error for '${att.id}': ${calcErr.message}`);
            }
          }
        }

        // Generate Ranks & Percentiles for the exam
        try {
          await this.rankGenerationService.generateRanks({
            examId: endedExam.id,
            snapshotVersion: 1,
            forceRegenerate: true,
          });
        } catch (rankErr: any) {
          this.logger.warn(`Rank generation notice during reconciliation: ${rankErr.message}`);
        }
      }

      // ─── 4. Find attempts with existing Result that are stuck in intermediate statuses ───
      const stuckCalculatedResults = await this.prisma.result.findMany({
        where: {
          totalScore: { gte: 0 },
          resultStatus: {
            in: [
              ResultStatusEnum.PROCESSING,
              ResultStatusEnum.EVALUATED,
              ResultStatusEnum.ANALYTICS_PROCESSING,
              ResultStatusEnum.RANKING_PROCESSING,
            ],
          },
        },
        include: {
          attempt: {
            include: {
              exam: { select: { id: true, title: true } },
              timeAnalyses: { take: 1 },
              strategyAnalyses: { take: 1 },
              candidateRanks: { take: 1 },
            },
          },
        },
        take: 50,
      });

      for (const res of stuckCalculatedResults) {
        stats.processedTotal++;
        const isLive = await this.readinessService.isLiveExam(res.attempt.examId);

        if (!isLive) {
          // For Mock test, auto-publish if calculated
          await this.prisma.result.update({
            where: { id: res.id },
            data: {
              resultStatus: ResultStatusEnum.PUBLISHED,
              publishedAt: res.publishedAt || new Date(),
              publicationVersion: 1,
            },
          });
          await this.resultAccessService.invalidateResultCache(
            res.attemptId,
            res.attempt.studentId,
            res.attempt.examId,
          );
          stats.repairedMockPublished++;
        } else {
          // Ensure time & strategy analyses are generated
          if (!res.attempt.timeAnalyses?.length) {
            await this.timeAnalysisService.generateTimeAnalysis(res.attemptId).catch(() => {});
          }
          if (!res.attempt.strategyAnalyses?.length) {
            await this.strategyAnalyzerService.generateStrategyAnalysis(res.attemptId).catch(() => {});
          }
          if (!res.attempt.candidateRanks?.length) {
            await this.rankGenerationService.generateRanks({
              examId: res.attempt.examId,
              snapshotVersion: 1,
              forceRegenerate: false,
            }).catch(() => {});
          }

          await this.prisma.result.update({
            where: { id: res.id },
            data: {
              resultStatus: ResultStatusEnum.READY_TO_PUBLISH,
            },
          });
          await this.resultAccessService.invalidateResultCache(
            res.attemptId,
            res.attempt.studentId,
            res.attempt.examId,
          );
          stats.repairedLiveReady++;
        }
      }

      // ─── 5. Find submitted attempts missing a Result where submittedAt > STUCK_THRESHOLD_MS ───
      const stuckSubmittedAttempts = await this.prisma.attempt.findMany({
        where: {
          status: { name: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
          result: null,
          submittedAt: {
            lte: new Date(Date.now() - STUCK_THRESHOLD_MS),
          },
        },
        select: { id: true, examId: true, studentId: true },
        take: 20,
      });

      for (const att of stuckSubmittedAttempts) {
        stats.processedTotal++;
        try {
          const isLive = await this.readinessService.isLiveExam(att.examId);
          if (isLive) {
            const activeSchedule = await this.prisma.examSchedule.findFirst({
              where: { examId: att.examId, status: { in: ['ACTIVE', 'SCHEDULED'] } },
              orderBy: { endTime: 'desc' },
            });
            if (activeSchedule && new Date(activeSchedule.endTime).getTime() > Date.now()) {
              continue;
            }
          }

          await this.resultService.calculateResult(att.id);
          stats.requeuedMissingResults++;
        } catch (calcErr: any) {
          this.logger.error(`[Reconciliation] Failed recovery calculation for '${att.id}': ${calcErr.message}`);
        }
      }

      try {
        await this.jobProgressService.publishCompleted(RECONCILIATION_QUEUE_NAME, jobId, {
          message: `Reconciliation finished. Repaired: ${stats.repairedMockPublished} mocks, ${stats.repairedLiveReady} live. Auto-submitted: ${stats.autoSubmittedAttempts}. Triggered ended exams: ${stats.endedExamsTriggered}.`,
          resultSummary: stats,
        });
      } catch {}

      this.logger.log(
        `[Reconciliation] Finished run. Repaired: ${stats.repairedMockPublished} mocks, ${stats.repairedLiveReady} live. Triggered ended exams: ${stats.endedExamsTriggered}.`,
      );

      return { success: true, stats };
    } catch (err: any) {
      this.logger.error(`[Reconciliation] Error in runReconciliation: ${err.message}`, err.stack);
      try {
        await this.jobProgressService.publishFailed(
          RECONCILIATION_QUEUE_NAME,
          jobId,
          err.message || 'Result reconciliation failed.',
        );
      } catch {}
      throw err;
    } finally {
      if (hasRedisLock) {
        await this.redisService.del(lockKey).catch(() => {});
      }
    }
  }
}
