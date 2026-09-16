import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { TwoFactorService } from './two-factor.service';
import { TwoFactorConfig } from '../config/two-factor.config';
import { TwoFactorDotInProvider } from './two-factor-dot-in.provider';
import { DevelopmentOtpProvider } from './development-otp.provider';
import { OtpService } from '../services/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../services/token.service';
import { PasswordService } from '../services/password.service';
import { SessionService } from '../services/session.service';
import { OAuthService } from '../services/oauth.service';
import { SecurityEventService } from '../services/security-event.service';
import { RedisService } from '../../redis/redis.service';

describe('2FA Integration & End-to-End Authentication Flows', () => {
  let authService: AuthService;
  let twoFactorService: TwoFactorService;
  let redisStorage: Map<string, string>;
  let redisServiceMock: any;
  let twoFactorDotInProviderMock: any;
  let realProviderMock: any;
  let devProviderMock: any;
  let prismaMock: any;

  const sampleStudentUser: any = {
    id: 'user-std-1',
    name: 'Rohan Sharma',
    phone: '+919876543210',
    mobileNumber: '+919876543210',
    email: 'rohan@example.com',
    status: 'ACTIVE',
    isActive: true,
    userRoles: [{ role: { name: 'STUDENT' } }],
    student: {
      id: 'student-std-1',
      studentId: 'BRN-2026-0001',
      studentCode: 'BRN-2026-0001',
    },
  };

  const setupTestModule = async (enable2FA: boolean) => {
    redisStorage = new Map<string, string>();

    redisServiceMock = {
      get: jest.fn(async (key: string) => redisStorage.get(key) || null),
      set: jest.fn(async (key: string, val: string) => {
        redisStorage.set(key, val);
      }),
      del: jest.fn(async (key: string) => {
        redisStorage.delete(key);
      }),
    };

    twoFactorDotInProviderMock = {
      sendOtp: jest.fn().mockResolvedValue({ sessionId: 'session123', providerManaged: true }),
      verifyOtp: jest.fn().mockResolvedValue(true),
      retryOtp: jest.fn().mockResolvedValue(true),
      providerName: 'REAL',
    };
    realProviderMock = twoFactorDotInProviderMock;

    devProviderMock = {
      providerName: 'DEVELOPMENT',
      sendOtp: jest.fn().mockResolvedValue({
        sessionId: 'dev-session-test',
        providerManaged: false,
        otpHash: 'mock-dev-hash',
      }),
      verifyOtp: jest.fn((dest: string, code: string) => {
        return Promise.resolve(code === '12345');
      }),
    };

    const configServiceMock = {
      get: jest.fn((key: string) => {
        if (key === 'ENABLE_2FA') return enable2FA ? 'true' : 'false';
        if (key === 'OTP_PROVIDER') return '2FACTOR';
        if (key === 'DEV_BYPASS_OTP') return '12345';
        if (key === 'OTP_MAX_VERIFY_ATTEMPTS') return '5';
        if (key === 'OTP_RESEND_COOLDOWN_SECONDS') return '60';
        if (key === 'OTP_TTL_SECONDS') return '300';
        return undefined;
      }),
    } as any;

    const twoFactorConfig = new TwoFactorConfig(configServiceMock);

    twoFactorService = new TwoFactorService(
      twoFactorConfig,
      redisServiceMock as RedisService,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      twoFactorDotInProviderMock as TwoFactorDotInProvider,
      twoFactorDotInProviderMock as any,
      devProviderMock as DevelopmentOtpProvider,
      twoFactorDotInProviderMock as any,
    );

    const otpService = new OtpService(
      twoFactorService,
      {} as any,
      configServiceMock,
      prismaMock as any,
      {} as any,
    );

    prismaMock = {
      user: {
        findFirst: jest.fn().mockImplementation((args: any) => {
          const email = args?.where?.email;
          if (email === 'rohan@example.com') return Promise.resolve(sampleStudentUser);

          const orList = args?.where?.OR || [];
          for (const cond of orList) {
            if (cond.email === 'rohan@example.com') return Promise.resolve(sampleStudentUser);
            if (
              cond.mobileNumber === '+919876543210' ||
              cond.phone === '+919876543210'
            ) {
              return Promise.resolve(sampleStudentUser);
            }
          }
          return Promise.resolve(null);
        }),
        findUnique: jest.fn().mockImplementation((args: any) => {
          if (args?.where?.id) {
            return Promise.resolve(sampleStudentUser);
          }
          if (args?.where?.email === 'rohan@example.com') {
            return Promise.resolve(sampleStudentUser);
          }
          return Promise.resolve(null);
        }),
        update: jest.fn().mockResolvedValue(sampleStudentUser),
        create: jest.fn().mockResolvedValue({ ...sampleStudentUser, id: 'user-new-1' }),
      },
      student: {
        count: jest.fn().mockResolvedValue(10),
        findFirst: jest.fn().mockImplementation((args: any) => {
          const orList = args?.where?.OR || [];
          for (const cond of orList) {
            const val = cond.studentId?.equals || cond.studentCode?.equals;
            if (val === 'BRN-2026-0001') {
              return Promise.resolve({
                ...sampleStudentUser.student,
                user: sampleStudentUser,
              });
            }
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockResolvedValue({
          id: 'student-new-1',
          studentId: 'BRN-2026-0002',
        }),
      },
      userRole: {
        create: jest.fn().mockResolvedValue({ id: 'ur-1' }),
      },
      role: {
        findUnique: jest.fn().mockResolvedValue({ id: 'role-std-1', name: 'STUDENT' }),
      },
      state: {
        findUnique: jest.fn().mockResolvedValue({ id: 'st-1', name: 'Karnataka', isActive: true }),
      },
      district: {
        findUnique: jest.fn().mockResolvedValue({ id: 'dt-1', name: 'Bengaluru', stateId: 'st-1' }),
      },
      studentClass: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cls-10', name: 'Class 10' }),
      },
      preferredLanguage: {
        findUnique: jest.fn().mockResolvedValue({ id: 'lang-en', name: 'English', isActive: true }),
      },
      examTarget: {
        findUnique: jest.fn().mockResolvedValue({ id: 'exam-board', name: 'Board Exam' }),
      },
      classGrade: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cls-10', name: 'Class 10' }),
      },
      stream: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      language: {
        findUnique: jest.fn().mockResolvedValue({ id: 'lang-en', name: 'English' }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prismaMock)),
    };

    const tokenServiceMock = {
      generateTokens: jest.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      }),
    };

    const sessionServiceMock = {
      createSession: jest.fn().mockResolvedValue({ id: 'sess-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: TwoFactorConfig, useValue: twoFactorConfig },
        { provide: TwoFactorService, useValue: twoFactorService },
        { provide: OtpService, useValue: otpService },
        { provide: PrismaService, useValue: prismaMock },
        { provide: TokenService, useValue: tokenServiceMock },
        { provide: PasswordService, useValue: { comparePasswords: jest.fn(), hashPassword: jest.fn() } },
        { provide: SessionService, useValue: sessionServiceMock },
        { provide: OAuthService, useValue: {} },
        { provide: SecurityEventService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: RedisService, useValue: redisServiceMock },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
  };

  // ═══════════════════════════════════════════════════════════════
  // 1. REGISTRATION FLOWS
  // ═══════════════════════════════════════════════════════════════
  describe('Registration Flow', () => {
    const newStudentDto = {
      phone: '+919111122222',
      name: 'Priya Patel',
      email: 'priya@example.com',
      schoolCollege: 'National High School',
      stateId: 'st-1',
      districtId: 'dt-1',
      classId: 'cls-10',
      preferredLanguageId: 'lang-en',
      examTargetId: 'exam-board',
    };

    describe('When ENABLE_2FA=false (Development Mode)', () => {
      beforeEach(async () => {
        await setupTestModule(false);
      });

      it('should initiate registration, NOT call real provider, and accept 12345', async () => {
        const initRes = await authService.registerStudent(newStudentDto);

        expect(initRes.data.requiresOtp).toBe(true);
        expect(initRes.data.registrationId).toBeDefined();
        expect(devProviderMock.sendOtp).toHaveBeenCalled();
        expect(realProviderMock.sendOtp).not.toHaveBeenCalled();

        // Response MUST NEVER leak the OTP code
        expect((initRes.data as any).otp).toBeUndefined();

        // Verification with 12345 must succeed
        const verifyRes = await authService.verifyRegistrationOtp({
          registrationId: initRes.data.registrationId,
          otp: '12345',
        });

        expect(verifyRes.message).toMatch(/OTP verified/);
        expect(verifyRes.data.requiresPayment).toBe(true);
      });

      it('should reject registration verification with incorrect OTP', async () => {
        const initRes = await authService.registerStudent(newStudentDto);

        await expect(
          authService.verifyRegistrationOtp({
            registrationId: initRes.data.registrationId,
            otp: '99999',
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('When ENABLE_2FA=true (Real Production Mode)', () => {
      beforeEach(async () => {
        await setupTestModule(true);
      });

      it('should initiate registration via Real Provider and NEVER accept 12345', async () => {
        const initRes = await authService.registerStudent(newStudentDto);

        expect(realProviderMock.sendOtp).toHaveBeenCalledWith(
          '+919111122222',
          'REGISTER',
        );
        expect(devProviderMock.sendOtp).not.toHaveBeenCalled();

        // Submitting 12345 in production MUST be rejected by real provider
        realProviderMock.verifyOtp.mockResolvedValue(false);
        await expect(
          authService.verifyRegistrationOtp({
            registrationId: initRes.data.registrationId,
            otp: '12345',
          }),
        ).rejects.toThrow(BadRequestException);

        expect(realProviderMock.verifyOtp).toHaveBeenCalledWith(
          '+919111122222',
          '12345',
          'REGISTER',
          expect.any(Object),
        );
      });

      it('should succeed when real provider validates the OTP', async () => {
        const initRes = await authService.registerStudent(newStudentDto);

        realProviderMock.verifyOtp.mockResolvedValue(true);

        const verifyRes = await authService.verifyRegistrationOtp({
          registrationId: initRes.data.registrationId,
          otp: '847291',
        });

        expect(verifyRes.message).toMatch(/OTP verified|Registration successful/);
        expect(verifyRes.data.otpVerified).toBe(true);
      });

      it('CRITICAL: real provider error must fail gracefully and NEVER accept 12345', async () => {
        const initRes = await authService.registerStudent(newStudentDto);

        realProviderMock.verifyOtp.mockRejectedValue(
          new InternalServerErrorException('Verification gateway is temporarily unavailable.'),
        );

        await expect(
          authService.verifyRegistrationOtp({
            registrationId: initRes.data.registrationId,
            otp: '12345',
          }),
        ).rejects.toThrow(InternalServerErrorException);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. PASSWORDLESS LOGIN FLOWS (Mobile, Email, Student ID)
  // ═══════════════════════════════════════════════════════════════
  describe('Passwordless Login Flow (Mobile, Email, Student ID)', () => {
    describe('When ENABLE_2FA=false (Development Mode)', () => {
      beforeEach(async () => {
        await setupTestModule(false);
      });

      it('Mobile identifier login should request OTP and verify with 12345', async () => {
        const reqRes = await authService.requestPasswordlessLoginOtp({
          identifier: '+919876543210',
        });

        expect(reqRes.data.requiresOtp).toBe(true);
        expect(devProviderMock.sendOtp).toHaveBeenCalled();
        expect((reqRes.data as any).otp).toBeUndefined();

        const verifyRes = await authService.verifyPasswordlessLoginOtp({
          loginRequestId: reqRes.data.loginRequestId,
          otp: '12345',
        });

        expect(verifyRes.data.accessToken).toBe('mock-access-token');
      });

      it('Email identifier login should resolve user mobile and verify with 12345', async () => {
        const reqRes = await authService.requestPasswordlessLoginOtp({
          identifier: 'rohan@example.com',
        });

        expect(reqRes.data.requiresOtp).toBe(true);
        expect(reqRes.data.mobileMasked).toBeDefined();

        const verifyRes = await authService.verifyPasswordlessLoginOtp({
          loginRequestId: reqRes.data.loginRequestId,
          otp: '12345',
        });

        expect(verifyRes.data.accessToken).toBe('mock-access-token');
      });

      it('Student ID identifier login should resolve user mobile and verify with 12345', async () => {
        const reqRes = await authService.requestPasswordlessLoginOtp({
          identifier: 'BRN-2026-0001',
        });

        expect(reqRes.data.requiresOtp).toBe(true);

        const verifyRes = await authService.verifyPasswordlessLoginOtp({
          loginRequestId: reqRes.data.loginRequestId,
          otp: '12345',
        });

        expect(verifyRes.data.accessToken).toBe('mock-access-token');
      });
    });

    describe('When ENABLE_2FA=true (Real Production Mode)', () => {
      beforeEach(async () => {
        await setupTestModule(true);
      });

      it('Login OTP request should call Real Provider and reject 12345', async () => {
        const reqRes = await authService.requestPasswordlessLoginOtp({
          identifier: '+919876543210',
        });

        expect(realProviderMock.sendOtp).toHaveBeenCalled();
        expect(devProviderMock.sendOtp).not.toHaveBeenCalled();

        realProviderMock.verifyOtp.mockResolvedValue(false);
        await expect(
          authService.verifyPasswordlessLoginOtp({
            loginRequestId: reqRes.data.loginRequestId,
            otp: '12345',
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });
});
