import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface Msg91SendOtpResponse {
  request_id?: string;
  type: 'success' | 'error';
  message?: string;
  code?: string | number;
}

export interface Msg91VerifyOtpResponse {
  message?: string;
  type: 'success' | 'error';
  code?: string | number;
}

@Injectable()
export class Msg91OtpService {
  private readonly logger = new Logger(Msg91OtpService.name);
  private authKey: string = '';
  private templateId: string = '';
  private senderId: string = '';
  private baseUrl: string = 'https://control.msg91.com/api/v5';
  private isConfigured: boolean = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    this.initializeCredentials();
  }

  private initializeCredentials(): void {
    this.authKey = (
      this.configService.get<string>('MSG91_AUTH_KEY') ||
      process.env.MSG91_AUTH_KEY ||
      ''
    ).trim();

    this.templateId = (
      this.configService.get<string>('MSG91_TEMPLATE_ID') ||
      process.env.MSG91_TEMPLATE_ID ||
      ''
    ).trim();

    this.senderId = (
      this.configService.get<string>('MSG91_SENDER_ID') ||
      process.env.MSG91_SENDER_ID ||
      ''
    ).trim();

    this.isConfigured = !!this.authKey;
    if (this.isConfigured) {
      this.logger.log(
        `[MSG91] Initialized with AuthKey: ${this.authKey.substring(0, 6)}... Template: ${this.templateId || 'None'}`,
      );
    } else {
      this.logger.warn('[MSG91] AuthKey not configured.');
    }
  }

  public hasValidConfiguration(): boolean {
    return this.isConfigured;
  }

  /**
   * Normalizes mobile number to MSG91 format (without leading +, e.g. 918320982232)
   */
  public normalizeMobile(rawPhone: string): string {
    const clean = (rawPhone || '').replace(/[^\d]/g, '');
    if (clean.startsWith('91') && clean.length === 12) {
      return clean;
    }
    if (clean.length === 10) {
      return `91${clean}`;
    }
    return clean;
  }

  public maskPhone(phone: string): string {
    if (!phone || phone.length < 4) return '******';
    return '******' + phone.slice(-4);
  }

  /**
   * Sends OTP verification code via MSG91 API v5
   */
  async sendVerification(
    mobileNumber: string,
    otpLength: number = 6,
    otpExpiryMinutes: number = 5,
  ): Promise<{ sessionId: string; status: string }> {
    if (!this.hasValidConfiguration()) {
      throw new InternalServerErrorException(
        'MSG91 OTP gateway is not configured on this server.',
      );
    }

    const formattedMobile = this.normalizeMobile(mobileNumber);
    let url = `${this.baseUrl}/otp?mobile=${formattedMobile}&authkey=${this.authKey}&otp_length=${otpLength}&otp_expiry=${otpExpiryMinutes}&realTimeResponse=1`;

    if (this.templateId) {
      url += `&template_id=${encodeURIComponent(this.templateId)}`;
    }
    if (this.senderId) {
      url += `&sender=${encodeURIComponent(this.senderId)}`;
    }

    this.logger.log(
      `[MSG91] Sending OTP to ${this.maskPhone(formattedMobile)}`,
    );

    try {
      const res$ = this.httpService.post<Msg91SendOtpResponse>(
        url,
        {},
        {
          headers: {
            authkey: this.authKey,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );

      const response = await firstValueFrom(res$);
      const data = response.data;

      if (data.type === 'error') {
        this.logger.error(
          `[MSG91] Send OTP failed: [Code: ${data.code}] ${data.message}`,
        );
        throw new BadRequestException(
          data.message || 'Failed to send OTP via MSG91.',
        );
      }

      this.logger.log(
        `[MSG91] OTP sent successfully to ${this.maskPhone(formattedMobile)}, requestId: ${data.request_id}`,
      );

      return {
        sessionId: data.request_id || `msg91-${Date.now()}`,
        status: 'pending',
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `[MSG91] Error sending OTP: ${error?.response?.data?.message || error?.message || error}`,
      );
      throw new InternalServerErrorException(
        error?.response?.data?.message ||
          'Unable to send verification OTP via MSG91. Please try again.',
      );
    }
  }

  /**
   * Verifies the OTP code via MSG91 Verify API
   */
  async checkVerification(
    mobileNumber: string,
    otpCode: string,
  ): Promise<boolean> {
    if (!this.hasValidConfiguration()) {
      throw new InternalServerErrorException(
        'MSG91 OTP gateway is not configured on this server.',
      );
    }

    const cleanOtp = (otpCode || '').trim();
    if (!cleanOtp) {
      throw new BadRequestException('Verification OTP code is required.');
    }

    const formattedMobile = this.normalizeMobile(mobileNumber);
    const url = `${this.baseUrl}/otp/verify?otp=${encodeURIComponent(cleanOtp)}&mobile=${formattedMobile}&authkey=${this.authKey}`;

    this.logger.log(
      `[MSG91] Verifying OTP for ${this.maskPhone(formattedMobile)}`,
    );

    try {
      const res$ = this.httpService.get<Msg91VerifyOtpResponse>(url, {
        headers: {
          authkey: this.authKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      const response = await firstValueFrom(res$);
      const data = response.data;

      if (data.type === 'error') {
        this.logger.warn(
          `[MSG91] Verify OTP rejected for ${this.maskPhone(formattedMobile)}: ${data.message}`,
        );
        if (
          data.message?.toLowerCase().includes('not match') ||
          data.message?.toLowerCase().includes('invalid') ||
          data.message?.toLowerCase().includes('not found')
        ) {
          throw new UnauthorizedException(
            'Invalid or expired OTP code. Please try again.',
          );
        }
        throw new BadRequestException(data.message || 'OTP verification failed.');
      }

      this.logger.log(
        `[MSG91] OTP successfully verified for ${this.maskPhone(formattedMobile)}`,
      );
      return true;
    } catch (error: any) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      this.logger.error(
        `[MSG91] Verification check error: ${error?.response?.data?.message || error?.message || error}`,
      );
      throw new InternalServerErrorException(
        'Verification service encountered an error. Please try again.',
      );
    }
  }

  /**
   * Resends OTP via MSG91 Retry API
   */
  async resendVerification(
    mobileNumber: string,
    retryType: 'text' | 'voice' = 'text',
  ): Promise<boolean> {
    if (!this.hasValidConfiguration()) {
      throw new InternalServerErrorException(
        'MSG91 OTP gateway is not configured on this server.',
      );
    }

    const formattedMobile = this.normalizeMobile(mobileNumber);
    const url = `${this.baseUrl}/otp/retry?authkey=${this.authKey}&mobile=${formattedMobile}&retrytype=${retryType}`;

    this.logger.log(
      `[MSG91] Resending OTP (${retryType}) to ${this.maskPhone(formattedMobile)}`,
    );

    try {
      const res$ = this.httpService.get<any>(url, {
        headers: {
          authkey: this.authKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      const response = await firstValueFrom(res$);
      const data = response.data;

      if (data.type === 'error') {
        this.logger.warn(
          `[MSG91] Resend OTP error for ${this.maskPhone(formattedMobile)}: ${data.message}`,
        );
        throw new BadRequestException(data.message || 'Failed to resend OTP.');
      }

      return true;
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`[MSG91] Resend error: ${error?.message || error}`);
      throw new InternalServerErrorException(
        'Unable to resend OTP. Please wait before retrying.',
      );
    }
  }
}
