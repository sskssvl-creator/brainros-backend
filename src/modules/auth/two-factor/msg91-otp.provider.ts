import { Injectable, Logger } from '@nestjs/common';
import { Msg91OtpService } from './msg91-otp.service';
import {
  ITwoFactorProvider,
  OtpPurpose,
  TwoFactorProviderResult,
  TwoFactorSessionData,
} from './two-factor.provider.interface';

@Injectable()
export class Msg91OtpProvider implements ITwoFactorProvider {
  readonly providerName = 'REAL' as const;
  private readonly logger = new Logger(Msg91OtpProvider.name);

  constructor(private readonly msg91OtpService: Msg91OtpService) {}

  /**
   * Sends OTP via MSG91 OTP API
   */
  async sendOtp(
    destination: string,
    purpose: OtpPurpose,
  ): Promise<TwoFactorProviderResult> {
    this.logger.log(
      `[MSG91 Provider] Sending OTP to destination for purpose: ${purpose}`,
    );

    const result = await this.msg91OtpService.sendVerification(destination);

    return {
      sessionId: result.sessionId,
      providerManaged: true,
    };
  }

  /**
   * Verifies OTP code using MSG91 Verify API
   */
  async verifyOtp(
    destination: string,
    otp: string,
    purpose: OtpPurpose,
    sessionData?: TwoFactorSessionData,
  ): Promise<boolean> {
    this.logger.log(
      `[MSG91 Provider] Checking OTP for destination for purpose: ${purpose}`,
    );

    return this.msg91OtpService.checkVerification(destination, otp);
  }

  /**
   * Resends OTP via MSG91 Retry API
   */
  async resendOtp(
    destination: string,
    retryType: 'text' | 'voice' = 'text',
  ): Promise<boolean> {
    this.logger.log(
      `[MSG91 Provider] Resending OTP (${retryType}) to destination`,
    );

    return this.msg91OtpService.resendVerification(destination, retryType);
  }
}
