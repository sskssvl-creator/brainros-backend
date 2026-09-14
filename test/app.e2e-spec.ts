import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { ResponseInterceptor } from './../src/common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './../src/common/filters/global-exception.filter';
import { RedisService } from './../src/modules/redis/redis.service';
import { TwoFactorProvider } from './../src/modules/auth/otp/two-factor.provider';
import { PrismaService } from './../src/modules/prisma/prisma.service';

describe('Authentication & Passwordless Flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mockRedisStore: Record<string, string> = {};

  const mockRedis = {
    get: jest
      .fn()
      .mockImplementation((key) =>
        Promise.resolve(mockRedisStore[key] || null),
      ),
    set: jest.fn().mockImplementation((key, val) => {
      mockRedisStore[key] = val;
      return Promise.resolve();
    }),
    del: jest.fn().mockImplementation((key) => {
      delete mockRedisStore[key];
      return Promise.resolve();
    }),
    keys: jest.fn().mockImplementation(() => Promise.resolve([])),
  };

  const mockTwoFactor = {
    sendOtp: jest.fn().mockResolvedValue('mock-session-id-12345'),
    verifyOtp: jest.fn().mockImplementation((sess, code) => {
      if (code === '123456' || code === '12345') return Promise.resolve(true);
      return Promise.resolve(false);
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue(mockRedis)
      .overrideProvider(TwoFactorProvider)
      .useValue(mockTwoFactor)
      .compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get<PrismaService>(PrismaService);

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        exceptionFactory: (errors) => {
          const formattedErrors = errors.map((err) => ({
            field: err.property,
            messages: Object.values(err.constraints || {}),
          }));
          const firstMessage = formattedErrors[0]?.messages?.[0];
          const readableSummary =
            formattedErrors.length === 1
              ? firstMessage || 'Please correct the invalid field and try again.'
              : firstMessage
                ? `${firstMessage} (and ${formattedErrors.length - 1} other field issue${formattedErrors.length > 2 ? 's' : ''})`
                : 'Please review and correct the invalid form fields.';
          return new BadRequestException({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: readableSummary,
            error: 'Bad Request',
            details: formattedErrors,
          });
        },
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
  });

  beforeEach(() => {
    mockRedisStore = {};
    jest.clearAllMocks();
  });

  it('1. GET / should return formatted success response envelope', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body).toEqual({
      success: true,
      statusCode: 200,
      message: 'Request successful',
      data: 'Hello World!',
      meta: null,
      timestamp: expect.any(String),
      path: '/',
    });
  });

  it('2. POST /auth/register should validate schema and reject invalid fields', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone: 'invalid-phone',
        name: '',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.details).toBeDefined();
    expect(response.body.message).toBeDefined();
    expect(response.body.message.length).toBeGreaterThan(0);
  });

  it('3. GET /auth/options should return available registration options', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/options')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.classes).toBeDefined();
    expect(response.body.data.languages).toBeDefined();
    expect(response.body.data.examTargets).toBeDefined();
  });

  it('4. POST /auth/login/request-otp should reject empty identifier', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login/request-otp')
      .send({})
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  afterAll(async () => {
    await app.close();
  });
});
