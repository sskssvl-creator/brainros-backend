import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';

const logger = new Logger('MockQueue');

// In-memory processor registry & pending jobs buffer for local development without Redis
const inMemoryProcessors = new Map<string, { processor: (job: any) => Promise<any>; worker: MockWorker }>();
const pendingJobs = new Map<string, any[]>();

/**
 * In-memory Mock Queue used when Redis is disabled (REDIS_ENABLED=false).
 * Satisfies BullMQ Queue dependency injection and executes jobs asynchronously in-memory.
 */
export class MockQueue extends EventEmitter {
  public name: string;
  public opts: any;

  constructor(name: string, opts?: any) {
    super();
    this.name = name;
    this.opts = opts || {};
  }

  async add(name: string, data: any, opts?: any): Promise<any> {
    const jobId = `mock-${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    logger.log(`[Queue: ${this.name}] Received job '${name}' (${jobId}) for in-memory execution.`);

    const job = {
      id: jobId,
      name,
      data,
      opts: opts || {},
      timestamp: Date.now(),
      returnvalue: null,
      progress: 0,
      attemptsMade: 0,
      updateProgress: async (p: any) => {
        job.progress = p;
      },
      log: async (msg: string) => {
        logger.debug(`[Job ${jobId}] ${msg}`);
      },
      getState: async () => 'active',
    };

    const registration = inMemoryProcessors.get(this.name);
    if (registration) {
      setImmediate(async () => {
        try {
          logger.log(`[Queue: ${this.name}] Executing job '${name}' (${jobId}) via registered worker...`);
          const result = await registration.processor(job);
          job.returnvalue = result;
          registration.worker.emit('completed', job, result);
          logger.log(`[Queue: ${this.name}] Successfully completed job '${name}' (${jobId}).`);
        } catch (err: any) {
          logger.error(`[Queue: ${this.name}] Job '${name}' (${jobId}) failed: ${err.message}`, err.stack);
          registration.worker.emit('failed', job, err);
        }
      });
    } else {
      logger.log(`[Queue: ${this.name}] Worker not yet registered. Buffering job '${name}' (${jobId})...`);
      const queueList = pendingJobs.get(this.name) || [];
      queueList.push(job);
      pendingJobs.set(this.name, queueList);
    }

    return job;
  }

  async getJob(_jobId: string): Promise<any> {
    return null;
  }

  async close(): Promise<void> {
    this.removeAllListeners();
  }

  async disconnect(): Promise<void> {
    this.removeAllListeners();
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async isPaused(): Promise<boolean> {
    return false;
  }
}

/**
 * In-memory Mock Worker used when Redis is disabled (REDIS_ENABLED=false).
 * Dispatches queued in-memory jobs to WorkerHost processors.
 */
export class MockWorker extends EventEmitter {
  public name: string;
  public processor?: (job: any) => Promise<any>;
  public opts: any;

  constructor(name: string, processor?: any, opts?: any) {
    super();
    this.name = name;
    this.processor = processor;
    this.opts = opts || {};

    if (processor && typeof processor === 'function') {
      inMemoryProcessors.set(name, { processor, worker: this });
      logger.log(`[MockWorker] Registered in-memory processor for queue '${name}'.`);

      // Drain any buffered jobs
      const buffered = pendingJobs.get(name) || [];
      if (buffered.length > 0) {
        pendingJobs.delete(name);
        logger.log(`[MockWorker] Draining ${buffered.length} buffered job(s) for queue '${name}'...`);
        for (const job of buffered) {
          setImmediate(async () => {
            try {
              const result = await processor(job);
              job.returnvalue = result;
              this.emit('completed', job, result);
            } catch (err: any) {
              logger.error(`[MockWorker] Buffered job ${job.id} failed: ${err.message}`, err.stack);
              this.emit('failed', job, err);
            }
          });
        }
      }
    }
  }

  async run(): Promise<void> {}
  async close(): Promise<void> {
    inMemoryProcessors.delete(this.name);
    this.removeAllListeners();
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  isRunning(): boolean {
    return true;
  }
}
