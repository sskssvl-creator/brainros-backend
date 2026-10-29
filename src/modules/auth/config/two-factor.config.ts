import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Safely parses a string/boolean environment variable into a strict boolean.
 *
 * Prevents the common bug where `Boolean("false") === true`.
 * Valid true representations: 'true', '1', true
 * Valid false representations: 'false', '0', false, undefined, null, ''
 *
 * @throws Error if an invalid non-boolean value is supplied.
 */
export function parseSafeBoolean(
  value: string | boolean | undefined | null,
  varName = 'ENABLE_2FA',
  defaultValue = false,
): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  throw new Error(
    `Invalid boolean value for environment variable ${varName}: "${value}". Expected "true", "false", "1", or "0".`,
  );
}

@Injectable()
export class TwoFactorConfig {
  private readonly logger = new Logger(TwoFactorConfig.name);

  readonly bypassOtp: boolean;
  readonly enable2FA: boolean;
  readonly devBypassOtp: string;

  // MSG91 Credentials
  readonly msg91AuthKey: string;
  readonly msg91TemplateId: string;
  readonly msg91SenderId: string;
  readonly msg91VerifyUrl: string;

  // OTP limits
  readonly otpTtl: number;
  readonly resendCooldown: number;
  readonly maxAttempts: number;
  readonly otpLength: number;
  readonly maxRequestsPerHour: number;

  constructor(private readonly configService: ConfigService) {
    const rawBypass =
      this.configService.get<string | boolean>('BYPASS_OTP') ??
      process.env.BYPASS_OTP;

    if (rawBypass !== undefined && rawBypass !== null && rawBypass !== '') {
      this.bypassOtp = parseSafeBoolean(rawBypass, 'BYPASS_OTP', false);
    } else {
      // Graceful fallback for legacy flags
      const rawEnable =
        this.configService.get<string | boolean>('ENABLE_OTP') ??
        this.configService.get<string | boolean>('ENABLE_REAL_OTP') ??
        this.configService.get<string | boolean>('ENABLE_2FA') ??
        process.env.ENABLE_OTP ??
        process.env.ENABLE_REAL_OTP ??
        process.env.ENABLE_2FA;

      if (rawEnable !== undefined && rawEnable !== null && rawEnable !== '') {
        this.bypassOtp = !parseSafeBoolean(rawEnable, 'ENABLE_OTP', false);
      } else {
        this.bypassOtp = true;
      }
    }

    this.enable2FA = !this.bypassOtp;

    // MSG91 Credentials
    this.msg91AuthKey = (
      this.configService.get<string>('MSG91_AUTH_KEY') ??
      process.env.MSG91_AUTH_KEY ??
      ''
    ).trim();

    this.msg91TemplateId = (
      this.configService.get<string>('MSG91_TEMPLATE_ID') ??
      process.env.MSG91_TEMPLATE_ID ??
      ''
    ).trim();

    this.msg91SenderId = (
      this.configService.get<string>('MSG91_SENDER_ID') ??
      process.env.MSG91_SENDER_ID ??
      ''
    ).trim();

    this.msg91VerifyUrl = (
      this.configService.get<string>('MSG91_VERIFY_URL') ??
      process.env.MSG91_VERIFY_URL ??
      'https://api.msg91.com/api/v5/widget/verifyAccessToken'
    ).trim();

    if (!this.bypassOtp && !this.msg91AuthKey) {
      this.logger.warn(
        '[SECURITY] BYPASS_OTP is false (MSG91 active), but MSG91_AUTH_KEY is missing in .env.',
      );
    }

    // Development bypass OTP code (default: 123456)
    this.devBypassOtp =
      this.configService.get<string>('DEV_BYPASS_OTP') ??
      this.configService.get<string>('DEV_OTP_CODE') ??
      process.env.DEV_BYPASS_OTP ??
      process.env.DEV_OTP_CODE ??
      '123456';

    const rawTtl =
      this.configService.get('OTP_TTL_SECONDS') ?? process.env.OTP_TTL_SECONDS;
    this.otpTtl =
      rawTtl !== undefined && rawTtl !== null && rawTtl !== ''
        ? Number(rawTtl)
        : 300;

    const rawCooldown =
      this.configService.get('OTP_RESEND_COOLDOWN_SECONDS') ??
      process.env.OTP_RESEND_COOLDOWN_SECONDS;
    this.resendCooldown =
      rawCooldown !== undefined && rawCooldown !== null && rawCooldown !== ''
        ? Number(rawCooldown)
        : 60;

    const rawAttempts =
      this.configService.get('OTP_MAX_VERIFY_ATTEMPTS') ??
      process.env.OTP_MAX_VERIFY_ATTEMPTS;
    this.maxAttempts =
      rawAttempts !== undefined && rawAttempts !== null && rawAttempts !== ''
        ? Number(rawAttempts)
        : 5;

    const rawLength =
      this.configService.get('OTP_LENGTH') ?? process.env.OTP_LENGTH;
    this.otpLength =
      rawLength !== undefined && rawLength !== null && rawLength !== ''
        ? Number(rawLength)
        : 6;

    const rawMaxReqs =
      this.configService.get('OTP_MAX_REQUESTS_PER_HOUR') ??
      process.env.OTP_MAX_REQUESTS_PER_HOUR;
    this.maxRequestsPerHour =
      rawMaxReqs !== undefined && rawMaxReqs !== null && rawMaxReqs !== ''
        ? Number(rawMaxReqs)
        : 5;

    this.logger.log(
      `TwoFactorConfig initialized: [MODE = ${this.bypassOtp ? 'DEVELOPMENT BYPASS (Code: ' + this.devBypassOtp + ')' : 'PRODUCTION REAL (Gateway: MSG91)'}]`,
    );
  }
}
