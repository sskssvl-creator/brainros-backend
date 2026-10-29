import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService, OtpPurpose } from './services/otp.service';
import { TwoFactorService } from './two-factor/two-factor.service';
import { TokenService } from './services/token.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { OAuthService } from './services/oauth.service';
import { SecurityEventService } from './services/security-event.service';
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
import { RegisterSendOtpDto, RegisterVerifyOtpDto } from './dto/register-otp.dto';
import { LoginSendOtpDto, LoginVerifyOtpDto } from './dto/login-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { RedisService } from '../redis/redis.service';
import { CANONICAL_TARGET_EXAMS } from '../../common/constants/target-exam.constant';
import * as crypto from 'crypto';
import axios from 'axios';

export interface PendingRegistrationData {
  registrationId: string;
  mobile: string;
  email: string | null;
  name: string;
  state: string;
  district: string;
  stateId: string | null;
  districtId: string | null;
  schoolCollege: string;
  classId: string;
  preferredLanguageId: string;
  examTargetId: string;
  status: 'PENDING_OTP' | 'OTP_VERIFIED' | 'PAYMENT_PENDING' | 'VERIFIED' | 'COMPLETED';
  otpVerifiedAt?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  paidAt?: string;
  amountPaise?: number;
  createdAt: string;
}

