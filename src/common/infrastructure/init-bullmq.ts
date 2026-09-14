import * as dotenv from 'dotenv';
import * as fs from 'fs';
if (fs.existsSync('.env.production')) {
  dotenv.config({ path: '.env.production' });
}
dotenv.config({ path: '.env' });
import { Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MockQueue, MockWorker } from './mock-queue';
import { ResilientQueue, ResilientWorker } from './resilient-queue';
import { parseBooleanFlag } from '../../modules/feature-flag/feature-flag.constants';

const logger = new Logger('BullMQInit');

/**
 * Early bootstrap hook for BullMQ.
 * Must execute before any module calls BullModule.registerQueue() so that
 * BullModule._queueClass and BullModule._workerClass are already configured.
 */
export function initBullMQ(): void {
  const envVal = process.env.REDIS_ENABLED;
  const isRedisEnabled = envVal !== undefined ? parseBooleanFlag(envVal) : true;

  if (!isRedisEnabled) {
    logger.log(
      '[Queue] REDIS_ENABLED=false: Configuring BullModule with in-memory Mock Queue/Worker',
    );
    BullModule.queueClass = MockQueue as any;
    BullModule.workerClass = MockWorker as any;
  } else {
    logger.log(
      '[Queue] REDIS_ENABLED=true: Configuring BullModule with ResilientQueue and ResilientWorker',
    );
    BullModule.queueClass = ResilientQueue as any;
    BullModule.workerClass = ResilientWorker as any;
  }
}

// Execute immediately upon import
initBullMQ();
