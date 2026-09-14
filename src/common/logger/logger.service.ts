import { Injectable, LoggerService, Scope } from '@nestjs/common';
import pino, { Logger as PinoLogger } from 'pino';
import { RequestContext } from './request-context';
import { getLogLevel, redactSensitiveData } from './logger.config';

export interface HttpLogPayload {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip?: string;
  userAgent?: string;
  userId?: string;
  role?: string;
  requestId?: string;
  [key: string]: any;
}

export interface ErrorLogPayload {
  errorName?: string;
  errorCode?: string;
  message: string;
  stack?: string;
  statusCode?: number;
  method?: string;
  path?: string;
  durationMs?: number;
  userId?: string;
  role?: string;
  requestId?: string;
  service?: string;
  details?: any;
  [key: string]: any;
}

export interface WorkerLogPayload {
  queue: string;
  jobId: string | number;
  jobName?: string;
  attemptId?: string;
  correlationId?: string;
  durationMs?: number;
  status?: string;
  error?: string;
  [key: string]: any;
}

@Injectable({ scope: Scope.DEFAULT })
export class AppLoggerService implements LoggerService {
  private readonly pinoLogger: PinoLogger;
  private contextName = 'Application';

  constructor() {
    const useJson = process.env.LOG_FORMAT === 'json';
    const level = getLogLevel();

    if (useJson) {
      this.pinoLogger = pino(
        {
          level,
          formatters: {
            level: (label) => ({ level: label.toUpperCase() }),
          },
          timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
          redact: {
            paths: [
              'password',
              '*.password',
              'token',
              '*.token',
              'otp',
              '*.otp',
              'secret',
              '*.secret',
              'apiKey',
              '*.apiKey',
              'authorization',
              'headers.authorization',
              'cookie',
              'headers.cookie',
              'set-cookie',
              'headers.set-cookie',
            ],
            censor: '[REDACTED]',
          },
        },
        pino.destination({ sync: true }),
      );
    } else {
      // Use synchronous pino-pretty stream for clean human-readable log visibility
      try {
        const prettyStream = require('pino-pretty')({
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
          sync: true,
        });
        this.pinoLogger = pino({ level }, prettyStream);
      } catch {
        this.pinoLogger = pino({ level }, pino.destination({ sync: true }));
      }
    }
  }

  setContext(context: string): void {
    this.contextName = context;
  }

  private getEnrichedMeta(meta?: Record<string, any>, context?: string): Record<string, any> {
    const ctx = RequestContext.get();
    const enriched: Record<string, any> = {
      context: context || this.contextName,
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.userId ? { userId: ctx.userId } : {}),
      ...(ctx?.role ? { role: ctx.role } : {}),
      ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(meta ? redactSensitiveData(meta) : {}),
    };
    return enriched;
  }

  log(message: any, context?: string): void {
    const meta = this.getEnrichedMeta(typeof message === 'object' ? message : undefined, context);
    const msg = typeof message === 'string' ? message : message?.message || JSON.stringify(redactSensitiveData(message));
    this.pinoLogger.info(meta, msg);
  }

  error(message: any, trace?: string, context?: string): void {
    const meta = this.getEnrichedMeta(
      typeof message === 'object' ? { ...message, stack: trace || message?.stack } : { stack: trace },
      context,
    );
    const msg = typeof message === 'string' ? message : message?.message || String(message);
    this.pinoLogger.error(meta, msg);
  }

  warn(message: any, context?: string): void {
    const meta = this.getEnrichedMeta(typeof message === 'object' ? message : undefined, context);
    const msg = typeof message === 'string' ? message : message?.message || String(message);
    this.pinoLogger.warn(meta, msg);
  }

  debug(message: any, context?: string): void {
    const meta = this.getEnrichedMeta(typeof message === 'object' ? message : undefined, context);
    const msg = typeof message === 'string' ? message : message?.message || String(message);
    this.pinoLogger.debug(meta, msg);
  }

  verbose(message: any, context?: string): void {
    const meta = this.getEnrichedMeta(typeof message === 'object' ? message : undefined, context);
    const msg = typeof message === 'string' ? message : message?.message || String(message);
    this.pinoLogger.trace(meta, msg);
  }

  fatal(message: any, trace?: string, context?: string): void {
    const meta = this.getEnrichedMeta(
      typeof message === 'object' ? { ...message, stack: trace || message?.stack } : { stack: trace },
      context,
    );
    const msg = typeof message === 'string' ? message : message?.message || String(message);
    this.pinoLogger.fatal(meta, msg);
  }

  /**
   * Dedicated structured HTTP request logging
   */
  logHttp(payload: HttpLogPayload): void {
    const { method, path, statusCode, durationMs, ...rest } = payload;
    const meta = this.getEnrichedMeta({
      method,
      path,
      statusCode,
      durationMs,
      ...rest,
    }, 'HTTP');

    const msg = `${method} ${path} ${statusCode} +${durationMs}ms`;

    if (statusCode >= 500) {
      this.pinoLogger.error(meta, msg);
    } else if (statusCode >= 400) {
      this.pinoLogger.warn(meta, msg);
    } else {
      this.pinoLogger.info(meta, msg);
    }
  }

  /**
   * Dedicated structured error logging
   */
  logError(payload: ErrorLogPayload): void {
    const { message, stack, ...rest } = payload;
    const meta = this.getEnrichedMeta({
      ...rest,
      stack,
    }, 'Exception');

    this.pinoLogger.error(meta, message);
  }

  /**
   * Dedicated structured worker/queue event logging
   */
  logWorker(payload: WorkerLogPayload): void {
    const { queue, jobId, status, error, ...rest } = payload;
    const meta = this.getEnrichedMeta({
      queue,
      jobId,
      status,
      error,
      ...rest,
    }, `Worker:${queue}`);

    const msg = `[Queue:${queue}] Job #${jobId} ${status || 'processed'}${error ? ` - Error: ${error}` : ''}`;

    if (error || status === 'failed') {
      this.pinoLogger.error(meta, msg);
    } else {
      this.pinoLogger.info(meta, msg);
    }
  }

  /**
   * Structured business/security/audit event logging
   */
  logEvent(eventName: string, payload?: Record<string, any>, level: 'info' | 'warn' | 'error' = 'info'): void {
    const meta = this.getEnrichedMeta({
      event: eventName,
      ...(payload || {}),
    }, 'AuditEvent');

    this.pinoLogger[level](meta, `[EVENT] ${eventName}`);
  }

  /**
   * Synchronously flushes log buffer to ensure logs are fully written to stdout
   */
  flush(): void {
    if (this.pinoLogger && typeof (this.pinoLogger as any).flush === 'function') {
      try {
        (this.pinoLogger as any).flush();
      } catch {}
    }
  }
}
