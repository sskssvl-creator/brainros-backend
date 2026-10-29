import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { Msg91OtpService } from './msg91-otp.service';
import { Msg91OtpProvider } from './msg91-otp.provider';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

describe('Msg91OtpService & Msg91OtpProvider', () => {
  let service: Msg91OtpService;
  let provider: Msg91OtpProvider;
  let httpService: HttpService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'MSG91_AUTH_KEY':
          return 'mockauthkey1234567890';
        case 'MSG91_TEMPLATE_ID':
          return 'mocktemplate123456';
        case 'MSG91_SENDER_ID':
          return 'smsind';
        default:
          return null;
      }
    }),
  };

  const mockHttpService = {
    post: jest.fn(),
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Msg91OtpService,
        Msg91OtpProvider,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpService, useValue: mockHttpService },
      ],
    }).compile();

    service = module.get<Msg91OtpService>(Msg91OtpService);
    provider = module.get<Msg91OtpProvider>(Msg91OtpProvider);
    httpService = module.get<HttpService>(HttpService);
  });

  describe('Phone number normalization for MSG91', () => {
    it('normalizes 10-digit Indian numbers without + (e.g. 919876543210)', () => {
      expect(service.normalizeMobile('9876543210')).toBe('919876543210');
      expect(service.normalizeMobile('919876543210')).toBe('919876543210');
      expect(service.normalizeMobile('+919876543210')).toBe('919876543210');
    });

    it('masks phone numbers safely', () => {
      expect(service.maskPhone('919876543210')).toBe('******3210');
    });
  });

  describe('Msg91OtpProvider sendOtp', () => {
    it('sends OTP via MSG91 API and returns sessionId', async () => {
      mockHttpService.post.mockReturnValueOnce(
        of({
          data: {
            request_id: 'req-msg91-12345',
            type: 'success',
          },
        }),
      );

      const result = await provider.sendOtp('+919876543210', 'LOGIN');
      expect(result).toEqual({
        sessionId: 'req-msg91-12345',
        providerManaged: true,
      });
      expect(mockHttpService.post).toHaveBeenCalled();
    });

    it('throws BadRequestException if MSG91 returns error type', async () => {
      mockHttpService.post.mockReturnValueOnce(
        of({
          data: {
            message: 'Template ID Missing',
            type: 'error',
          },
        }),
      );

      await expect(provider.sendOtp('+919876543210', 'LOGIN')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Msg91OtpProvider verifyOtp', () => {
    it('verifies valid OTP successfully', async () => {
      mockHttpService.get.mockReturnValueOnce(
        of({
          data: {
            message: 'OTP verified success',
            type: 'success',
          },
        }),
      );

      const isValid = await provider.verifyOtp('+919876543210', '123456', 'LOGIN');
      expect(isValid).toBe(true);
    });

    it('throws UnauthorizedException on invalid OTP', async () => {
      mockHttpService.get.mockReturnValueOnce(
        of({
          data: {
            message: 'OTP not match',
            type: 'error',
          },
        }),
      );

      await expect(
        provider.verifyOtp('+919876543210', '000000', 'LOGIN'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Msg91OtpProvider resendOtp', () => {
    it('resends OTP via MSG91 retry endpoint', async () => {
      mockHttpService.get.mockReturnValueOnce(
        of({
          data: {
            type: 'success',
            message: 'OTP resent successfully',
          },
        }),
      );

      const resent = await provider.resendOtp('+919876543210', 'text');
      expect(resent).toBe(true);
    });
  });
});
