import {
  Controller,
  Post,
  Patch,
  Body,
  Get,
  Delete,
  Param,
  UseGuards,
  Request,
  Response,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  ForbiddenException,
  Query,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { LoginEmailDto } from './dto/login-email.dto';
import { LoginStudentIdDto } from './dto/login-student-id.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpLoginDto } from './dto/verify-otp.dto';
import { RegisterStudentDto } from './dto/register-student.dto';
import { VerifyRegistrationOtpDto } from './dto/verify-registration-otp.dto';
import {
  CreateRegistrationPaymentOrderDto,
  VerifyRegistrationPaymentDto,
} from './dto/registration-payment.dto';
import {
  RequestPasswordlessLoginOtpDto,
  VerifyPasswordlessLoginOtpDto,
} from './dto/passwordless-login.dto';
import {
  RegisterSendOtpDto,
  RegisterVerifyOtpDto,
} from './dto/register-otp.dto';
import { LoginSendOtpDto, LoginVerifyOtpDto } from './dto/login-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  REFRESH_COOKIE_NAME,
  setAuthCookies,
  clearAuthCookies,
} from './utils/cookie.util';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // 1. REGISTRATION ENDPOINTS (MSG91 / OTP)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Step A: Check if mobile already registered. If yes, reject. If new, trigger sendOtp(mobileNumber).
   * POST /auth/register/send-otp
   * @deprecated B2B mode — public registration disabled
   */
  @Post('register/send-otp')
  @HttpCode(HttpStatus.OK)
  async registerSendOtp(
    @Body() dto: RegisterSendOtpDto,
    @Request() req: any,
  ) {
    throw new ForbiddenException(
      'Public registration is no longer available. Students are registered through their school administration.',
    );
  }

  /**
   * Step B: Verify OTP using verifyOtp(mobileNumber, otp).
   * If valid, save new user record in DB, issue session/JWT token, return user details.
   * POST /auth/register/verify-otp
   */
  /**
   * @deprecated B2B mode — public registration disabled
   */
  @Post('register/verify-otp')
  @HttpCode(HttpStatus.CREATED)
  async registerVerifyOtp(
    @Body() dto: RegisterVerifyOtpDto,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    throw new ForbiddenException(
      'Public registration is no longer available. Students are registered through their school administration.',
    );
  }

  /**
   * Check if mobile number or email is available before proceeding through registration
   * POST /auth/check-availability
   */
  @Post('check-availability')
  @HttpCode(HttpStatus.OK)
  async checkAvailability(@Body() body: { phone?: string; email?: string }) {
    return this.authService.checkAvailability(body.phone, body.email);
  }

  /**
   * Full Student Registration: creates pending registration state in Redis,
   * sends OTP to mobile number, and returns requiresOtp.
   * POST /auth/register
   */
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Body() dto: RegisterStudentDto, @Request() req: any) {
    return this.authService.registerStudent(dto, req);
  }

  /**
   * Verify full student registration OTP: verifies OTP and submits student registration
   * to the Approval Queue (requires General Manager or Super Admin approval).
   * POST /auth/verify-registration-otp
   */
  @Post('verify-registration-otp')
  @HttpCode(HttpStatus.OK)
  async verifyRegistrationOtp(
    @Body() dto: VerifyRegistrationOtpDto,
    @Request() req: any,
  ) {
    return this.authService.verifyRegistrationOtp(dto, req);
  }

  /**
   * Create Razorpay Payment Order for Public Student Registration.
   * POST /auth/register/payment/order
   */
  @Post('register/payment/order')
  @HttpCode(HttpStatus.OK)
  async createRegistrationPaymentOrder(
    @Body() dto: CreateRegistrationPaymentOrderDto,
    @Request() req: any,
  ) {
    return this.authService.createRegistrationPaymentOrder(dto, req);
  }

  /**
   * Verify Razorpay Payment Signature and Server Status for Public Registration.
   * POST /auth/register/payment/verify
   */
  @Post('register/payment/verify')
  @HttpCode(HttpStatus.OK)
  async verifyRegistrationPayment(
    @Body() dto: VerifyRegistrationPaymentDto,
    @Request() req: any,
  ) {
    return this.authService.verifyRegistrationPayment(dto, req);
  }

  /**
   * Check Registration Payment Status.
   * GET /auth/register/payment/status/:registrationId
   */
  @Get('register/payment/status/:registrationId')
  @HttpCode(HttpStatus.OK)
  async getRegistrationPaymentStatus(
    @Param('registrationId') registrationId: string,
  ) {
    return this.authService.getRegistrationPaymentStatus(registrationId);
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. LOGIN ENDPOINTS (MSG91 / OTP)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Step A: Check if user exists in database. If not, reject with "User not found".
   * If found, trigger sendOtp(mobileNumber).
   * POST /auth/login/send-otp
   */
  @Post('login/send-otp')
  @HttpCode(HttpStatus.OK)
  async loginSendOtp(@Body() dto: LoginSendOtpDto, @Request() req: any) {
    return this.authService.loginSendOtp(dto, req);
  }

  /**
   * Step B: Verify the OTP using verifyOtp(mobileNumber, otp).
   * If valid, generate and return session/JWT token and user profile.
   * POST /auth/login/verify-otp
   */
  @Post('login/verify-otp')
  @HttpCode(HttpStatus.OK)
  async loginVerifyOtp(
    @Body() dto: LoginVerifyOtpDto,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const result =
      dto.loginRequestId && this.authService.verifyPasswordlessLoginOtp
        ? await this.authService.verifyPasswordlessLoginOtp(dto as any, req)
        : await this.authService.loginVerifyOtp(dto, req);

    setAuthCookies(res, this.configService, {
      accessToken: result.data?.accessToken,
      refreshToken: result.data?.refreshToken,
    });
    return result;
  }

  /**
   * Backward-compatible alias: verifyPasswordlessLoginOtp
   */
  async verifyPasswordlessLoginOtp(
    dto: VerifyPasswordlessLoginOtpDto,
    req: any,
    res: ExpressResponse,
  ) {
    const result = this.authService.verifyPasswordlessLoginOtp
      ? await this.authService.verifyPasswordlessLoginOtp(dto, req)
      : await this.authService.loginVerifyOtp(dto as any, req);

    setAuthCookies(res, this.configService, {
      accessToken: result.data?.accessToken,
      refreshToken: result.data?.refreshToken,
    });
    return result;
  }

  /**
   * Unified request login OTP (accepts email, student ID, or mobile number)
   * POST /auth/login/request-otp
   */
  @Post('login/request-otp')
  @HttpCode(HttpStatus.OK)
  async requestPasswordlessLoginOtp(
    @Body() dto: RequestPasswordlessLoginOtpDto,
    @Request() req: any,
  ) {
    return this.authService.requestPasswordlessLoginOtp(dto, req);
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. OTP RESEND ENDPOINT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resend OTP (with cooldown and attempt protection)
   * POST /auth/otp/resend
   */
  @Post('otp/resend')
  @HttpCode(HttpStatus.OK)
  async resendOtp(@Body() dto: ResendOtpDto, @Request() req: any) {
    return this.authService.resendOtp(dto, req);
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. GENERAL / BACKWARD-COMPATIBLE OTP ENDPOINTS
  // ═══════════════════════════════════════════════════════════════

  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  async requestOtp(@Body() dto: RequestOtpDto, @Request() req: any) {
    return this.authService.sendOtp(dto.phone, dto.purpose as any, req);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtpAndLogin(
    @Body() dto: any,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    if (dto.token) {
      const result = await this.authService.verifyAccessToken(dto.token, req);
      setAuthCookies(res, this.configService, {
        accessToken: result.data?.accessToken,
        refreshToken: result.data?.refreshToken,
      });
      return result;
    }

    const result = await this.authService.verifyOtpAndLogin(
      dto.mobileNumber,
      dto.otp,
      dto.purpose,
      req,
    );
    setAuthCookies(res, this.configService, {
      accessToken: result.data?.accessToken,
      refreshToken: result.data?.refreshToken,
    });
    return result;
  }

  @Get('otp/check-user')
  @HttpCode(HttpStatus.OK)
  async checkUserExists(@Query('identifier') identifier: string) {
    return this.authService.checkUserExists(identifier);
  }

  /**
   * Public endpoint to get current OTP configuration (bypass mode, code, length)
   * GET /auth/otp-config
   */
  @Get('otp-config')
  @HttpCode(HttpStatus.OK)
  async getOtpConfig() {
    return {
      message: 'OTP configuration retrieved successfully',
      data: this.authService.getOtpConfig(),
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // 5. LEGACY PASSWORD & OAUTH ENDPOINTS
  // ═══════════════════════════════════════════════════════════════

  @Post('login/email')
  @HttpCode(HttpStatus.OK)
  async loginWithEmail(
    @Body() dto: LoginEmailDto,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const result = await this.authService.loginWithEmail(
      dto.email,
      dto.password,
      req,
    );
    setAuthCookies(res, this.configService, {
      accessToken: result.data?.accessToken,
      refreshToken: result.data?.refreshToken,
    });
    return result;
  }

  @Post('login/student-id')
  @HttpCode(HttpStatus.OK)
  async loginWithStudentId(
    @Body() dto: LoginStudentIdDto,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const result = await this.authService.loginWithStudentId(
      dto.studentId,
      dto.password,
      req,
    );
    setAuthCookies(res, this.configService, {
      accessToken: result.data?.accessToken,
      refreshToken: result.data?.refreshToken,
    });
    return result;
  }

  /**
   * @deprecated B2B mode — Google login disabled
   */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async loginWithGoogle(
    @Body() dto: GoogleLoginDto,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    throw new ForbiddenException(
      'Google login has been disabled. Please use your mobile number or Student ID to login.',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. TOKEN REFRESH & SESSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Rotate and refresh Access + Refresh Token pair using HttpOnly cookie or header.
   * POST /auth/refresh
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshSession(
    @Headers('x-refresh-token') headerToken: string,
    @Body('refreshToken') bodyToken: string,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const cookieToken =
      req.cookies?.[REFRESH_COOKIE_NAME] ||
      req.cookies?.refreshToken ||
      req.cookies?.refresh_token;
    const refreshToken = cookieToken || headerToken || bodyToken;

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is missing.');
    }

    const result = await this.authService.refreshSession(refreshToken, req);
    setAuthCookies(res, this.configService, {
      accessToken: result.data?.accessToken,
      refreshToken: result.data?.refreshToken,
    });

    return result;
  }

  /**
   * Revoke current session and clear HttpOnly cookies.
   * POST /auth/logout
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Headers('x-refresh-token') headerToken: string,
    @Body('refreshToken') bodyToken: string,
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const cookieToken =
      req.cookies?.[REFRESH_COOKIE_NAME] ||
      req.cookies?.['refresh_token'] ||
      req.cookies?.['refreshToken'];
    const refreshToken = cookieToken || headerToken || bodyToken;

    if (refreshToken) {
      await this.authService.logout(refreshToken, req).catch(() => {});
    }

    clearAuthCookies(res, this.configService);

    return { message: 'Logged out successfully.' };
  }

  /**
   * Revoke all user sessions and clear HttpOnly cookies.
   * POST /auth/logout-all
   */
  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @Request() req: any,
    @Response({ passthrough: true }) res: ExpressResponse,
  ) {
    const result = await this.authService.logoutAll(req.user.userId, req);
    clearAuthCookies(res, this.configService);
    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async getSessions(@Request() req: any) {
    return this.authService.getSessions(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  async revokeSession(@Param('id') sessionId: string, @Request() req: any) {
    return this.authService.revokeSession(req.user.userId, sessionId, req);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: any) {
    const userProfile = await this.authService.getMe(req.user.userId);
    return {
      message: 'Profile retrieved successfully',
      data: userProfile,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(['me', 'profile'])
  async updateMe(
    @Request() req: any,
    @Body()
    dto: {
      name?: string;
      email?: string;
      mobileNumber?: string;
      phone?: string;
      password?: string;
    },
  ) {
    const updated = await this.authService.updateMe(req.user.userId, dto);
    return {
      message: 'Profile updated successfully',
      data: updated,
    };
  }

  @Get('options')
  async getRegisterOptions() {
    const options = await this.authService.getRegisterOptions();
    return {
      message: 'Registration options retrieved successfully',
      data: options,
    };
  }
}
