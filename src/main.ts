import * as dotenv from 'dotenv';
import * as fs from 'fs';

// 1. Load environment variables before any application modules evaluate
if (process.env.NODE_ENV === 'production' && fs.existsSync('.env.production')) {
  dotenv.config({ path: '.env.production', override: true });
} else if (fs.existsSync('.env')) {
  dotenv.config({ path: '.env', override: true });
}

import './common/infrastructure/init-bullmq';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { AppLoggerService } from './common/logger/logger.service';
import { InfrastructureStateService } from './common/infrastructure/infrastructure-state.service';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import * as express from 'express';
import * as path from 'path';
import { validateEnvironment } from './common/config/environment-validation';

export { validateEnvironment };

// Global error handlers to prevent silent process death
const bootstrapLogger = new AppLoggerService();
bootstrapLogger.setContext('Bootstrap');

process.on('unhandledRejection', (reason: any) => {
  bootstrapLogger.error(
    `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
    'UnhandledRejection',
  );
});

process.on('uncaughtException', (error: Error) => {
  bootstrapLogger.fatal(
    `Uncaught Exception: ${error.message}`,
    error.stack,
    'UncaughtException',
  );
});

async function bootstrap() {
  const bootstrapStartTime = Date.now();
  bootstrapLogger.log('[STARTUP] Beginning application bootstrap...', 'Bootstrap');

  validateEnvironment(bootstrapLogger);

  const app = await NestFactory.create(AppModule, {
    logger: bootstrapLogger,
    rawBody: true,
  });

  const port = Number(process.env.PORT) || 3000;

  const appLogger = app.get(AppLoggerService);
  app.useLogger(appLogger);

  // Enable graceful shutdown hooks for SIGTERM / SIGINT
  app.enableShutdownHooks();

  // Trust reverse proxy headers (Hostinger CDN / Cloud Nginx)
  const expressInstance = app.getHttpAdapter().getInstance() as express.Application;
  if (expressInstance && typeof expressInstance.set === 'function') {
    expressInstance.set('trust proxy', 1);
  }

  // Allow test client IPs (ALLOWED_TEST_IPS) for high-concurrency load testing
  const rawAllowedTestIps = process.env.ALLOWED_TEST_IPS || '';
  const allowedTestIps = new Set(
    rawAllowedTestIps
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
  );

  if (allowedTestIps.size > 0) {
    appLogger.log(
      `[Security] Configured ALLOWED_TEST_IPS whitelist: [${Array.from(allowedTestIps).join(', ')}]`,
      'Bootstrap',
    );
  }

  app.use((req: any, _res: any, next: any) => {
    if (allowedTestIps.size > 0) {
      const clientIp =
        req.headers['cf-connecting-ip'] ||
        req.headers['x-real-ip'] ||
        (typeof req.headers['x-forwarded-for'] === 'string'
          ? req.headers['x-forwarded-for'].split(',')[0].trim()
          : undefined) ||
        req.ip ||
        req.socket?.remoteAddress ||
        '';

      if (allowedTestIps.has('*') || allowedTestIps.has(clientIp)) {
        req.isAllowedTestIp = true;
      }
    }
    next();
  });

  // Security middlewares
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());

  // Body parsers with safe production payload limit (15MB for large question papers & batch imports)
  const bodyLimit = process.env.BODY_PAYLOAD_LIMIT || '15mb';
  app.use(
    express.json({
      limit: bodyLimit,
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: true,
      limit: bodyLimit,
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );

  // Enable HTTP response compression for payloads > 1KB
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );

  // Normalize duplicate slashes in request URLs (e.g. //auth/refresh -> /auth/refresh)
  app.use((req: any, _res: any, next: any) => {
    if (req.url && req.url.includes('//')) {
      req.url = req.url.replace(/\/{2,}/g, '/');
    }
    next();
  });

  // CORS Configuration
  const allowedOrigins = [
    'https://brainros.com',
    'https://www.brainros.com',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
  ];

  if (process.env.FRONTEND_URL) {
    const envOrigins = process.env.FRONTEND_URL.split(',').map((o) => o.trim());
    for (const o of envOrigins) {
      if (o && !allowedOrigins.includes(o)) {
        allowedOrigins.push(o);
      }
    }
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server, health check probes)
      if (!origin) {
        return callback(null, true);
      }
      if (
        allowedOrigins.includes(origin) ||
        process.env.NODE_ENV !== 'production'
      ) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'Cookie',
      'x-request-id',
      'ngrok-skip-browser-warning',
      'Origin',
      'Cache-Control',
      'Pragma',
    ],
    credentials: true,
    optionsSuccessStatus: 204,
  });

  // Serve locally-stored question images (fallback when Cloudinary is unavailable)
  const uploadsDir = path.resolve(process.cwd(), 'storage', 'uploads');
  app.use(
    '/storage/uploads',
    express.static(uploadsDir, {
      maxAge: '7d',
      immutable: true,
      fallthrough: true,
    }),
  );

  // Register global validation pipe
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

  // Register global HTTP response formatting interceptor
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Register global unhandled exception and database error filter
  const infrastructureState = app.get(InfrastructureStateService);
  app.useGlobalFilters(new GlobalExceptionFilter(appLogger, infrastructureState));

  // Listen on all interfaces
  await app.listen(port, '0.0.0.0');

  const bootstrapDuration = Date.now() - bootstrapStartTime;
  appLogger.log(
    `[STARTUP] HTTP server listening on port ${port} (0.0.0.0:${port}) [took ${bootstrapDuration}ms]`,
    'Bootstrap',
  );

  // Evaluate startup status of dependent services
  const healthReport = infrastructureState.getHealthReport();
  const degradedServices: string[] = [];
  if (healthReport.database !== 'up') {
    degradedServices.push('database');
  }
  if (healthReport.redis === 'down') {
    degradedServices.push('redis');
  }
  if (healthReport.queue === 'down') {
    degradedServices.push('queue');
  }

  if (degradedServices.length > 0) {
    appLogger.warn(
      `[STARTUP WARNING] Started with degraded services: [${degradedServices.join(
        ', ',
      )}]. HTTP server is accepting traffic, and dependent services are reconnecting in the background.`,
      'Bootstrap',
    );
  } else {
    appLogger.log(
      `[STARTUP] Application fully operational in ${process.env.NODE_ENV || 'development'} mode.`,
      'Bootstrap',
    );
  }

  appLogger.flush();
}

bootstrap();
