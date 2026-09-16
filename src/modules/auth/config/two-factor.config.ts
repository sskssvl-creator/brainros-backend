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

  readonly enable2FA: boolean;
  readonly otpProvider: 'TWILIO' | '2FACTOR' | 'MSG91';
  readonly twilioAccountSid: string;
  readonly twilioAuthToken: string;
  readonly twilioVerifyServiceSid: string;
  readonly twoFactorApiKey: string;
  readonly twoFactorTemplateName: string;
  readonly devBypassOtp: string;

  readonly otpTtl: number;
  readonly resendCooldown: number;
  readonly maxAttempts: number;
  readonly otpLength: number;
  readonly maxRequestsPerHour: number;

  constructor(private readonly configService: ConfigService) {
    const rawEnable =
      this.configService.get<string | boolean>('ENABLE_REAL_OTP') ??
      this.configService.get<string | boolean>('ENABLE_2FA') ??
      this.configService.get<string | boolean>('ENABLE_OTP') ??
      process.env.ENABLE_REAL_OTP ??
      process.env.ENABLE_2FA ??
      process.env.ENABLE_OTP;

    this.enable2FA = parseSafeBoolean(rawEnable, 'ENABLE_REAL_OTP', false);

    // Twilio Verify Credentials
    this.twilioAccountSid = (
      this.configService.get<string>('TWILIO_ACCOUNT_SID') ??
      process.env.TWILIO_ACCOUNT_SID ??
      ''
    ).trim();

    this.twilioAuthToken = (
      this.configService.get<string>('TWILIO_AUTH_TOKEN') ??
      process.env.TWILIO_AUTH_TOKEN ??
      ''
    ).trim();

    this.twilioVerifyServiceSid = (
      this.configService.get<string>('TWILIO_VERIFY_SERVICE_SID') ??
      process.env.TWILIO_VERIFY_SERVICE_SID ??
      ''
    ).trim();

    const rawProvider = String(
      this.configService.get<string>('OTP_PROVIDER') ||
      process.env.OTP_PROVIDER ||
      (this.twilioAccountSid && this.twilioVerifyServiceSid ? 'TWILIO' : 'TWILIO'),
    )
      .trim()
      .toUpperCase();

    this.otpProvider =
      rawProvider === '2FACTOR'
        ? '2FACTOR'
        : rawProvider === 'MSG91'
          ? 'MSG91'
          : 'TWILIO';

    // 2Factor.in API Key
    this.twoFactorApiKey =
      this.configService.get<string>('TWO_FACTOR_API_KEY') ??
      this.configService.get<string>('TWOFACTOR_API_KEY') ??
      process.env.TWO_FACTOR_API_KEY ??
      process.env.TWOFACTOR_API_KEY ??
      '';

    if (this.enable2FA && this.otpProvider === 'TWILIO' && (!this.twilioAccountSid || !this.twilioVerifyServiceSid)) {
      this.logger.warn(
        '[SECURITY] ENABLE_REAL_OTP is true and OTP_PROVIDER is TWILIO, but TWILIO_ACCOUNT_SID or TWILIO_VERIFY_SERVICE_SID is missing.',
      );
    }

    this.twoFactorTemplateName =
      this.configService.get<string>('TWO_FACTOR_TEMPLATE_NAME') ??
      process.env.TWO_FACTOR_TEMPLATE_NAME ??
      '';

    // Development bypass OTP code (default: 12345)
    // Only used when enable2FA === false. Strictly ignored when enable2FA === true.
    this.devBypassOtp =
      this.configService.get<string>('DEV_BYPASS_OTP') ??
      this.configService.get<string>('DEV_OTP_CODE') ??
      process.env.DEV_BYPASS_OTP ??
      process.env.DEV_OTP_CODE ??
      '12345';

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
      `TwoFactorConfig initialized: [ENABLE_REAL_OTP = ${this.enable2FA ? 'TRUE (Active Gateway: ' + this.otpProvider + ')' : 'FALSE (Development Bypass: ' + this.devBypassOtp + ')'}]`,
    );
  }
}
