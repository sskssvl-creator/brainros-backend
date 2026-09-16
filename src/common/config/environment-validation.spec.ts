import { validateEnvironment } from './environment-validation';
import { AppLoggerService } from '../logger/logger.service';

describe('validateEnvironment', () => {
  let mockLogger: jest.Mocked<AppLoggerService>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockLogger = {
      fatal: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
      setContext: jest.fn(),
    } as any;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should pass in non-production when DATABASE_URL is provided', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';

    expect(() => validateEnvironment(mockLogger)).not.toThrow();
    expect(mockLogger.fatal).not.toHaveBeenCalled();
  });

  it('should throw and exit if DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    expect(() => validateEnvironment(mockLogger)).toThrow(/Missing required environment variable/);
    expect(mockLogger.fatal).toHaveBeenCalledWith(
      expect.stringContaining('Missing required environment variable(s): DATABASE_URL'),
      undefined,
      'ConfigValidation',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('should pass in production with secure JWT_SECRET and real OTP enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.JWT_SECRET = 'a-very-secure-random-production-secret-12345';
    process.env.ENABLE_REAL_OTP = 'true';
    process.env.BYPASS_OTP = 'false';
    process.env.LOGIN_OTP_DATABASE_MODE = 'false';

    expect(() => validateEnvironment(mockLogger)).not.toThrow();
    expect(mockLogger.fatal).not.toHaveBeenCalled();
  });

  it('should throw and exit in production if JWT_SECRET is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    delete process.env.JWT_SECRET;
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    expect(() => validateEnvironment(mockLogger)).toThrow(/Production requires a strong, dedicated JWT_SECRET/);
    expect(mockLogger.fatal).toHaveBeenCalledWith(
      expect.stringContaining('Insecure production configuration: JWT_SECRET is missing'),
      undefined,
      'ConfigValidation',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('should throw and exit in production if JWT_SECRET is default placeholder', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.JWT_SECRET = 'super-secret-jwt-key-replace-in-production';
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    expect(() => validateEnvironment(mockLogger)).toThrow(/Production requires a strong, dedicated JWT_SECRET/);
    expect(mockLogger.fatal).toHaveBeenCalledWith(
      expect.stringContaining('placeholder value'),
      undefined,
      'ConfigValidation',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('should warn in production if BYPASS_OTP=true is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.JWT_SECRET = 'a-secure-production-jwt-secret-xyz';
    process.env.BYPASS_OTP = 'true';

    expect(() => validateEnvironment(mockLogger)).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('BYPASS_OTP=true'),
      'ConfigValidation',
    );
  });

  it('should warn in production if LOGIN_OTP_DATABASE_MODE=true is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.JWT_SECRET = 'a-secure-production-jwt-secret-xyz';
    process.env.LOGIN_OTP_DATABASE_MODE = 'true';

    expect(() => validateEnvironment(mockLogger)).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('LOGIN_OTP_DATABASE_MODE=true'),
      'ConfigValidation',
    );
  });

  it('should warn in production if ENABLE_REAL_OTP=false is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.JWT_SECRET = 'a-secure-production-jwt-secret-xyz';
    process.env.ENABLE_REAL_OTP = 'false';

    expect(() => validateEnvironment(mockLogger)).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ENABLE_REAL_OTP=false'),
      'ConfigValidation',
    );
  });
});
