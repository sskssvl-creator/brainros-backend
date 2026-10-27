import { ConfigService } from '@nestjs/config';
import {
  parseSafeBoolean,
  TwoFactorConfig,
} from './two-factor.config';

describe('TwoFactorConfig & parseSafeBoolean', () => {
  describe('parseSafeBoolean', () => {
    it('should parse "true" and "1" as boolean true', () => {
      expect(parseSafeBoolean('true')).toBe(true);
      expect(parseSafeBoolean('TRUE')).toBe(true);
      expect(parseSafeBoolean(' True ')).toBe(true);
      expect(parseSafeBoolean('1')).toBe(true);
      expect(parseSafeBoolean(true)).toBe(true);
    });

    it('should parse "false" and "0" as boolean false (NOT true)', () => {
      // Crucial test: Boolean("false") is true in JS, but parseSafeBoolean("false") MUST be false
      expect(parseSafeBoolean('false')).toBe(false);
      expect(parseSafeBoolean('FALSE')).toBe(false);
      expect(parseSafeBoolean(' False ')).toBe(false);
      expect(parseSafeBoolean('0')).toBe(false);
      expect(parseSafeBoolean(false)).toBe(false);
    });

    it('should default to false when undefined, null, or empty string', () => {
      expect(parseSafeBoolean(undefined)).toBe(false);
      expect(parseSafeBoolean(null)).toBe(false);
      expect(parseSafeBoolean('')).toBe(false);
      expect(parseSafeBoolean(undefined, 'ENABLE_2FA', true)).toBe(true);
    });

    it('should throw an error on invalid non-boolean strings', () => {
      expect(() => parseSafeBoolean('invalid')).toThrow(
        /Invalid boolean value for environment variable ENABLE_2FA: "invalid"/,
      );
      expect(() => parseSafeBoolean('yes')).toThrow(
        /Invalid boolean value for environment variable ENABLE_2FA: "yes"/,
      );
      expect(() => parseSafeBoolean('no')).toThrow(
        /Invalid boolean value for environment variable ENABLE_2FA: "no"/,
      );
    });
  });

  describe('TwoFactorConfig class', () => {
    it('should load default configuration when flags are missing', () => {
      const configServiceMock = {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;

      const config = new TwoFactorConfig(configServiceMock);
      expect(config.bypassOtp).toBe(true);
      expect(config.enable2FA).toBe(false);
      expect(config.devBypassOtp).toBe('123456');
      expect(config.otpTtl).toBe(300);
      expect(config.resendCooldown).toBe(60);
      expect(config.maxAttempts).toBe(5);
    });

    it('should correctly configure BYPASS_OTP=false (production real mode)', () => {
      const configServiceMock = {
        get: jest.fn((key: string) => {
          if (key === 'BYPASS_OTP') return 'false';
          if (key === 'DEV_BYPASS_OTP') return '99999';
          return undefined;
        }),
      } as unknown as ConfigService;

      const config = new TwoFactorConfig(configServiceMock);
      expect(config.bypassOtp).toBe(false);
      expect(config.enable2FA).toBe(true);
      expect(config.devBypassOtp).toBe('99999');
    });

    it('should correctly configure BYPASS_OTP=true (development bypass mode)', () => {
      const configServiceMock = {
        get: jest.fn((key: string) => {
          if (key === 'BYPASS_OTP') return 'true';
          return undefined;
        }),
      } as unknown as ConfigService;

      const config = new TwoFactorConfig(configServiceMock);
      expect(config.bypassOtp).toBe(true);
      expect(config.enable2FA).toBe(false);
    });

    it('should fallback to legacy ENABLE_2FA when BYPASS_OTP is missing', () => {
      const configServiceMock = {
        get: jest.fn((key: string) => {
          if (key === 'ENABLE_2FA') return 'true';
          return undefined;
        }),
      } as unknown as ConfigService;

      const config = new TwoFactorConfig(configServiceMock);
      expect(config.bypassOtp).toBe(false);
      expect(config.enable2FA).toBe(true);
    });
  });
});
