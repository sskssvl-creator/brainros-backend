import { Injectable, BadRequestException, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { SecurityEventService } from '../services/security-event.service';
import { TwoFactorConfig } from '../config/two-factor.config';
import { TwoFactorDotInProvider } from './two-factor-dot-in.provider';
import { TwoFactorProvider } from '../otp/two-factor.provider';
import { DevelopmentOtpProvider } from './development-otp.provider';
import { TwilioVerifyProvider } from './twilio-verify.provider';
import {
  ITwoFactorProvider,
  OtpPurpose,
  TwoFactorSessionData,
} from './two-factor.provider.interface';

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly config: TwoFactorConfig,
    private readonly redisService: RedisService,
    private readonly securityEventService: SecurityEventService,
    private readonly twoFactorDotInProvider: TwoFactorDotInProvider,
    private readonly msg91Provider: TwoFactorProvider,
    private readonly devProvider: DevelopmentOtpProvider,
    @Optional()
    private readonly twilioVerifyProvider?: TwilioVerifyProvider,
  ) {}

  /**
   * Deterministically returns the active 2FA/OTP provider based solely
   * on server-side ENABLE_2FA and OTP_PROVIDER configurations.
   */
  getActiveProvider(): ITwoFactorProvider {
    if (this.config.enable2FA) {
      // Explicit provider selection based on OTP_PROVIDER env var
      if (
        this.config.otpProvider === 'TWILIO' &&
        this.twilioVerifyProvider &&
        typeof this.twilioVerifyProvider.sendOtp === 'function'
      ) {
        return this.twilioVerifyProvider;
      }
      if (
        this.config.otpProvider === '2FACTOR' &&
        this.twoFactorDotInProvider &&
        typeof this.twoFactorDotInProvider.sendOtp === 'function'
      ) {
        return this.twoFactorDotInProvider;
      }
      if (
        this.config.otpProvider === 'MSG91' &&
        this.msg91Provider &&
        typeof this.msg91Provider.sendOtp === 'function'
      ) {
        return this.msg91Provider;
      }
      // Fallback chain: Twilio → 2Factor → MSG91
      if (
        this.twilioVerifyProvider &&
        typeof this.twilioVerifyProvider.sendOtp === 'function'
      ) {
        return this.twilioVerifyProvider;
      }
      if (
        this.twoFactorDotInProvider &&
        typeof this.twoFactorDotInProvider.sendOtp === 'function'
      ) {
        return this.twoFactorDotInProvider;
      }
      if (
        this.msg91Provider &&
        typeof this.msg91Provider.sendOtp === 'function'
      ) {
        return this.msg91Provider;
      }
    }
    return this.devProvider;
  }

  /**
   * Returns whether 2FA is running in real mode or development bypass mode.
   */
  isRealMode(): boolean {
    return this.config.enable2FA;
  }

  /**
   * Normalizes mobile numbers to E.164 format (starts with +)
   */
  normalizeMobileNumber(mobileNumber: string): string {
    const clean = mobileNumber.replace(/[^\d+]/g, '');

    // Standard Indian number rules
    if (clean.startsWith('+91') && clean.length === 13) {
      return clean;
    }
    if (clean.startsWith('91') && clean.length === 12) {
      return `+${clean}`;
    }
    if (clean.length === 10) {
      return `+91${clean}`;
    }
    if (!clean.startsWith('+')) {
      return `+${clean}`;
    }
    return clean;
  }

  /**
   * Purpose-scoped Redis key builders
   */
  otpKey(purpose: OtpPurpose, mobile: string): string {
    return `otp:${purpose}:${mobile}`;
  }

  cooldownKey(purpose: OtpPurpose, mobile: string): string {
    return `otp:cooldown:${purpose}:${mobile}`;
  }

  attemptsKey(purpose: OtpPurpose, mobile: string): string {
    return `otp:attempts:${purpose}:${mobile}`;
  }

  rateLimitKey(mobile: string): string {
    return `otp:ratelimit:${mobile}`;
  }

  ipRateLimitKey(ip: string): string {
    return `otp:ip:ratelimit:${ip}`;
  }

  /**
   * Sends OTP or initiates OTP challenge through the active provider.
   *
   * Preserves purpose-scoped Redis keys, rate limiting, and cooldown checks.
   */
  async sendOtp(
    rawMobileNumber: string,
    purpose: OtpPurpose,
    requestContext?: {
      ipAddress?: string;
      userAgent?: string;
      userId?: string;
    },
  ): Promise<{ expiresIn: number; resendAvailableIn: number }> {
    const mobileNumber = this.normalizeMobileNumber(rawMobileNumber);
    const provider = this.getActiveProvider();

    this.logger.log(
      `[2FA] sendOtp requested for destination with purpose: ${purpose} [mode=${provider.providerName}]`,
    );

    // 1. Check rate limits (hourly request limits apply to live SMS gateways)
    let currentRequests: string | null = null;
    const rateLimitKeyStr = this.rateLimitKey(mobileNumber);
    if (this.config.enable2FA) {
      currentRequests = await this.redisService.get(rateLimitKeyStr);
      if (
        currentRequests &&
        parseInt(currentRequests, 10) >= this.config.maxRequestsPerHour
      ) {
        throw new BadRequestException(
          'Too many OTP requests. Please try again later.',
        );
      }

      // 2. Check per-IP rate limit (if IP available)
      if (requestContext?.ipAddress) {
        const ipKey = this.ipRateLimitKey(requestContext.ipAddress);
        const ipRequests = await this.redisService.get(ipKey);
        if (
          ipRequests &&
          parseInt(ipRequests, 10) >= this.config.maxRequestsPerHour * 2
        ) {
          throw new BadRequestException(
            'Too many OTP requests from this address. Please try again later.',
          );
        }
      }
    }

    // 3. Check Resend Cooldown
    const cooldownKeyStr = this.cooldownKey(purpose, mobileNumber);
    if (this.config.resendCooldown > 0) {
      const isCooldownActive = await this.redisService.get(cooldownKeyStr);
      if (isCooldownActive) {
        throw new BadRequestException(
          `Please wait ${this.config.resendCooldown} seconds before requesting another OTP.`,
        );
      }
    }

    // 4. Delegate to active provider
    // REAL mode: triggers Twilio SMS
    // DEV mode: creates local challenge with hash without external API call
    const providerResult = await provider.sendOtp(mobileNumber, purpose);

    // 5. Store session in Redis with TTL
    const sessionData: TwoFactorSessionData = {
      sessionId: providerResult.sessionId,
      providerManaged: providerResult.providerManaged,
      otpHash: providerResult.otpHash,
    };

    await this.redisService.set(
      this.otpKey(purpose, mobileNumber),
      JSON.stringify(sessionData),
      this.config.otpTtl,
    );

    // 6. Set Cooldown
    if (this.config.resendCooldown > 0) {
      await this.redisService.set(
        cooldownKeyStr,
        '1',
        this.config.resendCooldown,
      );
    }

    // 7. Reset attempts
    await this.redisService.del(this.attemptsKey(purpose, mobileNumber));

    // 8. Increment rate limit counters (real SMS mode only)
    if (this.config.enable2FA) {
      const currentCount = currentRequests ? parseInt(currentRequests, 10) : 0;
      await this.redisService.set(
        rateLimitKeyStr,
        String(currentCount + 1),
        3600,
      );

      if (requestContext?.ipAddress) {
        const ipKey = this.ipRateLimitKey(requestContext.ipAddress);
        const ipCount = await this.redisService.get(ipKey);
        await this.redisService.set(
          ipKey,
          String((ipCount ? parseInt(ipCount, 10) : 0) + 1),
          3600,
        );
      }
    }

    // 9. Log security event (NEVER log the OTP value!)
    await this.securityEventService.log('OTP_REQUESTED', {
      userId: requestContext?.userId,
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      metadata: {
        mobile: mobileNumber,
        purpose,
        mode: provider.providerName,
      },
    });

    return {
      expiresIn: this.config.otpTtl,
      resendAvailableIn: this.config.resendCooldown,
    };
  }

  /**
   * Verifies OTP through the active provider with attempt tracking,
   * single-use enforcement, and purpose validation.
   */
  async verifyOtp(
    rawMobileNumber: string,
    otp: string,
    purpose: OtpPurpose,
    requestContext?: {
      ipAddress?: string;
      userAgent?: string;
      userId?: string;
    },
  ): Promise<boolean> {
    const mobileNumber = this.normalizeMobileNumber(rawMobileNumber);
    const provider = this.getActiveProvider();

    const otpKeyStr = this.otpKey(purpose, mobileNumber);
    const attemptsKeyStr = this.attemptsKey(purpose, mobileNumber);

    // 1. Check failed attempts limit
    const attemptsStr = await this.redisService.get(attemptsKeyStr);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;
    if (attempts >= this.config.maxAttempts) {
      await this.redisService.del(otpKeyStr);
      await this.redisService.del(attemptsKeyStr);

      await this.securityEventService.log('OTP_FAILED', {
        userId: requestContext?.userId,
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
        metadata: {
          mobile: mobileNumber,
          purpose,
          reason: 'MAX_ATTEMPTS_EXCEEDED',
          mode: provider.providerName,
        },
      });

      throw new BadRequestException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    // 2. Retrieve OTP session info from Redis if available
    let sessionData: TwoFactorSessionData | undefined = undefined;
    try {
      const sessionDataStr = await this.redisService.get(otpKeyStr);
      if (sessionDataStr) {
        sessionData = JSON.parse(sessionDataStr);
      } else if (!this.config.enable2FA) {
        throw new BadRequestException(
          'OTP has expired or has not been requested.',
        );
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      if (!this.config.enable2FA) {
        throw new BadRequestException(
          'OTP has expired or has not been requested.',
        );
      }
    }

    // 3. Verify OTP via the active provider (Twilio Verify in REAL mode)
    // REAL mode: calls Twilio VerificationCheck. Never falls back to 12345.
    // DEV mode: verifies against devBypassOtp hash locally.
    const isValid = await provider.verifyOtp(
      mobileNumber,
      otp,
      purpose,
      sessionData,
    );

    if (!isValid) {
      const nextAttempts = attempts + 1;
      if (nextAttempts >= this.config.maxAttempts) {
        await this.redisService.del(otpKeyStr);
        await this.redisService.del(attemptsKeyStr);

        await this.securityEventService.log('OTP_FAILED', {
          userId: requestContext?.userId,
          ipAddress: requestContext?.ipAddress,
          userAgent: requestContext?.userAgent,
          metadata: {
            mobile: mobileNumber,
            purpose,
            reason: 'MAX_ATTEMPTS_EXCEEDED',
            mode: provider.providerName,
          },
        });

        throw new BadRequestException(
          'Maximum verification attempts exceeded. Please request a new OTP.',
        );
      } else {
        await this.redisService.set(
          attemptsKeyStr,
          String(nextAttempts),
          this.config.otpTtl,
        );

        await this.securityEventService.log('OTP_FAILED', {
          userId: requestContext?.userId,
          ipAddress: requestContext?.ipAddress,
          userAgent: requestContext?.userAgent,
          metadata: {
            mobile: mobileNumber,
            purpose,
            attempt: nextAttempts,
            mode: provider.providerName,
          },
        });

        throw new BadRequestException(
          `Invalid OTP. Remaining attempts: ${this.config.maxAttempts - nextAttempts}.`,
        );
      }
    }

    // 4. Verification succeeded — invalidate OTP immediately (single-use enforcement)
    await this.redisService.del(otpKeyStr);
    await this.redisService.del(attemptsKeyStr);
    await this.redisService.del(this.cooldownKey(purpose, mobileNumber));

    // 5. Log success (NEVER log the OTP value!)
    await this.securityEventService.log('OTP_VERIFIED', {
      userId: requestContext?.userId,
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      metadata: {
        mobile: mobileNumber,
        purpose,
        mode: provider.providerName,
      },
    });

    return true;
  }

  /**
   * Resends OTP via active provider (e.g. MSG91 retry / 2Factor retry)
   */
  async resendOtp(
    rawMobileNumber: string,
    retryType: 'text' | 'voice' = 'text',
  ): Promise<boolean> {
    const mobileNumber = this.normalizeMobileNumber(rawMobileNumber);
    const provider = this.getActiveProvider();
    if (provider.providerName === 'REAL') {
      if ('retryOtp' in provider && typeof (provider as any).retryOtp === 'function') {
        return (provider as any).retryOtp(mobileNumber, retryType);
      }
    }
    return true;
  }
}
