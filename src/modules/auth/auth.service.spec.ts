import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './services/otp.service';
import { TokenService } from './services/token.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { OAuthService } from './services/oauth.service';
import { SecurityEventService } from './services/security-event.service';
import { RedisService } from '../redis/redis.service';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

describe('AuthService (Passwordless & OTP Registration)', () => {
  let authService: AuthService;
  let prismaMock: any;
  let otpServiceMock: any;
  let tokenServiceMock: any;
  let passwordServiceMock: any;
  let sessionServiceMock: any;
  let oauthServiceMock: any;
  let securityEventServiceMock: any;
  let redisServiceMock: any;

  const mockRedisStorage = new Map<string, string>();

  beforeEach(async () => {
    process.env.PUBLIC_REGISTRATION_FEE_INR = '300';
    mockRedisStorage.clear();

    redisServiceMock = {
      get: jest
        .fn()
        .mockImplementation(
          async (key: string) => mockRedisStorage.get(key) || null,
        ),
      set: jest.fn().mockImplementation(async (key: string, val: string) => {
        mockRedisStorage.set(key, val);
      }),
      del: jest.fn().mockImplementation(async (key: string) => {
        mockRedisStorage.delete(key);
      }),
    };

    otpServiceMock = {
      normalizeMobileNumber: jest.fn().mockImplementation((m: string) => {
        const clean = m.replace(/[^\d+]/g, '');
        return clean.startsWith('+') ? clean : `+91${clean}`;
      }),
      sendOtp: jest.fn().mockResolvedValue(undefined),
      verifyOtp: jest.fn().mockResolvedValue(true),
      isBypassEnabled: jest.fn().mockReturnValue(false),
      getDevBypassOtp: jest.fn().mockReturnValue('1234'),
      getOtpLength: jest.fn().mockReturnValue(4),
    };

    tokenServiceMock = {
      generateTokens: jest.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 900,
      }),
      refreshAccessTokens: jest.fn().mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 900,
      }),
      revokeRefreshToken: jest.fn().mockResolvedValue('session-123'),
    };

    passwordServiceMock = {
      hashPassword: jest.fn().mockResolvedValue('hashed-password'),
      comparePassword: jest.fn().mockResolvedValue(true),
    };

    sessionServiceMock = {
      createSession: jest.fn().mockResolvedValue({ id: 'mock-session-123' }),
      revokeSession: jest.fn().mockResolvedValue(true),
      revokeAllSessions: jest.fn().mockResolvedValue(true),
      getUserSessions: jest.fn().mockResolvedValue([]),
    };

    oauthServiceMock = {
      verifyGoogleIdToken: jest
        .fn()
        .mockResolvedValue({ email: 'google@test.com' }),
    };

    securityEventServiceMock = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    prismaMock = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      student: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(42),
      },
      role: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'role-student-id', name: 'STUDENT' }),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'role-student-id', name: 'STUDENT' }),
      },
      userRole: {
        create: jest.fn().mockResolvedValue({}),
      },
      studentClass: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'class-1', name: 'Class 12' }),
      },
      preferredLanguage: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'lang-1', name: 'English', isActive: true }),
      },
      examTarget: {
        findUnique: jest.fn().mockResolvedValue({ id: 'exam-1', name: 'NEET' }),
      },
      state: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'state-1',
          name: 'Karnataka',
          isActive: true,
        }),
      },
      district: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'dist-1',
          name: 'Bengaluru',
          stateId: 'state-1',
        }),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(prismaMock);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: OtpService, useValue: otpServiceMock },
        { provide: TokenService, useValue: tokenServiceMock },
        { provide: PasswordService, useValue: passwordServiceMock },
        { provide: SessionService, useValue: sessionServiceMock },
        { provide: OAuthService, useValue: oauthServiceMock },
        { provide: SecurityEventService, useValue: securityEventServiceMock },
        { provide: RedisService, useValue: redisServiceMock },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
  });

  describe('1. Registration Flow', () => {
    const validDto = {
      phone: '+919876543210',
      name: 'Aarav Test',
      email: 'aarav@test.com',
      schoolCollege: 'DPS Bengaluru',
      classId: 'class-1',
      preferredLanguageId: 'lang-1',
      examTargetId: 'exam-1',
      stateId: 'state-1',
      districtId: 'dist-1',
    };

    it('should submit registration, store temporary state in Redis, and send OTP without activating account', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.findUnique.mockResolvedValue(null);

      const res = await authService.registerStudent(validDto);

      expect(res.data.requiresOtp).toBe(true);
      expect(res.data.purpose).toBe('REGISTER');
      expect(res.data.registrationId).toMatch(/^REG-/);
      expect(res.data.mobileMasked).toBe('******3210');
      expect(otpServiceMock.sendOtp).toHaveBeenCalledWith(
        '+919876543210',
        'REGISTER',
        expect.any(Object),
      );
      expect(prismaMock.user.create).not.toHaveBeenCalled();
      expect(prismaMock.student.create).not.toHaveBeenCalled();
    });

    it('should reject registration if mobile number already exists', async () => {
      prismaMock.user.findFirst.mockResolvedValue({ id: 'existing-user-id' });

      await expect(
        authService.registerStudent(validDto as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject registration if email already exists', async () => {
      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.findUnique.mockResolvedValue({ id: 'existing-email-id' });

      await expect(
        authService.registerStudent(validDto as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should verify registration OTP, atomically create User and Student, and generate Student ID', async () => {
      const registrationId = 'REG-12345';
      mockRedisStorage.set(
        `registration:${registrationId}`,
        JSON.stringify({
          registrationId,
          mobile: '+919876543210',
          email: 'aarav@test.com',
          name: 'Aarav Test',
          state: 'Karnataka',
          district: 'Bengaluru',
          stateId: 'state-1',
          districtId: 'dist-1',
          schoolCollege: 'DPS Bengaluru',
          classId: 'class-1',
          preferredLanguageId: 'lang-1',
          examTargetId: 'exam-1',
          status: 'PENDING_OTP',
        }),
      );

      prismaMock.user.findFirst.mockResolvedValue(null);
      prismaMock.user.create.mockResolvedValue({
        id: 'new-user-id',
        email: 'aarav@test.com',
        mobileNumber: '+919876543210',
        status: 'ACTIVE',
        isVerified: true,
        userRoles: [{ role: { name: 'STUDENT' } }],
      });
      prismaMock.student.create.mockResolvedValue({
        id: 'new-student-id',
        userId: 'new-user-id',
        studentId: 'STU001043',
        studentCode: 'BRN-2026-000043',
        name: 'Aarav Test',
      });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'new-user-id',
        email: 'aarav@test.com',
        mobileNumber: '+919876543210',
        status: 'ACTIVE',
        isVerified: true,
        userRoles: [{ role: { name: 'STUDENT' } }],
        student: {
          id: 'new-student-id',
          studentId: 'STU001043',
          studentCode: 'BRN-2026-000043',
          name: 'Aarav Test',
        },
      });

      const res = await authService.verifyRegistrationOtp({
        registrationId,
        otp: '12345',
      });

      expect(otpServiceMock.verifyOtp).toHaveBeenCalledWith(
        '+919876543210',
        '12345',
        'REGISTER',
        expect.any(Object),
      );
      expect(res.data.otpVerified).toBe(true);
      expect(res.data.requiresPayment).toBe(true);
      expect(res.data.feeAmount).toBe(300);
    });

    it('should reject verify registration if registrationId is expired or invalid', async () => {
      await expect(
        authService.verifyRegistrationOtp({
          registrationId: 'INVALID-ID',
          otp: '12345',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('2. Passwordless Login Flow', () => {
    const mockStudentUser = {
      id: 'student-user-id',
      email: 'student@brainros.test',
      phone: '+919000000001',
      mobileNumber: '+919000000001',
      status: 'ACTIVE',
      isActive: true,
      userRoles: [{ role: { name: 'STUDENT' } }],
      student: {
        id: 'student-profile-id',
        studentId: 'STU001001',
        studentCode: 'BRN-2026-000001',
        name: 'Test Student',
      },
    };

    it('should request login OTP using Email as identifier and send OTP to verified mobile', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockStudentUser);

      const res = await authService.requestPasswordlessLoginOtp({
        identifier: 'student@brainros.test',
      });

      expect(res.data.requiresOtp).toBe(true);
      expect(res.data.purpose).toBe('LOGIN');
      expect(res.data.loginRequestId).toMatch(/^LOGIN-/);
      expect(res.data.mobileMasked).toBe('******0001');
      expect(otpServiceMock.sendOtp).toHaveBeenCalledWith(
        '+919000000001',
        'LOGIN',
        expect.any(Object),
      );
    });

    it('should reject login OTP request using Student ID (disallowed in favor of password login)', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.user.findFirst.mockResolvedValue(null);

      await expect(
        authService.requestPasswordlessLoginOtp({
          identifier: 'BRN-2026-000001',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(otpServiceMock.sendOtp).not.toHaveBeenCalled();
    });

    it('should request login OTP using Mobile number (+919000000001)', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.student.findFirst.mockResolvedValue(null);
      prismaMock.user.findFirst.mockResolvedValue(mockStudentUser);

      const res = await authService.requestPasswordlessLoginOtp({
        identifier: '+919000000001',
      });

      expect(res.data.requiresOtp).toBe(true);
      expect(otpServiceMock.sendOtp).toHaveBeenCalledWith(
        '+919000000001',
        'LOGIN',
        expect.any(Object),
      );
    });

    it('should reject login request for non-existent identifier', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.student.findFirst.mockResolvedValue(null);
      prismaMock.user.findFirst.mockResolvedValue(null);

      await expect(
        authService.requestPasswordlessLoginOtp({
          identifier: 'unknown@test.com',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject login request for suspended or inactive accounts', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...mockStudentUser,
        status: 'SUSPENDED',
      });

      await expect(
        authService.requestPasswordlessLoginOtp({
          identifier: 'student@brainros.test',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should verify login OTP and return unified authentication session', async () => {
      const loginRequestId = 'LOGIN-12345';
      mockRedisStorage.set(
        `login:${loginRequestId}`,
        JSON.stringify({
          loginRequestId,
          userId: 'student-user-id',
          mobile: '+919000000001',
          identifier: 'student@brainros.test',
          status: 'PENDING_OTP',
        }),
      );

      prismaMock.user.findUnique.mockResolvedValue(mockStudentUser);
      prismaMock.user.update.mockResolvedValue(mockStudentUser);

      const res = await authService.verifyPasswordlessLoginOtp({
        loginRequestId,
        otp: '12345',
      });

      expect(otpServiceMock.verifyOtp).toHaveBeenCalledWith(
        '+919000000001',
        '12345',
        'LOGIN',
        expect.any(Object),
      );
      expect(res.message).toBe('Login successful');
      expect(res.data.accessToken).toBe('mock-access-token');
      expect(res.data.refreshToken).toBe('mock-refresh-token');
      expect(mockRedisStorage.has(`login:${loginRequestId}`)).toBe(false);
    });
  });

  describe('3. Resend OTP', () => {
    it('should resend OTP for active registration request', async () => {
      mockRedisStorage.set(
        'registration:REG-999',
        JSON.stringify({ mobile: '+919876543210', status: 'PENDING_OTP' }),
      );

      const res = await authService.resendOtp({ registrationId: 'REG-999' });

      expect(res.message).toContain('resent successfully');
      expect(otpServiceMock.sendOtp).toHaveBeenCalledWith(
        '+919876543210',
        'REGISTER',
        expect.any(Object),
      );
    });

    it('should resend OTP for active login request', async () => {
      mockRedisStorage.set(
        'login:LOGIN-999',
        JSON.stringify({
          mobile: '+919000000001',
          userId: 'u-1',
          status: 'PENDING_OTP',
        }),
      );

      const res = await authService.resendOtp({ loginRequestId: 'LOGIN-999' });

      expect(res.message).toContain('resent successfully');
      expect(otpServiceMock.sendOtp).toHaveBeenCalledWith(
        '+919000000001',
        'LOGIN',
        expect.any(Object),
      );
    });
  });

  describe('4. Student ID + Password Login (loginWithStudentId)', () => {
    const studentUser = {
      id: 'student-user-id',
      email: 'student@brainros.test',
      phone: '+919000000001',
      mobileNumber: '+919000000001',
      passwordHash: 'hashed-password',
      status: 'ACTIVE',
      isActive: true,
      userRoles: [{ role: { name: 'STUDENT' } }],
      student: {
        id: 'student-profile-1',
        studentId: 'STU001',
        studentCode: 'BRN-2026-000001',
        name: 'Test Student',
      },
    };

    it('should authenticate student with valid studentId and password without calling OTP', async () => {
      const studentRecord = {
        id: 'student-profile-1',
        studentId: 'STU001',
        studentCode: 'BRN-2026-000001',
        name: 'Test Student',
        status: 'ACTIVE',
        user: studentUser,
      };

      prismaMock.student.findFirst.mockResolvedValue(studentRecord);
      prismaMock.user.update.mockResolvedValue(studentRecord.user);
      prismaMock.user.findUnique.mockResolvedValue(studentUser);

      const res = await authService.loginWithStudentId(
        'BRN-2026-000001',
        'ValidPassword123!',
      );

      expect(res.data.accessToken).toBe('mock-access-token');
      expect(res.data.refreshToken).toBe('mock-refresh-token');
      expect(res.data.student.studentId).toBe('STU001');
      expect(otpServiceMock.sendOtp).not.toHaveBeenCalled();
    });

    it('should reject incorrect password with UnauthorizedException', async () => {
      passwordServiceMock.comparePassword.mockResolvedValueOnce(false);
      const studentRecord = {
        id: 'student-profile-1',
        studentId: 'STU001',
        studentCode: 'BRN-2026-000001',
        name: 'Test Student',
        status: 'ACTIVE',
        user: studentUser,
      };

      prismaMock.student.findFirst.mockResolvedValue(studentRecord);

      await expect(
        authService.loginWithStudentId('BRN-2026-000001', 'WrongPassword!'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject unknown Student ID with UnauthorizedException', async () => {
      prismaMock.student.findFirst.mockResolvedValue(null);

      await expect(
        authService.loginWithStudentId('NON_EXISTENT_ID', 'SomePassword1!'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
