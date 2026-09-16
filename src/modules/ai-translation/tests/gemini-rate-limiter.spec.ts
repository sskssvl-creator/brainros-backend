import { ConfigService } from '@nestjs/config';
import { GeminiRateLimiterService } from '../services/gemini-rate-limiter.service';
import { RedisService } from '../../redis/redis.service';

describe('GeminiRateLimiterService', () => {
  let rateLimiter: GeminiRateLimiterService;
  let mockConfigService: Partial<ConfigService>;
  let mockRedisService: Partial<RedisService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const configMap: Record<string, any> = {
          GEMINI_RATE_LIMIT_ENABLED: true,
          GEMINI_REQUESTS_PER_INTERVAL: 5,
          GEMINI_RATE_LIMIT_INTERVAL_MS: 1000,
          GEMINI_MIN_REQUEST_INTERVAL_MS: 50,
          GEMINI_RETRY_BUFFER_MS: 1000,
          REDIS_ENABLED: false,
        };
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      }),
    };

    mockRedisService = {
      isRedisAvailable: jest.fn().mockReturnValue(false),
      getClient: jest.fn().mockReturnValue(null),
    } as any;

    rateLimiter = new GeminiRateLimiterService(
      mockConfigService as ConfigService,
      mockRedisService as RedisService,
    );
  });

  describe('Local Sliding Window & Inter-Request Pacing', () => {
    it('should acquire slots and enforce min spacing interval', async () => {
      const start = Date.now();
      const release1 = await rateLimiter.acquireSlot();
      release1();
      const release2 = await rateLimiter.acquireSlot();
      release2();
      const elapsed = Date.now() - start;

      // 2 consecutive calls should have at least minRequestIntervalMs (50ms)
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('should pause all requests when global pause is triggered', async () => {
      // Pause for 150ms
      await rateLimiter.pauseGlobally(150, 'HTTP 429 Rate limited');

      const pauseRemaining = await rateLimiter.getRemainingPauseMs();
      expect(pauseRemaining).toBeGreaterThan(0);
      expect(pauseRemaining).toBeLessThanOrEqual(250);

      const start = Date.now();
      const release = await rateLimiter.acquireSlot();
      release();
      const elapsed = Date.now() - start;

      // Should have waited for the pause to expire
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(await rateLimiter.getRemainingPauseMs()).toBe(0);
    });
  });

  describe('Redis-backed Sliding Window', () => {
    it('should use Redis Lua script when Redis is ready', async () => {
      const mockRedisClient = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn().mockResolvedValue([1, 0]), // 1 = acquired, 0 = no wait
      };

      const customRedisService = {
        isEnabled: true,
        isReady: true,
        getClient: jest.fn().mockReturnValue(mockRedisClient),
      };

      const redisLimiter = new GeminiRateLimiterService(
        mockConfigService as ConfigService,
        customRedisService as any,
      );

      const release = await redisLimiter.acquireSlot();
      expect(typeof release).toBe('function');
      release();

      expect(mockRedisClient.eval).toHaveBeenCalled();
    });
  });
});
