import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { AI_TRANSLATION_DEFAULTS } from '../constants/ai-translation.constants';
import { parseBooleanFlag } from '../../feature-flag/feature-flag.constants';

@Injectable()
export class GeminiRateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(GeminiRateLimiterService.name);

  private readonly isEnabled: boolean;
  private readonly maxRequestsPerInterval: number;
  private readonly intervalMs: number;
  private readonly minRequestIntervalMs: number;

  // In-memory queue & sliding window fallback
  private inMemoryTimestamps: number[] = [];
  private inMemoryPauseUntil = 0;
  private inMemoryLastRequestTime = 0;
  private inMemoryLockQueue: (() => void)[] = [];
  private isLocalProcessing = false;

  private readonly redisPauseKey = 'gemini:ratelimit:pause_until';
  private readonly redisRequestKey = 'gemini:ratelimit:requests';
  private readonly redisLastRequestKey = 'gemini:ratelimit:last_request_time';

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const rawEnabled =
      this.configService.get<string>('GEMINI_RATE_LIMIT_ENABLED') ??
      process.env.GEMINI_RATE_LIMIT_ENABLED;
    this.isEnabled =
      rawEnabled !== undefined
        ? parseBooleanFlag(rawEnabled)
        : AI_TRANSLATION_DEFAULTS.RATE_LIMIT_ENABLED;

    this.maxRequestsPerInterval = Number(
      this.configService.get<number>('GEMINI_REQUESTS_PER_INTERVAL') ||
        process.env.GEMINI_REQUESTS_PER_INTERVAL ||
        AI_TRANSLATION_DEFAULTS.REQUESTS_PER_INTERVAL,
    );

    this.intervalMs = Number(
      this.configService.get<number>('GEMINI_RATE_LIMIT_INTERVAL_MS') ||
        process.env.GEMINI_RATE_LIMIT_INTERVAL_MS ||
        AI_TRANSLATION_DEFAULTS.INTERVAL_MS,
    );

    this.minRequestIntervalMs = Number(
      this.configService.get<number>('GEMINI_MIN_REQUEST_INTERVAL_MS') ||
        process.env.GEMINI_MIN_REQUEST_INTERVAL_MS ||
        AI_TRANSLATION_DEFAULTS.MIN_REQUEST_INTERVAL_MS,
    );

    this.logger.log(
      `GeminiRateLimiter initialized [Enabled: ${this.isEnabled}, Max: ${this.maxRequestsPerInterval} req/${this.intervalMs}ms, MinSpacing: ${this.minRequestIntervalMs}ms, Redis: ${this.isRedisAvailable() ? 'DISTRIBUTED' : 'LOCAL_IN_MEMORY'}]`,
    );
  }

  onModuleDestroy() {
    this.inMemoryLockQueue = [];
    this.inMemoryTimestamps = [];
  }

  private isRedisAvailable(): boolean {
    return Boolean(
      this.redisService.isEnabled &&
        this.redisService.isReady &&
        this.redisService.getClient(),
    );
  }

  /**
   * Acquire an execution slot before dispatching a Gemini API call.
   * Ensures:
   * 1. Any active global pause (e.g. from 429 RetryInfo) is honored across all workers.
   * 2. The requests per window limit is respected.
   * 3. Inter-request pacing delay is enforced.
   */
  async acquireSlot(): Promise<() => void> {
    if (!this.isEnabled) {
      return () => {};
    }

    if (this.isRedisAvailable()) {
      return this.acquireRedisSlot();
    }

    return this.acquireInMemorySlot();
  }

  /**
   * Pause all Gemini API requests globally across all workers/instances.
   * Used when HTTP 429 with retryDelay is encountered.
   */
  async pauseGlobally(durationMs: number, reason: string): Promise<void> {
    const pauseUntil = Date.now() + Math.max(durationMs, 50);
    this.logger.warn(
      `[GLOBAL PAUSE] Pausing Gemini requests for ${Math.round(durationMs / 1000)}s until ${new Date(pauseUntil).toISOString()}. Reason: ${reason}`,
    );

    // Set in-memory pause
    this.inMemoryPauseUntil = Math.max(this.inMemoryPauseUntil, pauseUntil);

    // Set Redis pause if available
    if (this.isRedisAvailable()) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          const ttlSeconds = Math.ceil(durationMs / 1000) + 2;
          await client.set(this.redisPauseKey, String(pauseUntil), 'EX', ttlSeconds);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to set distributed pause in Redis: ${err.message}`);
      }
    }
  }

  /**
   * Check if requests are currently paused globally.
   * Returns remaining pause duration in ms, or 0 if not paused.
   */
  async getRemainingPauseMs(): Promise<number> {
    const now = Date.now();

    if (this.isRedisAvailable()) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          const pauseUntilStr = await client.get(this.redisPauseKey);
          if (pauseUntilStr) {
            const pauseUntil = Number(pauseUntilStr);
            if (pauseUntil > now) {
              return pauseUntil - now;
            }
          }
        }
      } catch {
        // Fallback to in-memory check
      }
    }

    if (this.inMemoryPauseUntil > now) {
      return this.inMemoryPauseUntil - now;
    }

    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // REDIS DISTRIBUTED LIMITER IMPLEMENTATION
  // ═══════════════════════════════════════════════════════════════════

  private async acquireRedisSlot(): Promise<() => void> {
    const client = this.redisService.getClient();
    if (!client) {
      return this.acquireInMemorySlot();
    }

    // Loop until slot is acquired
    while (true) {
      const now = Date.now();

      // 1. Check Distributed Pause
      const remainingPause = await this.getRemainingPauseMs();
      if (remainingPause > 0) {
        this.logger.log(
          `Waiting for global pause to expire (${Math.round(remainingPause / 1000)}s remaining)...`,
        );
        await new Promise((res) => setTimeout(res, Math.min(remainingPause, 5000)));
        continue;
      }

      // 2. Sliding window rate check using Redis Sorted Set
      try {
        const windowStart = now - this.intervalMs;
        const memberId = `${now}-${Math.random().toString(36).substring(2, 8)}`;

        // Atomic Lua script: cleans old requests, counts, and checks pacing
        const luaScript = `
          local requestKey = KEYS[1]
          local lastReqKey = KEYS[2]
          local now = tonumber(ARGV[1])
          local windowStart = tonumber(ARGV[2])
          local maxReq = tonumber(ARGV[3])
          local minInterval = tonumber(ARGV[4])
          local member = ARGV[5]
          local expireSec = tonumber(ARGV[6])

          -- Remove requests older than sliding window
          redis.call('ZREMRANGEBYSCORE', requestKey, '-inf', windowStart)

          -- Check current count
          local currentCount = redis.call('ZCARD', requestKey)
          if currentCount >= maxReq then
            return {0, 1000} -- Retry in 1s
          end

          -- Check min interval spacing
          local lastTime = redis.call('GET', lastReqKey)
          if lastTime then
            local timeDiff = now - tonumber(lastTime)
            if timeDiff < minInterval then
              return {0, minInterval - timeDiff}
            end
          end

          -- Slot acquired: Record request
          redis.call('ZADD', requestKey, now, member)
          redis.call('SET', lastReqKey, now, 'EX', expireSec)
          redis.call('EXPIRE', requestKey, expireSec)
          return {1, 0}
        `;

        const expireSeconds = Math.ceil(this.intervalMs / 1000) * 2;
        const result = (await client.eval(
          luaScript,
          2,
          this.redisRequestKey,
          this.redisLastRequestKey,
          now,
          windowStart,
          this.maxRequestsPerInterval,
          this.minRequestIntervalMs,
          memberId,
          expireSeconds,
        )) as [number, number];

        if (result && result[0] === 1) {
          // Successfully acquired slot
          return () => {
            // Cleanup hook on release
          };
        }

        const waitDelay = Math.max(result && result[1] ? Number(result[1]) : 1000, 500);
        await new Promise((res) => setTimeout(res, waitDelay));
      } catch (err: any) {
        this.logger.warn(
          `Redis rate limit script error (${err.message}). Falling back to local queue for this request.`,
        );
        return this.acquireInMemorySlot();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // LOCAL IN-MEMORY LIMITER IMPLEMENTATION (Fallback)
  // ═══════════════════════════════════════════════════════════════════

  private async acquireInMemorySlot(): Promise<() => void> {
    while (true) {
      const now = Date.now();

      // 1. Check pause
      if (this.inMemoryPauseUntil > now) {
        const delay = this.inMemoryPauseUntil - now;
        await new Promise((res) => setTimeout(res, Math.min(delay, 2000)));
        continue;
      }

      // 2. Clean sliding window
      const windowStart = now - this.intervalMs;
      this.inMemoryTimestamps = this.inMemoryTimestamps.filter((t) => t > windowStart);

      // 3. Check max requests in interval
      if (this.inMemoryTimestamps.length >= this.maxRequestsPerInterval) {
        const oldest = this.inMemoryTimestamps[0];
        const waitTime = Math.max(oldest + this.intervalMs - now + 50, 100);
        await new Promise((res) => setTimeout(res, Math.min(waitTime, 2000)));
        continue;
      }

      // 4. Check min spacing
      const timeSinceLast = now - this.inMemoryLastRequestTime;
      if (timeSinceLast < this.minRequestIntervalMs) {
        const waitTime = this.minRequestIntervalMs - timeSinceLast;
        await new Promise((res) => setTimeout(res, waitTime));
        continue;
      }

      // Slot is acquired
      const reqTime = Date.now();
      this.inMemoryTimestamps.push(reqTime);
      this.inMemoryLastRequestTime = reqTime;
      return () => {
        // Release hook
      };
    }
  }
}
