import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { Twilio } from 'twilio';

@Injectable()
export class TwilioOtpService {
  private readonly logger = new Logger(TwilioOtpService.name);
  private twilioClient: Twilio | null = null;
  private accountSid: string = '';
  private authToken: string = '';
  private apiKey: string = '';
  private apiSecret: string = '';
  private verifyServiceSid: string = '';
  private isConfigured: boolean = false;

  constructor(private readonly configService: ConfigService) {
    this.initializeTwilioClient();
  }

  /**
   * Reads Twilio credentials from environment and initializes the client.
   * Handles cases where env vars may be swapped by detecting standard Twilio prefixes.
   */
  private initializeTwilioClient(): void {
    // Step 1: Read each env var directly
    const envAccountSid = (
      this.configService.get<string>('TWILIO_ACCOUNT_SID') ||
      process.env.TWILIO_ACCOUNT_SID ||
      ''
    ).trim();

    const envAuthToken = (
      this.configService.get<string>('TWILIO_AUTH_TOKEN') ||
      process.env.TWILIO_AUTH_TOKEN ||
      ''
    ).trim();

    const envVerifySid = (
      this.configService.get<string>('TWILIO_VERIFY_SERVICE_SID') ||
      process.env.TWILIO_VERIFY_SERVICE_SID ||
      ''
    ).trim();

    const envApiKey = (
      this.configService.get<string>('TWILIO_API_KEY') ||
      process.env.TWILIO_API_KEY ||
      ''
    ).trim();

    const envApiSecret = (
      this.configService.get<string>('TWILIO_API_SECRET') ||
      process.env.TWILIO_API_SECRET ||
      ''
    ).trim();

    // Step 2: Collect all non-empty values for prefix-based auto-detection
    const candidates = [
      { label: 'TWILIO_ACCOUNT_SID', value: envAccountSid },
      { label: 'TWILIO_AUTH_TOKEN', value: envAuthToken },
      { label: 'TWILIO_VERIFY_SERVICE_SID', value: envVerifySid },
      { label: 'TWILIO_API_KEY', value: envApiKey },
      { label: 'TWILIO_API_SECRET', value: envApiSecret },
    ].filter((c) => c.value.length > 0);

    // Step 3: Detect by Twilio prefix regardless of which env var holds the value
    for (const c of candidates) {
      if (c.value.startsWith('AC') && !this.accountSid) {
        this.accountSid = c.value;
      }
      if (c.value.startsWith('SK') && !this.apiKey) {
        this.apiKey = c.value;
      }
      if (c.value.startsWith('VA') && !this.verifyServiceSid) {
        this.verifyServiceSid = c.value;
      }
    }

    // Step 4: Fallback — if no AC-prefixed value was found, use env var as-is
    if (!this.accountSid && envAccountSid) {
      this.accountSid = envAccountSid;
    }

    // Step 5: Set the Verify Service SID from its env var if not already set by prefix detection
    if (!this.verifyServiceSid && envVerifySid) {
      this.verifyServiceSid = envVerifySid;
    }

    // Step 6: Set API Secret directly from its env var (NOT via dedup filter)
    if (envApiSecret) {
      this.apiSecret = envApiSecret;
    }

    // Step 7: Set Auth Token directly from its env var (NOT via dedup filter)
    if (envAuthToken) {
      this.authToken = envAuthToken;
    }

    // Log resolved config (masked)
    this.logger.log(
      `Twilio config resolved: accountSid=${this.accountSid ? this.maskSid(this.accountSid) : '(empty)'}, ` +
      `apiKey=${this.apiKey ? this.maskSid(this.apiKey) : '(empty)'}, ` +
      `apiSecret=${this.apiSecret ? '(set)' : '(empty)'}, ` +
      `authToken=${this.authToken ? '(set)' : '(empty)'}, ` +
      `verifyServiceSid=${this.verifyServiceSid ? this.maskSid(this.verifyServiceSid) : '(empty)'}`,
    );

    // Step 8: Initialize Twilio client
    try {
      if (this.apiKey && this.apiSecret && this.accountSid) {
        // API Key + API Secret + Account SID authentication
        this.twilioClient = twilio(this.apiKey, this.apiSecret, {
          accountSid: this.accountSid,
        });
        this.isConfigured = true;
        this.logger.log(
          `Twilio Client initialized via API Key (${this.maskSid(this.apiKey)}) for Account (${this.maskSid(this.accountSid)})`,
        );
      } else if (this.accountSid && this.authToken) {
        // Account SID + Auth Token authentication
        this.twilioClient = twilio(this.accountSid, this.authToken);
        this.isConfigured = true;
        this.logger.log(
          `Twilio Client initialized via Account SID (${this.maskSid(this.accountSid)})`,
        );
      } else {
        this.isConfigured = false;
        this.logger.error(
          'Twilio client NOT initialized. Missing credentials. ' +
          'Required: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, or TWILIO_ACCOUNT_SID + TWILIO_API_KEY + TWILIO_API_SECRET.',
        );
      }
    } catch (err: any) {
      this.logger.error(`Failed to initialize Twilio client: ${err?.message || err}`);
      this.isConfigured = false;
    }
  }

