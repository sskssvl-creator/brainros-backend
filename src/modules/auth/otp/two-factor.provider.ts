import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ITwoFactorProvider,
  OtpPurpose,
  TwoFactorProviderResult,
  TwoFactorSessionData,
} from '../two-factor/two-factor.provider.interface';

@Injectable()
export class TwoFactorProvider implements ITwoFactorProvider {
  readonly providerName = 'REAL' as const;
  private readonly logger = new Logger(TwoFactorProvider.name);
  private readonly baseUrl = 'https://control.msg91.com/api/v5/otp';

  constructor(private readonly configService: ConfigService) {}

  private getAuthKey(): string {
    const authKey =
      this.configService.get<string>('MSG91_AUTH_KEY') ||
      this.configService.get<string>('OTP_API_KEY') ||
      process.env.MSG91_AUTH_KEY;

    if (!authKey) {
      this.logger.error('MSG91 credentials missing.');
      throw new InternalServerErrorException(
        'SMS verification service is temporarily unavailable. Please try again later.',
      );
    }
    return authKey.trim();
  }

  private formatMobile(mobileNumber: string): string {
    const digits = mobileNumber.replace(/\D/g, '');
    if (digits.length === 10) {
      return `91${digits}`;
    }
    return digits;
  }

  /**
   * Triggers SMS OTP verification via MSG91 OTP API
   */
  async sendOtp(
    mobileNumber: string,
    purpose?: OtpPurpose,
  ): Promise<TwoFactorProviderResult> {
    const isRealEnabled =
      String(
        this.configService.get('ENABLE_REAL_OTP') ?? process.env.ENABLE_REAL_OTP,
      ).toLowerCase() === 'true' ||
      String(
        this.configService.get('ENABLE_2FA') ?? process.env.ENABLE_2FA,
      ).toLowerCase() === 'true';

    const formattedMobile = this.formatMobile(mobileNumber);

    if (!isRealEnabled) {
      this.logger.log(
        `[Development Bypass] Skipped MSG91 sendOtp for ${formattedMobile}`,
      );
      return { providerManaged: true };
    }

    const authKey = this.getAuthKey();

    const queryParams = new URLSearchParams({
      authkey: authKey,
      mobile: formattedMobile,
      otp_length: '6',
      otp_expiry: '5',
      realTimeResponse: '1',
    });

    const templateId =
      this.configService.get<string>('MSG91_TEMPLATE_ID') ||
      process.env.MSG91_TEMPLATE_ID;
    if (templateId) {
      queryParams.set('template_id', templateId);
    }

    this.logger.log(`[MSG91 OTP] Sending SMS OTP to ${formattedMobile} (Purpose: ${purpose || 'LOGIN'})`);

    try {
      const response = await fetch(
        `${this.baseUrl}?${queryParams.toString()}`,
        {
          method: 'POST',
          headers: {
            authkey: authKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(8000),
        },
      );

      const resData = (await response.json()) as {
        type?: string;
        message?: string;
        request_id?: string;
      };

      this.logger.log(`[MSG91 OTP] Send Response: ${JSON.stringify(resData)}`);

      const isSuccess =
        response.ok &&
        (resData.type === 'success' ||
          (resData.message &&
            resData.message.toLowerCase().includes('success')));

      if (!isSuccess) {
        this.logger.error(`MSG91 Send OTP failed: ${JSON.stringify(resData)}`);
        throw new BadRequestException(
          'Unable to send OTP. Please check your mobile number and try again.',
        );
      }

      return { providerManaged: true };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(
        `MSG91 connection error: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException(
        'SMS gateway is temporarily unavailable.',
      );
    }
  }

  /**
   * Verifies the user-entered OTP code via MSG91 Verify API
   */
  async verifyOtp(
    targetMobileOrSession: string,
    otp: string,
    purpose?: OtpPurpose,
    sessionData?: TwoFactorSessionData,
  ): Promise<boolean> {
    const isRealEnabled =
      String(
        this.configService.get('ENABLE_REAL_OTP') ?? process.env.ENABLE_REAL_OTP,
      ).toLowerCase() === 'true' ||
      String(
        this.configService.get('ENABLE_2FA') ?? process.env.ENABLE_2FA,
      ).toLowerCase() === 'true';

    const cleanOtp = (otp || '').trim();

    // Temporary database OTP login flow disabled.
    // Real Twilio Verify OTP is now used for login.
    // Re-enable only if explicitly required.
    /*
    const bypassOtp = (
      this.configService.get('DEV_BYPASS_OTP') ??
      this.configService.get('DEV_LOGIN_OTP') ??
      process.env.DEV_BYPASS_OTP ??
      process.env.DEV_LOGIN_OTP ??
      '123456'
    ).trim();

    const isBypassActive =
      String(this.configService.get('BYPASS_OTP') ?? process.env.BYPASS_OTP).toLowerCase() === 'true';

    // Development / Master OTP bypass check
    if (
      (!isRealEnabled || isBypassActive) ||
      (cleanOtp === bypassOtp || cleanOtp === '123456' || cleanOtp === '12345')
    ) {
      if (cleanOtp === bypassOtp || cleanOtp === '123456' || cleanOtp === '12345') {
        this.logger.log(
          `[OTP Bypass] Master/Development OTP ${otp} accepted for ${targetMobileOrSession}`,
        );
        return true;
      }
    }
    */

    const authKey = this.getAuthKey();
    const formattedMobile = this.formatMobile(targetMobileOrSession);

    const queryParams = new URLSearchParams({
      authkey: authKey,
      mobile: formattedMobile,
      otp: cleanOtp,
    });

    this.logger.log(`[MSG91 OTP] Verifying OTP for ${formattedMobile}`);

    try {
      const response = await fetch(
        `${this.baseUrl}/verify?${queryParams.toString()}`,
        {
          method: 'GET',
          headers: {
            authkey: authKey,
          },
          signal: AbortSignal.timeout(8000),
        },
      );

      const resData = (await response.json()) as {
        type?: string;
        message?: string;
      };

      this.logger.log(`[MSG91 OTP] Verify Response: ${JSON.stringify(resData)}`);

      const isValid = Boolean(
        response.ok &&
          (resData.type === 'success' ||
            (resData.message &&
              (resData.message.toLowerCase().includes('success') ||
                resData.message.toLowerCase().includes('verified') ||
                resData.message.toLowerCase().includes('already_verified')))),
      );

      if (isValid) {
        return true;
      }

      // Temporary database OTP login flow disabled.
      // Real Twilio Verify OTP is now used for login.
      // Re-enable only if explicitly required.
      /*
      if (resData.message && resData.message.toLowerCase().includes('invalid authkey')) {
        this.logger.warn(
          `[MSG91 OTP] MSG91 returned 'Invalid authkey' (Widget Key restricted). Checking master bypass code...`,
        );
        if (cleanOtp === bypassOtp || cleanOtp === '123456' || cleanOtp === '12345') {
          return true;
        }
      }
      */

      return false;
    } catch (err) {
      this.logger.error(
        `MSG91 Verification error: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException(
        'Verification gateway is temporarily unavailable.',
      );
    }
  }
}
