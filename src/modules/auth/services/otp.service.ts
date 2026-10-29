import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { TwoFactorService } from '../two-factor/two-factor.service';
import { OtpPurpose } from '../two-factor/two-factor.provider.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth.service';
import {
  Msg91VerifyTokenResponse,
  CheckUserExistResponse,
} from '../interfaces/msg91-widget.interface';

export type { OtpPurpose };

/**
 * OtpService acts as the primary facade for OTP operations across the application,
 * cleanly delegating all OTP challenge generation and verification to the centralized
 * TwoFactorService, MSG91 OTP Widget API, and underlying providers.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly twoFactorService: TwoFactorService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {}

  /**
   * Normalizes mobile numbers to E.164 standard format (+91...)
   */
  normalizeMobileNumber(mobileNumber: string): string {
    return this.twoFactorService.normalizeMobileNumber(mobileNumber);
  }

  /**
   * Returns whether OTP is in bypass mode.
   */
  isBypassEnabled(): boolean {
    return this.twoFactorService.isBypassEnabled();
  }

  /**
   * Returns configured development bypass OTP code.
   */
  getDevBypassOtp(): string {
    return this.twoFactorService.getDevBypassOtp();
  }

  /**
   * Returns the expected OTP length.
   */
  getOtpLength(): number {
    return this.twoFactorService.getOtpLength();
  }

  /**
   * Sends an OTP or creates an OTP challenge based on server ENABLE_2FA configuration.
   */
  async sendOtp(
    rawMobileNumber: string,
    purpose: OtpPurpose = 'LOGIN',
    requestContext?: {
      ipAddress?: string;
      userAgent?: string;
      userId?: string;
    },
  ): Promise<{ expiresIn: number; resendAvailableIn: number }> {
    return this.twoFactorService.sendOtp(
      rawMobileNumber,
      purpose,
      requestContext,
    );
  }

  /**
   * Verifies an OTP code using the active provider (Real or Development).
   */
  async verifyOtp(
    rawMobileNumber: string,
    otp: string,
    purpose: OtpPurpose = 'LOGIN',
    requestContext?: {
      ipAddress?: string;
      userAgent?: string;
      userId?: string;
    },
  ): Promise<boolean> {
    return this.twoFactorService.verifyOtp(
      rawMobileNumber,
      otp,
      purpose,
      requestContext,
    );
  }

  /**
   * Resends OTP using active provider (MSG91 / 2Factor retry endpoint).
   */
  async resendOtp(
    rawMobileNumber: string,
    retryType: 'text' | 'voice' = 'text',
  ): Promise<boolean> {
    return this.twoFactorService.resendOtp(rawMobileNumber, retryType);
  }

  /**
   * Verifies an access token received from MSG91 OTP Widget using MSG91's Verify Access Token API.
   * On success, extracts the verified user identifier (phone or email), resolves the user,
   * creates a session, and returns application JWT tokens.
   */
  async verifyAccessToken(accessToken: string, req?: any): Promise<any> {
    if (!accessToken || !accessToken.trim()) {
      throw new BadRequestException('MSG91 access token is required.');
    }

    const authKey =
      this.configService.get<string>('MSG91_AUTH_KEY') ||
      process.env.MSG91_AUTH_KEY;
    const verifyUrl =
      this.configService.get<string>('MSG91_VERIFY_URL') ||
      process.env.MSG91_VERIFY_URL ||
      'https://api.msg91.com/api/v5/widget/verifyAccessToken';

    const candidateKeys = Array.from(
      new Set(
        [
          this.configService.get<string>('MSG91_AUTH_KEY'),
          process.env.MSG91_AUTH_KEY,
          '567446A9gJtDpx6a9a2e53P1',
          '567446TwYGGZ8O6a9ab826P1',
        ]
          .filter(Boolean)
          .map((k) => (k as string).trim()),
      ),
    );

    if (candidateKeys.length === 0) {
      this.logger.error('MSG91_AUTH_KEY environment variable is missing.');
      throw new BadRequestException(
        'MSG91_AUTH_KEY configuration is missing on the server.',
      );
    }

    let responseData: Msg91VerifyTokenResponse | null = null;

    try {
      this.logger.log(
        `Verifying MSG91 access_token against endpoint: ${verifyUrl}`,
      );

      for (const key of candidateKeys) {
        const res$ = this.httpService.post<Msg91VerifyTokenResponse>(
          verifyUrl,
          { 'access-token': accessToken.trim() },
          {
            headers: {
              authkey: key,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          },
        );

        const res = await firstValueFrom(res$);
        if (
          res.data &&
          (res.data as any).code !== '201' &&
          (res.data as any).message !== 'AuthenticationFailure'
        ) {
          responseData = res.data;
          break;
        }
      }

      if (!responseData) {
        throw new UnauthorizedException(
          'MSG91 token verification authentication failure.',
        );
      }
    } catch (error: any) {
      this.logger.error(
        `MSG91 verifyAccessToken HTTP call failed: ${error?.message || error}`,
        error?.stack,
      );

      if (error.response) {
        const errorData = error.response.data;
        const msg =
          errorData?.message ||
          errorData?.detail ||
          'MSG91 token verification failed.';
        throw new UnauthorizedException(msg);
      }

      throw new BadRequestException(
        'Failed to connect to MSG91 token verification service.',
      );
    }

    // Check MSG91 API error status flags
    if (
      responseData?.type === 'error' ||
      responseData?.type === 'failure' ||
      responseData?.status === 'error'
    ) {
      const errMsg =
        responseData.message ||
        responseData.detail ||
        'Invalid or expired MSG91 access token.';
      this.logger.warn(`MSG91 token verification rejected: ${errMsg}`);
      throw new UnauthorizedException(errMsg);
    }

    // Extract verified identifier (mobile number or email)
    const verifiedIdentifier =
      this.extractIdentifierFromMsg91Response(responseData);
    if (!verifiedIdentifier) {
      this.logger.error(
        `MSG91 verification succeeded but no phone/email identifier found in response: ${JSON.stringify(
          responseData,
        )}`,
      );
      throw new UnauthorizedException(
        'Could not extract verified phone number or email from MSG91 response.',
      );
    }

    this.logger.log(
      `MSG91 access_token verified successfully for identifier: ${verifiedIdentifier}`,
    );

    // Look up local user by verified identifier
    const user = await this.findUserByIdentifier(verifiedIdentifier);
    if (!user) {
      throw new NotFoundException(
        `No registered user account found with verified identifier: ${verifiedIdentifier}`,
      );
    }

    return this.authService.loginWithVerifiedUser(user, req);
  }

  /**
   * User Existence Validation API required by MSG91 widget configuration if enabled.
   * Checks whether a user exists with the given identifier (phone or email).
   */
  async checkUserExists(identifier: string): Promise<CheckUserExistResponse> {
    if (!identifier || !identifier.trim()) {
      return { user_found: false, identifier: identifier || '' };
    }

    const raw = identifier.trim();
    const user = await this.findUserByIdentifier(raw);

    return {
      user_found: !!user,
      identifier: raw,
    };
  }

  /**
   * Helper: Extracts phone number or email from MSG91 verifyAccessToken API response
   */
  private extractIdentifierFromMsg91Response(
    res: Msg91VerifyTokenResponse,
  ): string | null {
    if (!res) return null;

    if (res.mobile && typeof res.mobile === 'string' && res.mobile.trim()) {
      return res.mobile.trim();
    }
    if (res.email && typeof res.email === 'string' && res.email.trim()) {
      return res.email.trim();
    }
    if (
      res.identifier &&
      typeof res.identifier === 'string' &&
      res.identifier.trim()
    ) {
      return res.identifier.trim();
    }
    if (
      res.user?.mobile &&
      typeof res.user.mobile === 'string' &&
      res.user.mobile.trim()
    ) {
      return res.user.mobile.trim();
    }
    if (
      res.user?.phone &&
      typeof res.user.phone === 'string' &&
      res.user.phone.trim()
    ) {
      return res.user.phone.trim();
    }
    if (
      res.user?.email &&
      typeof res.user.email === 'string' &&
      res.user.email.trim()
    ) {
      return res.user.email.trim();
    }

    if (res.message && typeof res.message === 'string') {
      const msg = res.message.trim();
      if (/^\+?[0-9]{8,15}$/.test(msg) || msg.includes('@')) {
        return msg;
      }
    }

    return null;
  }

  /**
   * Helper: Searches database for user matching phone, email, or student code/id
   */
  private async findUserByIdentifier(identifier: string) {
    const raw = identifier.trim();
    const normalizedMobile =
      this.twoFactorService.normalizeMobileNumber(raw);
    const normalizedEmail = raw.includes('@') ? raw.toLowerCase() : raw;

    const tenDigit = normalizedMobile.replace(/^\+91/, '');
    return this.prisma.user.findFirst({
      where: {
        OR: [
          { mobileNumber: normalizedMobile },
          { phone: normalizedMobile },
          { mobileNumber: tenDigit },
          { phone: tenDigit },
          { mobileNumber: raw },
          { phone: raw },
          { email: normalizedEmail },
          {
            student: {
              OR: [
                { studentCode: { equals: raw, mode: 'insensitive' } },
                { studentId: { equals: raw, mode: 'insensitive' } },
              ],
            },
          },
        ],
      },
      include: { userRoles: { include: { role: true } }, student: true },
    });
  }
}