  /**
   * Returns the Verify Service SID.
   * If not explicitly configured, attempts to auto-discover from Twilio account.
   */
  public async getVerifyServiceSid(): Promise<string> {
    // If we already have a Verify Service SID (from env or previously discovered), use it
    if (this.verifyServiceSid && this.verifyServiceSid.trim().length > 0) {
      return this.verifyServiceSid.trim();
    }

    // No Verify Service SID — try to auto-discover or create one
    if (!this.twilioClient) {
      throw new InternalServerErrorException(
        'Twilio Verify gateway is not properly configured on the server.',
      );
    }

    try {
      this.logger.log('[Twilio] Attempting to auto-discover Verify Service...');
      const services = await this.twilioClient.verify.v2.services.list({
        limit: 5,
      });

      if (services && services.length > 0) {
        this.verifyServiceSid = services[0].sid;
        this.logger.log(
          `Auto-discovered Twilio Verify Service: ${this.maskSid(this.verifyServiceSid)} (${services[0].friendlyName})`,
        );
        return this.verifyServiceSid;
      }

      this.logger.log('[Twilio] No existing Verify Services found. Creating one...');
      const createdService = await this.twilioClient.verify.v2.services.create({
        friendlyName: 'Brainros Login OTP',
      });
      this.verifyServiceSid = createdService.sid;
      this.logger.log(
        `Created new Twilio Verify Service: ${this.maskSid(this.verifyServiceSid)}`,
      );
      return this.verifyServiceSid;
    } catch (err: any) {
      this.logger.error(
        `Failed to resolve Twilio Verify Service: ${err?.message || err}. Ensure TWILIO_VERIFY_SERVICE_SID is configured in .env.`,
      );
      throw new InternalServerErrorException(
        'SMS verification service is temporarily unavailable. Please try again later.',
      );
    }
  }

  /**
   * Helper: Mask SID for safe logging
   */
  private maskSid(sid: string): string {
    if (!sid || sid.length < 8) return '****';
    return sid.substring(0, 4) + '...' + sid.substring(sid.length - 4);
  }

  /**
   * Helper: Mask phone number for safe logging
   */
  public maskPhone(phone: string): string {
    if (!phone || phone.length < 4) return '******';
    return '******' + phone.slice(-4);
  }

