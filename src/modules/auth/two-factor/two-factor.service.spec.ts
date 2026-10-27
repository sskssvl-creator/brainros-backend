import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { TwoFactorService } from './two-factor.service';
import { TwoFactorConfig } from '../config/two-factor.config';
import { TwilioVerifyProvider } from './twilio-verify.provider';
import { DevelopmentOtpProvider } from './development-otp.provider';
import { RedisService } from '../../redis/redis.service';
import { SecurityEventService } from '../services/security-event.service';

describe('TwoFactorService', () => {
  let service: TwoFactorService;
  let redisStorage: Map<string, string>;
  let redisServiceMock: any;
  let securityEventServiceMock: any;
  let twilioVerifyProviderMock: any;
  let realProviderMock: any;
  let devProviderMock: any;
  let config: TwoFactorConfig;

  const createService = (bypassOtp: boolean, devBypassOtp = '123456') => {
    redisStorage = new Map<string, string>();

    redisServiceMock = {
      get: jest.fn(async (key: string) => redisStorage.get(key) || null),
      set: jest.fn(async (key: string, val: string) => {
        redisStorage.set(key, val);
      }),
      del: jest.fn(async (key: string) => {
        redisStorage.delete(key);
      }),
    };

    securityEventServiceMock = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    twilioVerifyProviderMock = {
      providerName: 'REAL',
      sendOtp: jest.fn().mockResolvedValue({ sessionId: 'session-uuid-123', providerManaged: true }),
      verifyOtp: jest.fn(),
    };
    realProviderMock = twilioVerifyProviderMock;

    devProviderMock = {
      providerName: 'DEVELOPMENT',
      sendOtp: jest.fn().mockResolvedValue({
        sessionId: 'dev-session-test',
        providerManaged: false,
        otpHash: 'dummy-hash',
      }),
      verifyOtp: jest.fn((destination: string, otp: string) => {
        return Promise.resolve(otp === devBypassOtp || otp === '123456');
      }),
    };

    const configServiceMock = {
      get: jest.fn((key: string) => {
        if (key === 'BYPASS_OTP') return bypassOtp ? 'true' : 'false';
        if (key === 'DEV_BYPASS_OTP') return devBypassOtp;
        if (key === 'OTP_MAX_VERIFY_ATTEMPTS') return '3';
        if (key === 'OTP_RESEND_COOLDOWN_SECONDS') return '60';
        if (key === 'OTP_TTL_SECONDS') return '300';
        return undefined;
      }),
    } as any;

    config = new TwoFactorConfig(configServiceMock);

    return new TwoFactorService(
      config,
      redisServiceMock as RedisService,
      securityEventServiceMock as SecurityEventService,
      twilioVerifyProviderMock as TwilioVerifyProvider,
      devProviderMock as DevelopmentOtpProvider,
    );
  };

  describe('Mode Selection & Routing', () => {
    it('should select DevelopmentOtpProvider when BYPASS_OTP=true', () => {
      service = createService(true);
      expect(service.isRealMode()).toBe(false);
      expect(service.getActiveProvider()).toBe(devProviderMock);
    });

    it('should select TwilioVerifyProvider when BYPASS_OTP=false', () => {
      service = createService(false);
      expect(service.isRealMode()).toBe(true);
      expect(service.getActiveProvider()).toBe(twilioVerifyProviderMock);
    });
  });

  describe('When BYPASS_OTP=true (Development Mode)', () => {
    beforeEach(() => {
      service = createService(true, '12345');
    });

    it('sendOtp should use development provider and NOT call real provider', async () => {
      const res = await service.sendOtp('+919876543210', 'LOGIN');

      expect(devProviderMock.sendOtp).toHaveBeenCalledWith(
        '+919876543210',
        'LOGIN',
      );
      expect(realProviderMock.sendOtp).not.toHaveBeenCalled();
      expect(res.expiresIn).toBe(300);
      expect(res.resendAvailableIn).toBe(60);

      // Verify Redis state created
      expect(redisServiceMock.set).toHaveBeenCalledWith(
        'otp:LOGIN:+919876543210',
        expect.any(String),
        300,
      );
    });

    it('verifyOtp should succeed with development OTP "12345"', async () => {
      await service.sendOtp('+919876543210', 'LOGIN');

      const isValid = await service.verifyOtp('+919876543210', '12345', 'LOGIN');
      expect(isValid).toBe(true);

      // Verify single-use deletion
      expect(redisStorage.has('otp:LOGIN:+919876543210')).toBe(false);
      expect(securityEventServiceMock.log).toHaveBeenCalledWith(
        'OTP_VERIFIED',
        expect.objectContaining({
          metadata: expect.objectContaining({ mode: 'DEVELOPMENT' }),
        }),
      );
    });

    it('verifyOtp should fail with incorrect OTP and track attempts', async () => {
      await service.sendOtp('+919876543210', 'LOGIN');

      await expect(
        service.verifyOtp('+919876543210', '99999', 'LOGIN'),
      ).rejects.toThrow(BadRequestException);

      expect(redisStorage.get('otp:attempts:LOGIN:+919876543210')).toBe('1');
    });

    it('should lock out user after exceeding max verification attempts', async () => {
      await service.sendOtp('+919876543210', 'LOGIN');

      // Attempt 1
      await expect(
        service.verifyOtp('+919876543210', '00000', 'LOGIN'),
      ).rejects.toThrow(/Remaining attempts: 2/);

      // Attempt 2
      await expect(
        service.verifyOtp('+919876543210', '00000', 'LOGIN'),
      ).rejects.toThrow(/Remaining attempts: 1/);

      // Attempt 3 (limit reached = 3)
      await expect(
        service.verifyOtp('+919876543210', '00000', 'LOGIN'),
      ).rejects.toThrow(/Maximum verification attempts exceeded/);

      // OTP session must be wiped
      expect(redisStorage.has('otp:LOGIN:+919876543210')).toBe(false);
    });

    it('should reject verification if OTP has expired or does not exist', async () => {
      await expect(
        service.verifyOtp('+919876543210', '12345', 'LOGIN'),
      ).rejects.toThrow(/OTP has expired or has not been requested/);
    });

    it('should enforce resend cooldown', async () => {
      await service.sendOtp('+919876543210', 'LOGIN');

      await expect(
        service.sendOtp('+919876543210', 'LOGIN'),
      ).rejects.toThrow(/Please wait 60 seconds before requesting another OTP/);
    });
  });

  describe('When BYPASS_OTP=false (Real Production Mode)', () => {
    beforeEach(() => {
      service = createService(false, '12345');
    });

    it('sendOtp should call real provider and NOT development provider', async () => {
      await service.sendOtp('+919876543210', 'LOGIN');

      expect(realProviderMock.sendOtp).toHaveBeenCalledWith(
        '+919876543210',
        'LOGIN',
      );
      expect(devProviderMock.sendOtp).not.toHaveBeenCalled();
    });

    it('verifyOtp should call real provider and succeed when provider validates', async () => {
      realProviderMock.verifyOtp.mockResolvedValue(true);
      await service.sendOtp('+919876543210', 'LOGIN');

      const isValid = await service.verifyOtp(
        '+919876543210',
        '654321',
        'LOGIN',
      );
      expect(isValid).toBe(true);
      expect(realProviderMock.verifyOtp).toHaveBeenCalledWith(
        '+919876543210',
        '654321',
        'LOGIN',
        expect.any(Object),
      );
    });

    it('CRITICAL SECURITY: verifyOtp("12345") MUST NEVER bypass real provider in ENABLE_2FA=true', async () => {
      // Real provider rejects "12345" because it was not sent by real provider
      realProviderMock.verifyOtp.mockResolvedValue(false);
      await service.sendOtp('+919876543210', 'LOGIN');

      await expect(
        service.verifyOtp('+919876543210', '12345', 'LOGIN'),
      ).rejects.toThrow(/Invalid OTP/);

      // Real provider was checked; dev provider was NOT bypassed
      expect(realProviderMock.verifyOtp).toHaveBeenCalledWith(
        '+919876543210',
        '12345',
        'LOGIN',
        expect.any(Object),
      );
      expect(devProviderMock.verifyOtp).not.toHaveBeenCalled();
    });

    it('CRITICAL SECURITY: Real provider error MUST NOT fall back to 12345', async () => {
      realProviderMock.verifyOtp.mockRejectedValue(
        new InternalServerErrorException('SMS gateway down'),
      );
      await service.sendOtp('+919876543210', 'LOGIN');

      await expect(
        service.verifyOtp('+919876543210', '12345', 'LOGIN'),
      ).rejects.toThrow(InternalServerErrorException);

      // Must never call dev provider as fallback
      expect(devProviderMock.verifyOtp).not.toHaveBeenCalled();
    });
  });
});