export interface PendingLoginData {
  loginRequestId: string;
  userId: string;
  mobile: string;
  identifier: string;
  status: 'PENDING_OTP' | 'VERIFIED' | 'CONSUMED';
  createdAt: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly tokenService: TokenService,
    private readonly passwordService: PasswordService,
    private readonly sessionService: SessionService,
    private readonly oauthService: OAuthService,
    private readonly securityEventService: SecurityEventService,
    private readonly redisService: RedisService,
    @Optional()
    private readonly twoFactorService?: TwoFactorService,
  ) {}

  /**
   * Returns the centralized TwoFactorService instance, falling back to OtpService
   */
  private get twoFactor(): TwoFactorService | OtpService {
    return this.twoFactorService || this.otpService;
  }

  // ─── Helper: Extract request metadata ─────────────────────────
  private extractRequestContext(req: any) {
    return {
      ipAddress: req?.ip || req?.connection?.remoteAddress || undefined,
      userAgent: req?.headers?.['user-agent'] || undefined,
    };
  }

  // ─── Helper: Mask mobile number for public responses ──────────
  maskMobile(mobile: string): string {
    if (!mobile || mobile.length < 4) return '******';
    const last4 = mobile.slice(-4);
    return '******' + last4;
  }

  // ─── Helper: Build user response ──────────────────────────────
  private buildUserResponse(user: any) {
    const roles = (user.userRoles || []).map(
      (ur: any) => ur.role?.name || ur.role || ur,
    );
    return {
      userId: user.id,
      name: user.name || user.fullName || user.student?.name || null,
      email: user.email,
      mobileNumber: user.mobileNumber || user.phone,
      status: user.status,
      isVerified: user.isVerified,
      roles,
    };
  }

  // ─── Helper: Build full auth response ─────────────────────────
  private buildAuthResponse(
    user: any,
    sessionId: string,
    tokens: { accessToken: string; refreshToken: string; expiresIn: number },
    message: string,
  ) {
    return {
      message,
      data: {
        user: this.buildUserResponse(user),
        student: user.student
          ? {
              id: user.student.id,
              studentId: user.student.studentId,
              studentCode: user.student.studentCode,
              name: user.student.name,
            }
          : null,
        session: { sessionId },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
    };
  }

  // ─── Helper: Create session and tokens ────────────────────────
  private async createSessionAndTokens(userId: string, req: any) {
    const ctx = this.extractRequestContext(req);
    const session = await this.sessionService.createSession({
      userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    const tokens = await this.tokenService.generateTokens(userId, session.id);
    return { session, tokens };
  }

  // ─── Helper: Load user with roles ─────────────────────────────
  private async loadUserWithRoles(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: { include: { role: true } },
        student: {
          include: {
            studentClass: true,
            preferredLanguage: true,
            examTarget: true,
            stateRef: true,
            districtRef: true,
          },
        },
      },
    });
  }

  // ─── Helper: Verify account status ────────────────────────────
  private verifyAccountActive(user: any): void {
    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive.');
    }
    if (user.status === 'PENDING') {
      throw new UnauthorizedException(
        'Your account is pending approval. Please contact your school administration.',
      );
    }
    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedException('User account is suspended.');
    }
    if (user.status === 'INACTIVE' || user.status === 'ARCHIVED') {
      throw new UnauthorizedException('User account is not active.');
    }
    if (user.status === 'LOCKED') {
      throw new UnauthorizedException('User account is locked.');
    }
    if (user.status === 'DISABLED') {
      throw new UnauthorizedException('User account is disabled.');
    }
    if (user.status === 'DELETED') {
      throw new UnauthorizedException('User account has been deleted.');
    }
    // B2B: Check student-specific status if student profile is loaded
    if (user.student && user.student.status === 'PENDING') {
      throw new UnauthorizedException(
        'Your student account is pending approval. Please contact your school administration.',
      );
    }
    if (user.student && user.student.status === 'SUSPENDED') {
      throw new UnauthorizedException('Your student account has been suspended.');
    }
    if (user.student && user.student.status === 'INACTIVE') {
      throw new UnauthorizedException('Your student account is inactive.');
    }
  }

  // ─── MSG91 OTP Widget Authentication Methods ─────────────────

  /**
   * Completes login for a user who has verified identity via MSG91 OTP Widget
   */
  async loginWithVerifiedUser(user: any, req?: any) {
    this.verifyAccountActive(user);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        isVerified: true,
        mobileVerifiedAt: user.mobileVerifiedAt || new Date(),
      },
    });

    const fullUser = await this.loadUserWithRoles(user.id);
    const { session, tokens } = await this.createSessionAndTokens(
      user.id,
      req,
    );

    const ctx = this.extractRequestContext(req);
    await this.securityEventService.log('LOGIN_SUCCESS', {
      userId: user.id,
      ...ctx,
      metadata: { method: 'MSG91_OTP_WIDGET' },
    });

    return this.buildAuthResponse(
      fullUser,
      session.id,
      tokens,
      'Login successful via MSG91 OTP Widget',
    );
  }

  /**
   * Delegates MSG91 access token verification to OtpService
   */
  async verifyAccessToken(accessToken: string, req?: any) {
    return this.otpService.verifyAccessToken(accessToken, req);
  }

  /**
   * Delegates User Existence check to OtpService
   */
  async checkUserExists(identifier: string) {
    return this.otpService.checkUserExists(identifier);
  }


  // ═══════════════════════════════════════════════════════════════
  // 1. NEW OTP-BASED REGISTRATION FLOW (PASSWORDLESS)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if mobile number or email is already registered in the system
   */
  async checkAvailability(phone?: string, email?: string) {
    if (phone) {
      const normalizedMobile = this.otpService.normalizeMobileNumber(phone);
      const digitsOnly = phone.replace(/\D/g, '');
      const existingUserByMobile = await this.prisma.user.findFirst({
        where: {
          OR: [
            { mobileNumber: normalizedMobile },
            { phone: normalizedMobile },
            { mobileNumber: digitsOnly },
            { phone: digitsOnly },
          ],
        },
      });

      if (existingUserByMobile) {
        return {
          available: false,
          field: 'phone',
          message: 'A user with this mobile number already exists.',
        };
      }
    }

    if (email && email.trim()) {
      const normalizedEmail = email.toLowerCase().trim();
      const existingUserByEmail = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUserByEmail) {
        return {
          available: false,
          field: 'email',
          message: 'A user with this email address already exists.',
        };
      }
    }

    return {
      available: true,
      message: 'Mobile number and email are available.',
    };
  }

  /**
   * Submit registration data: validates input and master records,
   * stores temporary state in Redis, sends OTP, and returns requiresOtp.
   * Does NOT activate User or create Student ID before OTP verification.
   */
  async registerStudent(dto: RegisterStudentDto, req?: any) {
    const ctx = this.extractRequestContext(req);
    const {
      phone,
      name,
      email,
      state,
      district,
      stateId,
      districtId,
      schoolCollege,
      classId,
      preferredLanguageId,
      examTargetId,
    } = dto;

    const normalizedMobile = this.otpService.normalizeMobileNumber(phone);

    // 1. Check if mobile already exists
    const existingUserByMobile = await this.prisma.user.findFirst({
      where: {
        OR: [{ mobileNumber: normalizedMobile }, { phone: normalizedMobile }],
      },
    });

    if (existingUserByMobile) {
      throw new BadRequestException(
        'A user with this mobile number already exists.',
      );
    }

    // 2. Check if email already exists
    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const existingUserByEmail = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUserByEmail) {
        throw new BadRequestException('A user with this email already exists.');
      }
    }

    // 3. Validate master data references
    const [targetClass, targetLang, targetExam] = await Promise.all([
      this.prisma.studentClass.findUnique({ where: { id: classId } }),
      this.prisma.preferredLanguage.findUnique({
        where: { id: preferredLanguageId },
      }),
      this.prisma.examTarget.findUnique({ where: { id: examTargetId } }),
    ]);

    if (!targetClass)
      throw new NotFoundException('Selected class does not exist.');
    if (targetClass.name === 'FOUNDATION') {
      throw new BadRequestException(
        'Class FOUNDATION is no longer available.',
      );
    }
    if (!targetLang)
      throw new NotFoundException(
        'Selected preferred language does not exist.',
      );
    if (!targetExam)
      throw new NotFoundException('Selected exam target does not exist.');

    let resolvedStateName = state || '';
    let resolvedDistrictName = district || '';

    // Validate state & district
    if (stateId) {
      const stateRecord = await this.prisma.state.findUnique({
        where: { id: stateId },
      });
      if (!stateRecord)
        throw new NotFoundException('Selected state does not exist.');
      if (!stateRecord.isActive)
        throw new BadRequestException('Selected state is not active.');
      resolvedStateName = stateRecord.name;
    }

    if (districtId) {
      const districtRecord = await this.prisma.district.findUnique({
        where: { id: districtId },
      });
      if (!districtRecord)
        throw new NotFoundException('Selected district does not exist.');
      if (stateId && districtRecord.stateId !== stateId) {
        throw new BadRequestException(
          'Selected district does not belong to the selected state.',
        );
      }
      resolvedDistrictName = districtRecord.name;
    }

    // 4. Create temporary registration state in Redis
    const registrationId = `REG-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const pendingData: PendingRegistrationData = {
      registrationId,
      mobile: normalizedMobile,
      email: email ? email.toLowerCase().trim() : null,
      name: name.trim(),
      state: resolvedStateName,
      district: resolvedDistrictName,
      stateId: stateId || null,
      districtId: districtId || null,
      schoolCollege: schoolCollege.trim(),
      classId,
      preferredLanguageId,
      examTargetId,
      status: 'PENDING_OTP',
      createdAt: new Date().toISOString(),
    };

    // Store in Redis with 15 minutes (900s) TTL
    await this.redisService.set(
      `registration:${registrationId}`,
      JSON.stringify(pendingData),
      900,
    );

    // 5. Generate and send OTP via SMS provider
    await this.otpService.sendOtp(normalizedMobile, 'REGISTER', ctx);

    await this.securityEventService.log('OTP_REQUESTED', {
      ...ctx,
      metadata: {
        registrationId,
        purpose: 'REGISTER',
        mobile: normalizedMobile,
      },
    });

    return {
      message:
        'Registration initiated. OTP sent to your registered mobile number.',
      data: {
        requiresOtp: true,
        purpose: 'REGISTER',
        registrationId,
        mobileMasked: this.maskMobile(normalizedMobile),
        expiresIn: 300,
        resendAvailableIn: 60,
      },
    };
  }

  /**
   * Step 2: Verify registration OTP.
   * Validates OTP and updates registration status in Redis to 'OTP_VERIFIED'.
   * Does NOT save student DB record yet. User must complete payment first.
   */
  async verifyRegistrationOtp(dto: VerifyRegistrationOtpDto, req?: any) {
    const ctx = this.extractRequestContext(req);
    const { registrationId, otp } = dto;

    // 1. Load pending registration from Redis
    const rawData = await this.redisService.get(
      `registration:${registrationId}`,
    );
    if (!rawData) {
      throw new BadRequestException(
        'Registration session expired or invalid. Please register again.',
      );
    }

    const registration: PendingRegistrationData = JSON.parse(rawData);
    if (registration.status !== 'PENDING_OTP') {
      throw new BadRequestException(
        'Registration has already been processed or is invalid.',
      );
    }

    // 2. Verify OTP for purpose REGISTER
    await this.otpService.verifyOtp(registration.mobile, otp, 'REGISTER', ctx);

    // 3. Mark status as OTP_VERIFIED in Redis and extend TTL to 30 mins (1800s) for payment
    registration.status = 'OTP_VERIFIED';
    registration.otpVerifiedAt = new Date().toISOString();

    await this.redisService.set(
      `registration:${registrationId}`,
      JSON.stringify(registration),
      1800,
    );

    await this.securityEventService.log('OTP_VERIFIED', {
      ...ctx,
      metadata: {
        registrationId,
        purpose: 'REGISTER',
        mobile: registration.mobile,
      },
    });

    const feeAmount = Number(process.env.PUBLIC_REGISTRATION_FEE_INR || 300);

    return {
      message: 'OTP verified successfully. Please complete registration fee payment.',
      data: {
        otpVerified: true,
        registrationId,
        requiresPayment: true,
        feeAmount,
        currency: 'INR',
        razorpayApiKey: process.env.RAZORPAY_API_KEY || '',
      },
    };
  }

  /**
   * Step 3: Create Razorpay Order server-side.
   * Authoritative fee calculation happens here. Client amounts are strictly ignored.
   */
  async createRegistrationPaymentOrder(
    dto: CreateRegistrationPaymentOrderDto,
    req?: any,
  ) {
    const ctx = this.extractRequestContext(req);
    const { registrationId } = dto;

    const rawData = await this.redisService.get(
      `registration:${registrationId}`,
    );
    if (!rawData) {
      throw new BadRequestException(
        'Registration session expired or invalid. Please register again.',
      );
    }

    const registration: PendingRegistrationData = JSON.parse(rawData);
    if (
      registration.status !== 'OTP_VERIFIED' &&
      registration.status !== 'PAYMENT_PENDING'
    ) {
      throw new BadRequestException(
        'OTP verification required before initiating payment.',
      );
    }

    const apiKey = process.env.RAZORPAY_API_KEY;
    const apiSecret = process.env.RAZORPAY_API_SECRET;

    const feeAmountInr = Number(process.env.PUBLIC_REGISTRATION_FEE_INR || 300);
    const amountPaise = Math.round(feeAmountInr * 100); // Integer paise

    let razorpayOrderId = registration.razorpayOrderId;

    if (!razorpayOrderId || !apiKey || !apiSecret) {
      if (!apiKey || !apiSecret) {
        // Fallback for test mode if keys are not configured
        razorpayOrderId = `order_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      } else {
        try {
          const authHeader =
            'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
          const response = await axios.post(
            'https://api.razorpay.com/v1/orders',
            {
              amount: amountPaise,
              currency: 'INR',
              receipt: `rcpt_${registrationId.substring(0, 12)}`,
              notes: {
                registrationId,
                mobile: registration.mobile,
                name: registration.name,
              },
            },
            {
              headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json',
              },
            },
          );
          razorpayOrderId = response.data.id;
        } catch (error: any) {
          Logger.error(
            `Razorpay Order Creation Failed: ${error?.response?.data?.error?.description || error.message}`,
          );
          throw new BadRequestException(
            `Failed to create Razorpay payment order: ${error?.response?.data?.error?.description || 'Gateway error'}`,
          );
        }
      }
    }

    // Upsert PaymentTransaction record in database
    await this.prisma.paymentTransaction.upsert({
      where: { razorpayOrderId: razorpayOrderId! },
      update: {
        registrationId,
        amount: amountPaise,
        currency: 'INR',
        status: 'CREATED',
        metadata: {
          name: registration.name,
          mobile: registration.mobile,
          email: registration.email,
        },
      },
      create: {
        registrationId,
        razorpayOrderId: razorpayOrderId!,
        amount: amountPaise,
        currency: 'INR',
        status: 'CREATED',
        metadata: {
          name: registration.name,
          mobile: registration.mobile,
          email: registration.email,
        },
      },
    });

    // Update Redis session state
    registration.status = 'PAYMENT_PENDING';
    registration.razorpayOrderId = razorpayOrderId;
    registration.amountPaise = amountPaise;
    await this.redisService.set(
      `registration:${registrationId}`,
      JSON.stringify(registration),
      1800,
    );

    return {
      message: 'Payment order created successfully.',
      data: {
        registrationId,
        razorpayOrderId: razorpayOrderId!,
        amount: amountPaise,
        currency: 'INR',
        key: apiKey || 'rzp_test_mock',
        name: registration.name,
        email: registration.email || '',
        mobile: registration.mobile,
      },
    };
  }

  /**
   * Step 4: Verify Razorpay Payment Signature and Server Status.
   * On successful verification, finalizes and creates the student registration in PENDING approval state.
   */
  async verifyRegistrationPayment(
    dto: VerifyRegistrationPaymentDto,
    req?: any,
  ) {
    const ctx = this.extractRequestContext(req);
    const {
      registrationId,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    } = dto;

    // Load registration from Redis
    const rawData = await this.redisService.get(
      `registration:${registrationId}`,
    );
    if (!rawData) {
      // Check if registration was already finalized idempotently in DB
      const existingTx = await this.prisma.paymentTransaction.findFirst({
        where: { razorpayOrderId: razorpay_order_id, status: 'CAPTURED' },
        include: { student: true, user: true },
      });
      if (existingTx && existingTx.student) {
        return {
          message: 'Payment already verified and registration submitted successfully!',
          data: {
            requiresApproval: true,
            status: 'PENDING_APPROVAL',
            registrationId,
            student: {
              id: existingTx.student.id,
              studentId: existingTx.student.studentId,
              studentCode: existingTx.student.studentCode,
              name: existingTx.student.name,
              status: 'PENDING',
            },
          },
        };
      }
      throw new BadRequestException(
        'Registration session expired or invalid. Please try registering again.',
      );
    }

    const registration: PendingRegistrationData = JSON.parse(rawData);

    // Verify Order ID mapping
    if (
      registration.razorpayOrderId &&
      registration.razorpayOrderId !== razorpay_order_id
    ) {
      throw new BadRequestException(
        'Payment order mismatch for this registration session.',
      );
    }

    const apiSecret = process.env.RAZORPAY_API_SECRET;
    const apiKey = process.env.RAZORPAY_API_KEY;

    let signatureValid = false;

    if (apiSecret) {
      const generatedSignature = crypto
        .createHmac('sha256', apiSecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      signatureValid = crypto.timingSafeEqual(
        Buffer.from(generatedSignature),
        Buffer.from(razorpay_signature),
      );
    } else {
      // Allow test mode if secret is not set
      signatureValid = true;
    }

    if (!signatureValid) {
      await this.prisma.paymentTransaction.updateMany({
        where: { razorpayOrderId: razorpay_order_id },
        data: {
          status: 'VERIFICATION_FAILED',
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          signatureVerified: false,
          errorDescription: 'HMAC-SHA256 Signature verification failed',
        },
      });

      throw new BadRequestException(
        'Payment signature verification failed. Registration cannot be completed.',
      );
    }

    // Verify payment status with Razorpay API if credentials are provided
    if (apiKey && apiSecret && !razorpay_order_id.startsWith('order_test_')) {
      try {
        const authHeader =
          'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
        const paymentRes = await axios.get(
          `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
          { headers: { Authorization: authHeader } },
        );

        const paymentData = paymentRes.data;
        if (
          paymentData.status !== 'captured' &&
          paymentData.status !== 'authorized'
        ) {
          await this.prisma.paymentTransaction.updateMany({
            where: { razorpayOrderId: razorpay_order_id },
            data: {
              status: 'FAILED',
              razorpayPaymentId: razorpay_payment_id,
              errorDescription: `Razorpay status: ${paymentData.status}`,
            },
          });

          throw new BadRequestException(
            `Payment verification failed. Razorpay status is ${paymentData.status}.`,
          );
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        Logger.warn(
          `Razorpay payment status fetch failed: ${err?.message || err}`,
        );
      }
    }

    // Step 5: Persist Student + User + Payment Transaction in DB (Transaction)
    return await this.finalizeStudentRegistration(
      registration,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      ctx,
    );
  }

  /**
   * Finalizes public student registration in database after successful Razorpay payment verification.
   * Atomically creates User, Student, ApprovalRequest, PaymentTransaction, Order, and AuditLog.
   */
  async finalizeStudentRegistration(
    registration: PendingRegistrationData,
    razorpayOrderId: string,
    razorpayPaymentId: string,
    razorpaySignature: string,
    ctx: any,
  ) {
    const registrationId = registration.registrationId;

    // Idempotency check: see if PaymentTransaction with this order ID is already finalized
    const existingTx = await this.prisma.paymentTransaction.findUnique({
      where: { razorpayOrderId },
      include: { student: true, user: true },
    });

    if (existingTx && existingTx.status === 'CAPTURED' && existingTx.student) {
      await this.redisService.del(`registration:${registrationId}`);
      return {
        message: 'Registration submitted successfully! Your account is pending review by Academic Administration.',
        data: {
          requiresApproval: true,
          status: 'PENDING_APPROVAL',
          registrationId,
          student: {
            id: existingTx.student.id,
            studentId: existingTx.student.studentId,
            studentCode: existingTx.student.studentCode,
            name: existingTx.student.name,
            status: 'PENDING',
          },
        },
      };
    }

    const feeAmountInr = Number(process.env.PUBLIC_REGISTRATION_FEE_INR || 300);
    const amountPaise = registration.amountPaise || Math.round(feeAmountInr * 100);

    const result = await this.prisma.$transaction(async (tx) => {
      // Check existing user to prevent duplicates
      const existingUser = await tx.user.findFirst({
        where: {
          OR: [
            { mobileNumber: registration.mobile },
            { phone: registration.mobile },
            ...(registration.email ? [{ email: registration.email }] : []),
          ],
        },
      });

      if (existingUser) {
        throw new BadRequestException(
          'A user with this mobile number or email already exists in the system.',
        );
      }

      // 1. Create User in PENDING status (requires GM/Super Admin approval before active login)
      const newUser = await tx.user.create({
        data: {
          phone: registration.mobile,
          mobileNumber: registration.mobile,
          email: registration.email,
          status: 'PENDING',
          isVerified: true,
          isActive: true,
          mobileVerifiedAt: new Date(),
          emailVerifiedAt: registration.email ? new Date() : null,
        },
      });

      // 2. Ensure STUDENT role exists & assign
      let studentRole = await tx.role.findUnique({
        where: { name: 'STUDENT' },
      });
      if (!studentRole) {
        studentRole = await tx.role.create({ data: { name: 'STUDENT' } });
      }

      await tx.userRole.create({
        data: { userId: newUser.id, roleId: studentRole.id },
      });

      // 3. Generate unique Student ID & Code
      const year = new Date().getFullYear();
      let sequenceNum = (await tx.student.count()) + 1;
      let studentIdStr = `STU${String(sequenceNum + 1000).padStart(6, '0')}`;
      let studentCode = `BRN-${year}-${String(sequenceNum).padStart(6, '0')}`;

      let collision = await tx.student.findFirst({
        where: { OR: [{ studentCode }, { studentId: studentIdStr }] },
      });
      while (collision) {
        sequenceNum++;
        studentIdStr = `STU${String(sequenceNum + 1000).padStart(6, '0')}`;
        studentCode = `BRN-${year}-${String(sequenceNum).padStart(6, '0')}`;
        collision = await tx.student.findFirst({
          where: { OR: [{ studentCode }, { studentId: studentIdStr }] },
        });
      }

      // 4. Create Student profile in PENDING status
      const student = await tx.student.create({
        data: {
          userId: newUser.id,
          studentId: studentIdStr,
          studentCode,
          name: registration.name,
          state: registration.state,
          district: registration.district,
          stateId: registration.stateId,
          districtId: registration.districtId,
          schoolCollege: registration.schoolCollege,
          classId: registration.classId,
          preferredLanguageId: registration.preferredLanguageId,
          examTargetId: registration.examTargetId,
          status: 'PENDING',
          registrationSource: 'PUBLIC',
        },
      });

      // 5. Submit to Approval Queue for General Manager / Super Admin approval
      const approvalRequest = await tx.approvalRequest.create({
        data: {
          resourceType: 'STUDENT',
          resourceId: student.id,
          requestedById: newUser.id,
          status: 'PENDING',
          submittedAt: new Date(),
          metadata: {
            studentId: student.studentId,
            studentCode: student.studentCode,
            name: student.name,
            mobile: registration.mobile,
            email: registration.email,
            schoolCollege: registration.schoolCollege,
            state: registration.state,
            district: registration.district,
            registrationType: 'PUBLIC_STUDENT_REGISTRATION',
            razorpayOrderId,
            razorpayPaymentId,
            paidAmountInr: feeAmountInr,
          },
        },
      });

      // 6. Record PaymentTransaction in DB
      const paymentTx = await tx.paymentTransaction.upsert({
        where: { razorpayOrderId },
        update: {
          userId: newUser.id,
          studentId: student.id,
          razorpayPaymentId,
          razorpaySignature,
          signatureVerified: true,
          status: 'CAPTURED',
          paidAt: new Date(),
        },
        create: {
          registrationId,
          userId: newUser.id,
          studentId: student.id,
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature,
          signatureVerified: true,
          amount: amountPaise,
          currency: 'INR',
          status: 'CAPTURED',
          paidAt: new Date(),
        },
      });

      // 7. Record Order and Payment in system financial tables
      const orderNum = `ORD-REG-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const order = await tx.order.create({
        data: {
          orderNumber: orderNum,
          userId: newUser.id,
          studentId: student.id,
          amount: feeAmountInr,
          currency: 'INR',
          status: 'COMPLETED',
          itemType: 'STUDENT_REGISTRATION',
          itemName: 'Public Student Registration Fee',
        },
      });

      await tx.payment.create({
        data: {
          orderId: order.id,
          paymentNumber: `PAY-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
          amount: feeAmountInr,
          currency: 'INR',
          gateway: 'RAZORPAY',
          gatewayOrderId: razorpayOrderId,
          gatewayPaymentId: razorpayPaymentId,
          status: 'SUCCESS',
          paidAt: new Date(),
        },
      });

      return { user: newUser, student, approvalRequest, paymentTx };
    });

    // Clean up Redis session
    await this.redisService.del(`registration:${registrationId}`);

    // Log security event
    await this.securityEventService.log('REGISTER_SUCCESS', {
      userId: result.user.id,
      ...ctx,
      metadata: {
        method: 'PUBLIC_OTP_RAZORPAY_REGISTRATION',
        studentId: result.student.studentId,
        studentCode: result.student.studentCode,
        approvalRequestId: result.approvalRequest.id,
        razorpayOrderId,
        razorpayPaymentId,
        status: 'PENDING_APPROVAL',
      },
    });

    return {
      message:
        'Registration submitted successfully! Your account is pending review by Academic Administration. You will be notified once approved.',
      data: {
        requiresApproval: true,
        status: 'PENDING_APPROVAL',
        registrationId,
        student: {
          id: result.student.id,
          studentId: result.student.studentId,
          studentCode: result.student.studentCode,
          name: result.student.name,
          status: 'PENDING',
        },
      },
    };
  }

  /**
   * Query current payment / registration status for a registration session.
   */
  async getRegistrationPaymentStatus(registrationId: string) {
    const rawData = await this.redisService.get(
      `registration:${registrationId}`,
    );

    if (rawData) {
      const registration: PendingRegistrationData = JSON.parse(rawData);
      return {
        data: {
          registrationId,
          status: registration.status,
          razorpayOrderId: registration.razorpayOrderId || null,
          feeAmount: Number(process.env.PUBLIC_REGISTRATION_FEE_INR || 300),
          currency: 'INR',
        },
      };
    }

    const tx = await this.prisma.paymentTransaction.findFirst({
      where: { registrationId },
      include: { student: true },
    });

    if (tx) {
      return {
        data: {
          registrationId,
          status: tx.status === 'CAPTURED' ? 'COMPLETED' : tx.status,
          razorpayOrderId: tx.razorpayOrderId,
          razorpayPaymentId: tx.razorpayPaymentId,
          paidAt: tx.paidAt,
          studentId: tx.student?.studentId || null,
        },
      };
    }

    throw new NotFoundException('Registration payment session not found.');
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. UNIFIED PASSWORDLESS LOGIN FLOW
  // ═══════════════════════════════════════════════════════════════

  /**
   * Request Login OTP: Accepts Email, Student ID, or Mobile number.
   * Resolves the User account, checks account status, and sends OTP to
   * the verified mobile number associated with that account.
   */
  async requestPasswordlessLoginOtp(
    dto: RequestPasswordlessLoginOtpDto,
    req?: any,
  ) {
    const ctx = this.extractRequestContext(req);
    const rawIdentifier = dto.identifier.trim();
    if (!rawIdentifier) {
      throw new BadRequestException('Login identifier is required.');
    }

    let user: any = null;

    // A. Check if identifier is an Email
    if (rawIdentifier.includes('@')) {
      const normalizedEmail = rawIdentifier.toLowerCase().trim();
      user = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { userRoles: { include: { role: true } }, student: true },
      });
    }

    // B. Check if identifier is a Mobile Number
    if (!user) {
      const normalizedMobile =
        this.otpService.normalizeMobileNumber(rawIdentifier);
      const tenDigit = normalizedMobile.replace(/^\+91/, '');
      user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { mobileNumber: normalizedMobile },
            { phone: normalizedMobile },
            { mobileNumber: tenDigit },
            { phone: tenDigit },
            { mobileNumber: rawIdentifier },
            { phone: rawIdentifier },
          ],
        },
        include: { userRoles: { include: { role: true } }, student: true },
      });
    }

    if (!user) {
      throw new NotFoundException(
        'No active account found with the provided identifier.',
      );
    }

    // Verify account status
    this.verifyAccountActive(user);

    // Ensure account has a verified mobile number
    const targetMobile = user.mobileNumber || user.phone;
    if (!targetMobile) {
      throw new BadRequestException(
        'Account does not have a registered mobile number for OTP login.',
      );
    }

    // Create temporary login request in Redis
    const loginRequestId = `LOGIN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const pendingLogin: PendingLoginData = {
      loginRequestId,
      userId: user.id,
      mobile: targetMobile,
      identifier: rawIdentifier,
      status: 'PENDING_OTP',
      createdAt: new Date().toISOString(),
    };

    // 5 minutes TTL for login request
    await this.redisService.set(
      `login:${loginRequestId}`,
      JSON.stringify(pendingLogin),
      300,
    );

    // Send OTP with purpose LOGIN to the account's verified mobile
    await this.otpService.sendOtp(targetMobile, 'LOGIN', {
      ...ctx,
      userId: user.id,
    });

    await this.securityEventService.log('OTP_REQUESTED', {
      userId: user.id,
      ...ctx,
      metadata: { loginRequestId, purpose: 'LOGIN', mobile: targetMobile },
    });

    const isBypass = this.otpService?.isBypassEnabled?.() ?? false;
    const devOtp = this.otpService?.getDevBypassOtp?.() ?? '1234';
    const otpLength = this.otpService?.getOtpLength?.() ?? 4;

    return {
      message: 'OTP sent to your registered mobile number.',
      data: {
        requiresOtp: true,
        purpose: 'LOGIN',
        loginRequestId,
        mobileMasked: this.maskMobile(targetMobile),
        expiresIn: 300,
        resendAvailableIn: 60,
        otpLength,
        bypassOtp: isBypass,
        devBypassOtp: isBypass ? devOtp : undefined,
      },
    };
  }

  /**
   * Verify Login OTP: Validates the OTP for LOGIN purpose,
   * creates a LoginSession, and issues access + refresh tokens.
   */
  async verifyPasswordlessLoginOtp(
    dto: VerifyPasswordlessLoginOtpDto,
    req?: any,
  ) {
    const ctx = this.extractRequestContext(req);
    const { loginRequestId, otp } = dto;

    // 1. Load login request from Redis
    const rawData = await this.redisService.get(`login:${loginRequestId}`);
    if (!rawData) {
      throw new BadRequestException(
        'Login request has expired or is invalid. Please request a new OTP.',
      );
    }

    const loginRequest: PendingLoginData = JSON.parse(rawData);
    if (loginRequest.status !== 'PENDING_OTP') {
      throw new BadRequestException(
        'Login request has already been consumed or is invalid.',
      );
    }

    // 2. Verify OTP
    await this.otpService.verifyOtp(loginRequest.mobile, otp, 'LOGIN', {
      ...ctx,
      userId: loginRequest.userId,
    });

    // 3. Invalidate login request (single-use)
    await this.redisService.del(`login:${loginRequestId}`);

    // 4. Load user and verify status
    const user = await this.loadUserWithRoles(loginRequest.userId);
    if (!user) {
      throw new NotFoundException('User account no longer exists.');
    }

    this.verifyAccountActive(user);

    // 5. Update last login timestamp
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        status: user.status === 'PENDING' ? 'ACTIVE' : user.status,
      },
    });

    // 6. Create session and tokens
    const { session, tokens } = await this.createSessionAndTokens(user.id, req);

    // 7. Log success
    await this.securityEventService.log('LOGIN_SUCCESS', {
      userId: user.id,
      ...ctx,
      metadata: { method: 'PASSWORDLESS_OTP', sessionId: session.id },
    });

    return this.buildAuthResponse(user, session.id, tokens, 'Login successful');
  }

  // ═══════════════════════════════════════════════════════════════
  // DEDICATED MSG91/OTP FLOWS (REGISTRATION & LOGIN)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Dedicated Registration Step A: POST /auth/register/send-otp
   * Check if mobile is already registered. If yes, reject. If new, trigger sendOtp(mobileNumber).
   */
  async registerSendOtp(dto: RegisterSendOtpDto, req?: any) {
    const ctx = this.extractRequestContext(req);
    const rawMobile = dto.mobileNumber || dto.mobile || dto.phone;
    if (!rawMobile) {
      throw new BadRequestException('Mobile number is required.');
    }

    const normalizedMobile = this.otpService.normalizeMobileNumber(rawMobile);

    // 1. Check if mobile number is already registered
    const existingUserByMobile = await this.prisma.user.findFirst({
      where: {
        OR: [{ mobileNumber: normalizedMobile }, { phone: normalizedMobile }],
      },
    });

    if (existingUserByMobile) {
      throw new BadRequestException(
        'A user with this mobile number already exists.',
      );
    }

    if (dto.email) {
      const normalizedEmail = dto.email.toLowerCase().trim();
      const existingUserByEmail = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUserByEmail) {
        throw new BadRequestException('A user with this email already exists.');
      }
    }

    // Cache metadata in Redis for registration completion
    const registrationData = {
      mobile: normalizedMobile,
      name: dto.name ? dto.name.trim() : 'Student',
      email: dto.email ? dto.email.toLowerCase().trim() : null,
      createdAt: new Date().toISOString(),
    };
    await this.redisService.set(
      `registration:${normalizedMobile}`,
      JSON.stringify(registrationData),
      900,
    );

    // 2. Trigger sendOtp(mobileNumber)
    await this.otpService.sendOtp(normalizedMobile, 'REGISTER', ctx);

    await this.securityEventService.log('OTP_REQUESTED', {
      ...ctx,
      metadata: {
        purpose: 'REGISTER',
        mobile: normalizedMobile,
      },
    });

    return {
      message: 'OTP sent successfully to your mobile number.',
      data: {
        requiresOtp: true,
        purpose: 'REGISTER',
        mobile: normalizedMobile,
        mobileMasked: this.maskMobile(normalizedMobile),
        expiresIn: 300,
        resendAvailableIn: 60,
      },
    };
  }

  /**
   * Dedicated Registration Step B: POST /auth/register/verify-otp
   * Verify OTP. If valid, save new user record in database, issue session/JWT token, return user details.
   */
  async registerVerifyOtp(dto: RegisterVerifyOtpDto, req?: any) {
    const ctx = this.extractRequestContext(req);
    const { otp } = dto;
    if (!otp) {
      throw new BadRequestException('OTP is required.');
    }

    let mobile = dto.mobileNumber || dto.mobile || dto.phone;
    let cachedData: any = null;

    if (dto.registrationId) {
      const raw = await this.redisService.get(
        `registration:${dto.registrationId}`,
      );
      if (raw) {
        cachedData = JSON.parse(raw);
        mobile = mobile || cachedData.mobile;
      }
    }

    if (!mobile && cachedData?.mobile) {
      mobile = cachedData.mobile;
    }

    if (mobile) {
      const raw = await this.redisService.get(
        `registration:${this.otpService.normalizeMobileNumber(mobile)}`,
      );
      if (raw) {
        cachedData = { ...JSON.parse(raw), ...(cachedData || {}) };
      }
    }

    if (!mobile) {
      throw new BadRequestException(
        'Mobile number or registrationId is required.',
      );
    }

    const normalizedMobile = this.otpService.normalizeMobileNumber(mobile);

    // 1. Verify OTP using verifyOtp(mobileNumber, otp)
    await this.otpService.verifyOtp(
      normalizedMobile,
      otp.trim(),
      'REGISTER',
      ctx,
    );

    // Clean up cached registration state
    if (dto.registrationId) {
      await this.redisService.del(`registration:${dto.registrationId}`);
    }
    await this.redisService.del(`registration:${normalizedMobile}`);

    // 2. Save the new user record in database
    const resolvedName = dto.name || cachedData?.name || 'Student';
    const resolvedEmail = dto.email || cachedData?.email || null;

    // Pre-resolve lookups outside transaction to minimize interactive lock duration over cloud DB
    let studentRole = await this.prisma.role.findUnique({
      where: { name: 'STUDENT' },
    });
    if (!studentRole) {
      studentRole = await this.prisma.role.create({ data: { name: 'STUDENT' } });
    }

    let resolvedClassId = dto.classId || cachedData?.classId;
    if (!resolvedClassId) {
      const fallbackClass = await this.prisma.studentClass.findFirst();
      resolvedClassId = fallbackClass?.id;
    }

    let resolvedLanguageId =
      dto.preferredLanguageId || cachedData?.preferredLanguageId;
    if (!resolvedLanguageId) {
      const fallbackLang = await this.prisma.preferredLanguage.findFirst();
      resolvedLanguageId = fallbackLang?.id;
    }

    let resolvedExamTargetId = dto.examTargetId || cachedData?.examTargetId;
    if (!resolvedExamTargetId) {
      const fallbackTarget = await this.prisma.examTarget.findFirst();
      resolvedExamTargetId = fallbackTarget?.id;
    }

    const year = new Date().getFullYear();
    const count = await this.prisma.student.count();
    let studentIdStr = `STU${String(count + 1001).padStart(6, '0')}`;
    let studentCode = `BRN-${year}-${String(count + 1).padStart(6, '0')}`;

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Concurrency duplicate check
        const existingUser = await tx.user.findFirst({
          where: {
            OR: [{ mobileNumber: normalizedMobile }, { phone: normalizedMobile }],
          },
        });
        if (existingUser) {
          throw new BadRequestException(
            'A user with this mobile number already exists.',
          );
        }

        // Create User
        const newUser = await tx.user.create({
          data: {
            phone: normalizedMobile,
            mobileNumber: normalizedMobile,
            email: resolvedEmail,
            status: 'ACTIVE',
            isVerified: true,
            isActive: true,
            mobileVerifiedAt: new Date(),
            emailVerifiedAt: resolvedEmail ? new Date() : null,
            lastLoginAt: new Date(),
          },
        });

        await tx.userRole.create({
          data: { userId: newUser.id, roleId: studentRole.id },
        });

        const student = await tx.student.create({
          data: {
            userId: newUser.id,
            studentId: studentIdStr,
            studentCode,
            name: resolvedName,
            state: dto.state || cachedData?.state || 'Default State',
            district: dto.district || cachedData?.district || 'Default District',
            stateId: dto.stateId || cachedData?.stateId || null,
            districtId: dto.districtId || cachedData?.districtId || null,
            schoolCollege:
              dto.schoolCollege || cachedData?.schoolCollege || 'Default School',
            classId: resolvedClassId,
            preferredLanguageId: resolvedLanguageId,
            examTargetId: resolvedExamTargetId,
            status: 'ACTIVE',
            registrationSource: 'PUBLIC',
          },
        });

        return { user: newUser, student };
      },
      { timeout: 25000, maxWait: 10000 },
    );

    // 3. Issue session & JWT token
    const { session, tokens } = await this.createSessionAndTokens(
      result.user.id,
      req,
    );

    await this.securityEventService.log('REGISTER_SUCCESS', {
      userId: result.user.id,
      ...ctx,
      metadata: {
        mobile: normalizedMobile,
        studentId: result.student.studentId,
      },
    });

    const fullUser = await this.loadUserWithRoles(result.user.id);
    return this.buildAuthResponse(
      fullUser,
      session.id,
      tokens,
      'Registration completed successfully.',
    );
  }

  /**
   * Dedicated Login Step A: POST /auth/login/send-otp
   * Check if user exists in database. If not, reject with "User not found". If found, trigger sendOtp(mobileNumber).
   */
  async loginSendOtp(dto: LoginSendOtpDto, req?: any) {
    const ctx = this.extractRequestContext(req);
    const rawIdentifier =
      dto.mobileNumber || dto.mobile || dto.phone || dto.identifier;
    if (!rawIdentifier) {
      throw new BadRequestException('Mobile number or identifier is required.');
    }

    const normalizedMobile = this.otpService.normalizeMobileNumber(
      rawIdentifier.trim(),
    );

    // 1. Check if user exists in database. If not, reject with "User not found".
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ mobileNumber: normalizedMobile }, { phone: normalizedMobile }],
      },
      include: { userRoles: { include: { role: true } }, student: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    this.verifyAccountActive(user);

    const targetMobile = user.mobileNumber || user.phone || normalizedMobile;

    // Cache temporary login state in Redis
    await this.redisService.set(
      `login:${targetMobile}`,
      JSON.stringify({
        userId: user.id,
        mobile: targetMobile,
        createdAt: new Date().toISOString(),
      }),
      300,
    );

    // 2. Trigger sendOtp(mobileNumber)
    await this.otpService.sendOtp(targetMobile, 'LOGIN', {
      ...ctx,
      userId: user.id,
    });

    await this.securityEventService.log('OTP_REQUESTED', {
      userId: user.id,
      ...ctx,
      metadata: { purpose: 'LOGIN', mobile: targetMobile },
    });

    const isBypass = this.otpService?.isBypassEnabled?.() ?? false;
    const devOtp = this.otpService?.getDevBypassOtp?.() ?? '1234';
    const otpLength = this.otpService?.getOtpLength?.() ?? 4;

    return {
      message: 'OTP sent to your registered mobile number.',
      data: {
        requiresOtp: true,
        purpose: 'LOGIN',
        mobile: targetMobile,
        mobileMasked: this.maskMobile(targetMobile),
        expiresIn: 300,
        resendAvailableIn: 60,
        otpLength,
        bypassOtp: isBypass,
        devBypassOtp: isBypass ? devOtp : undefined,
      },
    };
  }

  /**
   * Dedicated Login Step B: POST /auth/login/verify-otp
   * Verify the OTP using verifyOtp(mobileNumber, otp). If valid, generate and return session/JWT token and user profile.
   */
  async loginVerifyOtp(dto: LoginVerifyOtpDto, req?: any) {
    const ctx = this.extractRequestContext(req);
    const { otp } = dto;
    if (!otp) {
      throw new BadRequestException('OTP is required.');
    }

    // Support existing loginRequestId flow as well
    if (dto.loginRequestId) {
      return this.verifyPasswordlessLoginOtp(
        { loginRequestId: dto.loginRequestId, otp },
        req,
      );
    }

    const rawMobile = dto.mobileNumber || dto.mobile || dto.phone;
    if (!rawMobile) {
      throw new BadRequestException(
        'Mobile number or loginRequestId is required.',
      );
    }

    const normalizedMobile = this.otpService.normalizeMobileNumber(
      rawMobile.trim(),
    );

    // 1. Check if user exists
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ mobileNumber: normalizedMobile }, { phone: normalizedMobile }],
      },
      include: { userRoles: { include: { role: true } }, student: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    this.verifyAccountActive(user);

    // 2. Verify OTP using verifyOtp(mobileNumber, otp)
    await this.otpService.verifyOtp(normalizedMobile, otp.trim(), 'LOGIN', {
      ...ctx,
      userId: user.id,
    });

    // Invalidate cached login request
    await this.redisService.del(`login:${normalizedMobile}`);

    // Update lastLoginAt
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        status: user.status === 'PENDING' ? 'ACTIVE' : user.status,
      },
    });

    // 3. Generate and return session/JWT token and user profile
    const { session, tokens } = await this.createSessionAndTokens(
      user.id,
      req,
    );

    await this.securityEventService.log('LOGIN_SUCCESS', {
      userId: user.id,
      ...ctx,
      metadata: { method: 'MSG91_OTP', sessionId: session.id },
    });

    const fullUser = await this.loadUserWithRoles(user.id);
    return this.buildAuthResponse(
      fullUser,
      session.id,
      tokens,
      'Login successful.',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. RESEND OTP (COOLDOWN PROTECTED)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resend OTP for either a pending registration, login request, or mobile number.
   */
  async resendOtp(dto: ResendOtpDto, req?: any) {
    const ctx = this.extractRequestContext(req);

    if (dto.registrationId) {
      const rawData = await this.redisService.get(
        `registration:${dto.registrationId}`,
      );
      if (!rawData) {
        throw new BadRequestException(
          'Registration session expired or invalid. Please register again.',
        );
      }
      const registration: PendingRegistrationData = JSON.parse(rawData);
      await this.otpService.sendOtp(registration.mobile, 'REGISTER', ctx);
      return {
        message: 'Registration OTP resent successfully.',
        data: { resendAvailableIn: 60, expiresIn: 300 },
      };
    }

    if (dto.loginRequestId) {
      const rawData = await this.redisService.get(
        `login:${dto.loginRequestId}`,
      );
      if (!rawData) {
        throw new BadRequestException(
          'Login request expired. Please request a new login OTP.',
        );
      }
      const loginRequest: PendingLoginData = JSON.parse(rawData);
      await this.otpService.sendOtp(loginRequest.mobile, 'LOGIN', {
        ...ctx,
        userId: loginRequest.userId,
      });
      return {
        message: 'Login OTP resent successfully.',
        data: { resendAvailableIn: 60, expiresIn: 300 },
      };
    }

    if (dto.mobileNumber) {
      const mobile = this.otpService.normalizeMobileNumber(dto.mobileNumber);
      const purpose = (dto.purpose as OtpPurpose) || 'LOGIN';
      await this.otpService.sendOtp(mobile, purpose, ctx);
      return {
        message: 'OTP resent successfully.',
        data: { resendAvailableIn: 60, expiresIn: 300 },
      };
    }

    throw new BadRequestException(
      'registrationId, loginRequestId, or mobileNumber must be provided to resend OTP.',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. LEGACY / DIRECT MOBILE OTP LOGIN & VERIFICATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Legacy / Direct verify OTP and authenticate user
   */
  async verifyOtpAndLogin(
    mobileNumber: string,
    otp: string,
    purpose: OtpPurpose,
    req?: any,
  ) {
    const ctx = this.extractRequestContext(req);

    // 1. Verify OTP
    await this.otpService.verifyOtp(mobileNumber, otp, purpose, ctx);

    const normalizedMobile =
      this.otpService.normalizeMobileNumber(mobileNumber);

    // 2. Find or create user
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ mobileNumber: normalizedMobile }, { phone: normalizedMobile }],
      },
      include: {
        userRoles: { include: { role: true } },
      },
    });

    let message = 'Login successful';

    if (!user) {
      // Auto-register on first OTP verification (backward compatibility)
      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            phone: normalizedMobile,
            mobileNumber: normalizedMobile,
            status: 'ACTIVE',
            isVerified: true,
            isActive: true,
            mobileVerifiedAt: new Date(),
            lastLoginAt: new Date(),
          },
        });

        let studentRole = await tx.role.findUnique({
          where: { name: 'STUDENT' },
        });
        if (!studentRole) {
          studentRole = await tx.role.create({ data: { name: 'STUDENT' } });
        }

        await tx.userRole.create({
          data: { userId: newUser.id, roleId: studentRole.id },
        });

        return tx.user.findUnique({
          where: { id: newUser.id },
          include: { userRoles: { include: { role: true } } },
        }) as any;
      });

      message = 'Registration successful';

      await this.securityEventService.log('REGISTER_SUCCESS', {
        userId: user!.id,
        ...ctx,
        metadata: { method: 'MOBILE_OTP', mobile: normalizedMobile },
      });
    }

    if (!user) {
      throw new InternalServerErrorException(
        'Unable to complete login. Please check your credentials and try again.',
      );
    }

    this.verifyAccountActive(user);

    // 3. Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        mobileVerifiedAt: new Date(),
        status: user.status === 'PENDING' ? 'ACTIVE' : user.status,
      },
    });

    // 4. Create session and tokens
    const { session, tokens } = await this.createSessionAndTokens(user.id, req);

    // 5. Log security event
    await this.securityEventService.log('LOGIN_SUCCESS', {
      userId: user.id,
      ...ctx,
      metadata: { method: 'MOBILE_OTP', sessionId: session.id },
    });

    const fullUser = await this.loadUserWithRoles(user.id);
    return this.buildAuthResponse(fullUser, session.id, tokens, message);
  }

  /**
   * Direct send OTP helper
   */
  async sendOtp(mobileNumber: string, purpose: OtpPurpose, req?: any) {
    const ctx = this.extractRequestContext(req);
    await this.otpService.sendOtp(mobileNumber, purpose, ctx);
    return { message: 'OTP sent successfully' };
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. LEGACY PASSWORD LOGIN & GOOGLE AUTH
  // ═══════════════════════════════════════════════════════════════

  async loginWithEmail(email: string, password: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    this.verifyAccountActive(user);

    const isPasswordValid = await this.passwordService.comparePassword(
      password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { session, tokens } = await this.createSessionAndTokens(user.id, req);
    const fullUser = await this.loadUserWithRoles(user.id);

    return this.buildAuthResponse(
      fullUser,
      session.id,
      tokens,
      'Login successful',
    );
  }

  async loginWithStudentId(studentId: string, password: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    const trimmedId = studentId.trim();

    const student = await this.prisma.student.findFirst({
      where: {
        OR: [
          { studentId: { equals: trimmedId, mode: 'insensitive' } },
          { studentCode: { equals: trimmedId, mode: 'insensitive' } },
        ],
      },
      include: {
        user: {
          include: {
            userRoles: { include: { role: true } },
          },
        },
      },
    });

    if (!student || !student.user || !student.user.passwordHash) {
      throw new UnauthorizedException('Invalid Student ID or password.');
    }

    const user = { ...student.user, student };
    this.verifyAccountActive(user);

    const isPasswordValid = await this.passwordService.comparePassword(
      password,
      user.passwordHash!,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid Student ID or password.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { session, tokens } = await this.createSessionAndTokens(user.id, req);
    const fullUser = await this.loadUserWithRoles(user.id);

    return this.buildAuthResponse(
      fullUser,
      session.id,
      tokens,
      'Login successful',
    );
  }

  async loginWithGoogle(idToken: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    const payload = await this.oauthService.verifyGoogleIdToken(idToken);

    if (!payload.email) {
      throw new BadRequestException(
        'Google token did not contain a valid email.',
      );
    }

    const normalizedEmail = payload.email.toLowerCase().trim();

    let user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            status: 'ACTIVE',
            isVerified: true,
            isActive: true,
            emailVerifiedAt: new Date(),
            lastLoginAt: new Date(),
          },
        });

        let studentRole = await tx.role.findUnique({
          where: { name: 'STUDENT' },
        });
        if (!studentRole) {
          studentRole = await tx.role.create({ data: { name: 'STUDENT' } });
        }

        await tx.userRole.create({
          data: { userId: newUser.id, roleId: studentRole.id },
        });

        return tx.user.findUnique({
          where: { id: newUser.id },
          include: { userRoles: { include: { role: true } } },
        }) as any;
      });
    }

    if (!user) {
      throw new InternalServerErrorException(
        'Unable to complete Google sign-in. Please try again.',
      );
    }

    this.verifyAccountActive(user);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { session, tokens } = await this.createSessionAndTokens(user.id, req);
    const fullUser = await this.loadUserWithRoles(user.id);

    return this.buildAuthResponse(
      fullUser,
      session.id,
      tokens,
      'Google authentication successful',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. TOKEN REFRESH & LOGOUT
  // ═══════════════════════════════════════════════════════════════

  async refreshSession(refreshToken: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    const tokens = await this.tokenService.refreshAccessTokens(
      refreshToken,
      ctx,
    );

    let user: any = null;
    if (tokens.userId) {
      user = await this.loadUserWithRoles(tokens.userId);
    }

    return {
      message: 'Token refreshed successfully',
      data: {
        user: user ? this.buildUserResponse(user) : undefined,
        student: user?.student
          ? {
              id: user.student.id,
              studentId: user.student.studentId,
              studentCode: user.student.studentCode,
              name: user.student.name,
            }
          : null,
        session: tokens.sessionId ? { sessionId: tokens.sessionId } : undefined,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
    };
  }

  async logout(refreshToken: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    const sessionId = await this.tokenService.revokeRefreshToken(refreshToken);
    if (sessionId) {
      await this.sessionService.revokeSession(sessionId);
    }
    const userId = req?.user?.userId;
    await this.securityEventService.log('LOGOUT', {
      userId,
      ...ctx,
      metadata: { sessionId },
    });
    return { message: 'Logged out successfully.' };
  }

  async logoutAll(userId: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    await this.sessionService.revokeAllSessions(userId);
    await this.securityEventService.log('LOGOUT_ALL', { userId, ...ctx });
    return { message: 'All sessions logged out successfully.' };
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. USER PROFILE & REGISTRATION OPTIONS
  // ═══════════════════════════════════════════════════════════════

  async getSessions(userId: string) {
    const sessions = await this.sessionService.getUserSessions(userId);
    return { message: 'Sessions retrieved successfully', data: sessions };
  }

  async revokeSession(userId: string, sessionId: string, req?: any) {
    const ctx = this.extractRequestContext(req);
    const success = await this.sessionService.revokeUserSession(
      userId,
      sessionId,
    );
    if (!success) {
      throw new NotFoundException('Session not found.');
    }
    await this.securityEventService.log('SESSION_REVOKED', {
      userId,
      ...ctx,
      metadata: { revokedSessionId: sessionId },
    });
    return { message: 'Session revoked successfully.' };
  }

  async getMe(userId: string) {
    const user = await this.loadUserWithRoles(userId);
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

    return {
      id: user.id,
      phone: user.phone,
      mobileNumber: user.mobileNumber,
      email: user.email,
      status: user.status,
      isActive: user.isActive,
      isVerified: user.isVerified,
      lastLoginAt: user.lastLoginAt,
      roles,
      studentProfile: user.student
        ? {
            id: user.student.id,
            studentId: user.student.studentId,
            studentCode: user.student.studentCode,
            name: user.student.name,
            state: user.student.state,
            district: user.student.district,
            schoolCollege: user.student.schoolCollege,
            class: user.student.studentClass?.name,
            classId: user.student.classId,
            examTarget: user.student.examTarget?.name,
            examTargetId: user.student.examTargetId,
            preferredLanguage: user.student.preferredLanguage?.name,
            preferredLanguageId: user.student.preferredLanguageId,
            stateId: user.student.stateId,
            districtId: user.student.districtId,
            status: user.student.status,
          }
        : null,
    };
  }

  async updateMe(
    userId: string,
    dto: {
      name?: string;
      email?: string;
      mobileNumber?: string;
      phone?: string;
      password?: string;
    },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { student: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const userDataToUpdate: any = {};

    if (dto.email && dto.email.trim().toLowerCase() !== user.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
      });
      if (existingEmail && existingEmail.id !== userId) {
        throw new BadRequestException('Email is already registered by another account.');
      }
      userDataToUpdate.email = dto.email.trim().toLowerCase();
    }

    const newMobile = dto.mobileNumber?.trim() || dto.phone?.trim();
    if (newMobile && newMobile !== user.mobileNumber && newMobile !== user.phone) {
      const existingMobile = await this.prisma.user.findFirst({
        where: { OR: [{ mobileNumber: newMobile }, { phone: newMobile }] },
      });
      if (existingMobile && existingMobile.id !== userId) {
        throw new BadRequestException('Mobile number is already registered by another account.');
      }
      userDataToUpdate.mobileNumber = newMobile;
      userDataToUpdate.phone = newMobile;
    }

    if (dto.password && dto.password.trim().length >= 6) {
      userDataToUpdate.passwordHash = await this.passwordService.hashPassword(
        dto.password.trim(),
      );
    }

    if (Object.keys(userDataToUpdate).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: userDataToUpdate,
      });
    }

    if (dto.name && user.student) {
      await this.prisma.student.update({
        where: { id: user.student.id },
        data: { name: dto.name.trim() },
      });
    }

    return this.getMe(userId);
  }

  async getRegisterOptions() {
    const targetOrder = CANONICAL_TARGET_EXAMS;

    const [classes, languages, rawTargets, states] = await Promise.all([
      this.prisma.studentClass.findMany({
        where: { name: { not: 'FOUNDATION' } },
        select: { id: true, name: true },
      }),
      this.prisma.preferredLanguage.findMany({
        where: { isActive: true },
        select: { id: true, name: true, code: true },
      }),
      this.prisma.examTarget.findMany({
        select: { id: true, name: true, description: true },
      }),
      this.prisma.state.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          code: true,
          districts: {
            where: { isActive: true },
            select: { id: true, name: true, code: true },
            orderBy: { name: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    // Sort exam targets strictly by targetOrder, and filter to the 7 valid targets
    const examTargets = targetOrder
      .map((targetName) =>
        rawTargets.find(
          (t) => t.name.trim().toLowerCase() === targetName.trim().toLowerCase(),
        ),
      )
      .filter((t): t is { id: string; name: string; description: string | null } => Boolean(t));

    return { classes, languages, examTargets, states };
  }

  /**
   * Returns current OTP configuration (whether bypass mode is active, dev OTP code, length)
   */
  getOtpConfig() {
    const isBypass = this.otpService?.isBypassEnabled?.() ?? false;
    const devOtp = this.otpService?.getDevBypassOtp?.() ?? '1234';
    const otpLength = this.otpService?.getOtpLength?.() ?? 4;
    return {
      bypassOtp: isBypass,
      devBypassOtp: isBypass ? devOtp : undefined,
      otpLength,
    };
  }
}