  /**
   * Normalizes mobile number to E.164 format (+919876543210)
   */
  public normalizeMobile(rawPhone: string): string {
    const clean = rawPhone.replace(/[^\d+]/g, '');
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
   * Checks whether Twilio Verify is configured and active
   */
  public hasValidConfiguration(): boolean {
    return this.isConfigured && this.twilioClient !== null;
  }

  /**
   * Sends OTP verification code via Twilio Verify API
   */
  async sendVerification(
    mobileNumber: string,
    channel: 'sms' | 'whatsapp' = 'sms',
  ): Promise<{ sessionId: string; status: string }> {
    if (!this.hasValidConfiguration() || !this.twilioClient) {
      this.logger.error('Twilio Verify service is not configured on this server.');
      throw new InternalServerErrorException(
        'Twilio Verify gateway is not properly configured on the server.',
      );
    }

    const formattedMobile = this.normalizeMobile(mobileNumber);
    const serviceSid = await this.getVerifyServiceSid();

    this.logger.log(
      `[Twilio Verify] Initiating SMS verification for ${this.maskPhone(formattedMobile)} via service ${this.maskSid(serviceSid)}`,
    );

    try {
      const verification = await this.twilioClient.verify.v2
        .services(serviceSid)
        .verifications.create({
          to: formattedMobile,
          channel,
        });

      this.logger.log(
        `[Twilio Verify] Verification initiated successfully. Status: ${verification.status}, SID: ${verification.sid}`,
      );

      return {
        sessionId: verification.sid,
        status: verification.status,
      };
    } catch (error: any) {
      this.logger.error(
        `[Twilio Verify] sendVerification failed for ${this.maskPhone(formattedMobile)}: [Code: ${error?.code}] ${error?.message || error}`,
      );

      // Map Twilio error codes to user-friendly messages
      const errorCode = error?.code;
      if (
        errorCode === 60200 ||
        errorCode === 21211 ||
        errorCode === 21614 ||
        errorCode === 60205
      ) {
        throw new BadRequestException(
          'Invalid mobile number format. Please check the mobile number and try again.',
        );
      }

      if (errorCode === 60203 || errorCode === 60212 || errorCode === 20429) {
        throw new BadRequestException(
          'Too many verification attempts. Please wait a few minutes before trying again.',
        );
      }

      throw new InternalServerErrorException(
        'Unable to send verification OTP. Please try again in a few moments.',
      );
    }
  }

  /**
   * Verifies the user-entered OTP against Twilio Verify Check API
   */
  async checkVerification(
    mobileNumber: string,
    otpCode: string,
  ): Promise<boolean> {
    if (!this.hasValidConfiguration() || !this.twilioClient) {
      this.logger.error('Twilio Verify service is not configured on this server.');
      throw new InternalServerErrorException(
        'Twilio Verify gateway is not properly configured on the server.',
      );
    }

    const cleanOtp = (otpCode || '').trim();
    if (!cleanOtp) {
      throw new BadRequestException('Verification code is required.');
    }

    const formattedMobile = this.normalizeMobile(mobileNumber);
    const serviceSid = await this.getVerifyServiceSid();

    this.logger.log(
      `[Twilio Verify] Checking verification code for ${this.maskPhone(formattedMobile)}`,
    );

    try {
      const verificationCheck = await this.twilioClient.verify.v2
        .services(serviceSid)
        .verificationChecks.create({
          to: formattedMobile,
          code: cleanOtp,
        });

      const isApproved = verificationCheck.status === 'approved';

      this.logger.log(
        `[Twilio Verify] Verification check result for ${this.maskPhone(formattedMobile)}: status=${verificationCheck.status}, approved=${isApproved}`,
      );

      return isApproved;
    } catch (error: any) {
      this.logger.error(
        `[Twilio Verify] checkVerification failed for ${this.maskPhone(formattedMobile)}: [Code: ${error?.code}] ${error?.message || error}`,
      );

      const errorCode = error?.code;
      // 60202: Verification check was not found / expired
      if (errorCode === 60202) {
        throw new BadRequestException(
          'Verification code has expired or was not requested. Please request a new OTP.',
        );
      }

      // 60203: Max check attempts reached
      if (errorCode === 60203 || errorCode === 20429) {
        throw new BadRequestException(
          'Maximum verification attempts exceeded. Please request a new OTP.',
        );
      }

      return false;
    }
  }
}
