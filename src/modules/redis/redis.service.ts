import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { InfrastructureStateService } from '../../common/infrastructure/infrastructure-state.service';
import { parseBooleanFlag } from '../feature-flag/feature-flag.constants';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private redisClient: Redis | null = null;
  private _isReady = false;
  private isExplicitlyDisabled = false;

  private lastErrorLogTime = 0;
  private lastReconnectLogTime = 0;

  // In-memory key-value database fallback to handle offline/disconnected environment
  private memoryDb = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly infrastructureState: InfrastructureStateService,
  ) {}

  public get isReady(): boolean {
    return this._isReady;
  }

  public get isEnabled(): boolean {
    return !this.isExplicitlyDisabled;
  }

  onModuleInit() {
    const redisEnabledRaw =
      this.configService.get<string>('REDIS_ENABLED') ??
      process.env.REDIS_ENABLED;

    // Default to true if not specified, but respect explicit false/0/off
    const redisEnabled =
      redisEnabledRaw !== undefined
        ? parseBooleanFlag(redisEnabledRaw)
        : true;

    if (!redisEnabled) {
      this.isExplicitlyDisabled = true;
      this._isReady = false;
      this.infrastructureState.setRedisState('DISABLED');
      this.logger.log(
        '[Redis] Disabled by configuration (REDIS_ENABLED=false). Operating in resilient in-memory mode.',
      );
      return;
    }

    this.infrastructureState.setRedisState('CONNECTING');
    const redisUrl = this.configService.get<string>('REDIS_URL');

    const commonOptions: RedisOptions = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      enableOfflineQueue: false, // Prevents queuing commands when disconnected
      retryStrategy: (times) => {
        // Controlled exponential backoff: 1s, 2s, 3s... max 15s
        const delay = Math.min(times * 1000, 15000);
        return delay;
      },
    };

    try {
      if (redisUrl) {
        const isTls = redisUrl.startsWith('rediss://') || redisUrl.includes('.upstash.io') || redisUrl.includes('.aivencloud.com');
        const effectiveUrl = (isTls && redisUrl.startsWith('redis://'))
          ? redisUrl.replace(/^redis:\/\//, 'rediss://')
          : redisUrl;

        this.redisClient = new Redis(effectiveUrl, {
          ...commonOptions,
          tls: isTls ? { rejectUnauthorized: false } : undefined,
        });
      } else {
        const host = this.configService.get<string>('REDIS_HOST') || 'localhost';
        const port = this.configService.get<number>('REDIS_PORT') || 6379;
        const password =
          this.configService.get<string>('REDIS_PASSWORD') || undefined;

        this.redisClient = new Redis({
          ...commonOptions,
          host,
          port,
          password,
        });
      }

      // Attach all event listeners immediately to prevent unhandled errors
      this.redisClient.on('error', (err) => {
        this._isReady = false;
        this.infrastructureState.setRedisState('DOWN', err.message);
        this.infrastructureState.setQueueState('DOWN', err.message);

        // Throttle error logs to once every 10 seconds to avoid console flooding
        const now = Date.now();
        if (now - this.lastErrorLogTime > 10000) {
          this.logger.warn(`[Redis] Connection error: ${err.message}. In-memory fallback active.`);
          this.lastErrorLogTime = now;
        }
      });

      this.redisClient.on('connect', () => {
        this._isReady = true;
        this.infrastructureState.setRedisState('UP');
        this.infrastructureState.setQueueState('UP');
        this.logger.log('[Redis] Connected successfully.');
      });

      this.redisClient.on('ready', () => {
        this._isReady = true;
        this.infrastructureState.setRedisState('UP');
        this.infrastructureState.setQueueState('UP');
        this.logger.log('[Redis] Ready to accept commands.');
      });

      this.redisClient.on('close', () => {
        this._isReady = false;
        this.infrastructureState.setRedisState('DOWN', 'Connection closed');
        this.infrastructureState.setQueueState('DOWN', 'Connection closed');

        const now = Date.now();
        if (now - this.lastErrorLogTime > 10000) {
          this.logger.warn('[Redis] Connection closed. In-memory fallback active.');
          this.lastErrorLogTime = now;
        }
      });

      this.redisClient.on('reconnecting', (delay) => {
        this._isReady = false;
        this.infrastructureState.setRedisState('CONNECTING');

        const now = Date.now();
        if (now - this.lastReconnectLogTime > 10000) {
          this.logger.warn(`[Redis] Reconnecting in ${delay}ms...`);
          this.lastReconnectLogTime = now;
        }
      });

      // Hard timeout for initial startup connection attempt (5 seconds)
      const connectPromise = this.redisClient.connect();
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Connection timed out after 5000ms'));
        }, 5000);
      });

      Promise.race([connectPromise, timeoutPromise])
        .then(() => {
          this._isReady = true;
          this.infrastructureState.setRedisState('UP');
          this.infrastructureState.setQueueState('UP');
        })
        .catch((err: any) => {
          this._isReady = false;
          const msg = err instanceof Error ? err.message : String(err);
          this.infrastructureState.setRedisState('DOWN', msg);
          this.infrastructureState.setQueueState('DOWN', msg);
          this.logger.error(
            `[STARTUP] Redis connection failed after 5s (${msg}) - continuing in resilient in-memory mode.`,
          );
        })
        .finally(() => {
          if (timer) clearTimeout(timer);
        });
    } catch (err: any) {
      this._isReady = false;
      this.infrastructureState.setRedisState('DOWN', err.message);
      this.logger.error(
        `[STARTUP] Redis client initialization error: ${err.message}. Operating in resilient in-memory mode.`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
    }
    this.memoryDb.clear();
  }

  getClient(): Redis | null {
    return this.redisClient;
  }

  private getFromMemory(key: string): string | null {
    const item = this.memoryDb.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.memoryDb.delete(key);
      return null;
    }
    return item.value;
  }

  private setInMemory(key: string, value: string, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity;
    this.memoryDb.set(key, { value, expiresAt });
  }

  private deleteFromMemory(key: string): void {
    this.memoryDb.delete(key);
  }

  private getKeysFromMemory(pattern: string): string[] {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const matched: string[] = [];
    for (const [k, v] of this.memoryDb.entries()) {
      if (regex.test(k) && Date.now() <= v.expiresAt) {
        matched.push(k);
      }
    }
    return matched;
  }

  async get(key: string): Promise<string | null> {
    if (!this._isReady || !this.redisClient) {
      return this.getFromMemory(key);
    }
    try {
      return await this.redisClient.get(key);
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] get failed for '${key}': ${err.message}. Using in-memory fallback.`,
        );
        this.lastErrorLogTime = now;
      }
      return this.getFromMemory(key);
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this._isReady || !this.redisClient) {
      this.setInMemory(key, value, ttlSeconds);
      return;
    }
    try {
      if (ttlSeconds) {
        await this.redisClient.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.redisClient.set(key, value);
      }
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] set failed for '${key}': ${err.message}. Saving in-memory instead.`,
        );
        this.lastErrorLogTime = now;
      }
      this.setInMemory(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    if (!this._isReady || !this.redisClient) {
      this.deleteFromMemory(key);
      return;
    }
    try {
      await this.redisClient.del(key);
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] del failed for '${key}': ${err.message}. Deleting from memory instead.`,
        );
        this.lastErrorLogTime = now;
      }
      this.deleteFromMemory(key);
    }
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this._isReady || !this.redisClient) {
      return this.getKeysFromMemory(pattern);
    }
    try {
      return (await this.redisClient.keys(pattern)) || [];
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] keys failed for pattern '${pattern}': ${err.message}. Searching memory instead.`,
        );
        this.lastErrorLogTime = now;
      }
      return this.getKeysFromMemory(pattern);
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this._isReady || !this.redisClient) {
      const item = this.memoryDb.get(key);
      if (item) {
        item.expiresAt = Date.now() + ttlSeconds * 1000;
      }
      return;
    }
    try {
      await this.redisClient.expire(key, ttlSeconds);
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] expire failed for '${key}': ${err.message}. Updating in-memory instead.`,
        );
        this.lastErrorLogTime = now;
      }
      const item = this.memoryDb.get(key);
      if (item) {
        item.expiresAt = Date.now() + ttlSeconds * 1000;
      }
    }
  }

  async ttl(key: string): Promise<number> {
    if (!this._isReady || !this.redisClient) {
      const item = this.memoryDb.get(key);
      if (!item || Date.now() > item.expiresAt) {
        if (item) this.memoryDb.delete(key);
        return -2; // Redis standard for non-existent key
      }
      if (item.expiresAt === Infinity) return -1; // Redis standard for key with no expiration
      return Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000));
    }
    try {
      return await this.redisClient.ttl(key);
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] ttl failed for '${key}': ${err.message}. Calculating from memory instead.`,
        );
        this.lastErrorLogTime = now;
      }
      const item = this.memoryDb.get(key);
      if (!item || Date.now() > item.expiresAt) {
        if (item) this.memoryDb.delete(key);
        return -2;
      }
      if (item.expiresAt === Infinity) return -1;
      return Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000));
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this._isReady || !this.redisClient) {
      const item = this.memoryDb.get(key);
      if (!item) return false;
      if (Date.now() > item.expiresAt) {
        this.memoryDb.delete(key);
        return false;
      }
      return true;
    }
    try {
      const count = await this.redisClient.exists(key);
      return count > 0;
    } catch (err: any) {
      const now = Date.now();
      if (now - this.lastErrorLogTime > 10000) {
        this.logger.warn(
          `[Redis] exists failed for '${key}': ${err.message}. Checking memory instead.`,
        );
        this.lastErrorLogTime = now;
      }
      const item = this.memoryDb.get(key);
      if (!item) return false;
      if (Date.now() > item.expiresAt) {
        this.memoryDb.delete(key);
        return false;
      }
      return true;
    }
  }

  /**
   * Unified Cache Helper: Fetches from cache if available, otherwise runs fetcher, caches result, and returns.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    try {
      const cached = await this.get(key);
      if (cached !== null && cached !== undefined) {
        return JSON.parse(cached) as T;
      }
    } catch {
      // Ignore JSON parse errors and proceed to fetcher
    }

    const freshData = await fetcher();
    if (freshData !== undefined && freshData !== null) {
      try {
        await this.set(key, JSON.stringify(freshData), ttlSeconds);
      } catch {
        // Cache set failure shouldn't fail the request
      }
    }
    return freshData;
  }
}
