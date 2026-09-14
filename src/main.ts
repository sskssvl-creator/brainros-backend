import './common/infrastructure/init-bullmq';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
if (fs.existsSync('.env.production')) {
  dotenv.config({ path: '.env.production' });
}
dotenv.config({ path: '.env' });
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { AppLoggerService } from './common/logger/logger.service';
import { InfrastructureStateService } from './common/infrastructure/infrastructure-state.service';
import { parseBooleanFlag } from './modules/feature-flag/feature-flag.constants';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import * as express from 'express';

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

import { validateEnvironment } from './common/config/environment-validation';
export { validateEnvironment };

async function bootstrap() {
  const bootstrapStartTime = Date.now();
  bootstrapLogger.log('[STARTUP] Beginning application bootstrap...', 'Bootstrap');

  validateEnvironment(bootstrapLogger);

  const app = await NestFactory.create(AppModule, {
    logger: bootstrapLogger,
    rawBody: true,
  });

  const port = process.env.PORT ?? 3000;

  const appLogger = app.get(AppLoggerService);
  app.useLogger(appLogger);

  // Enable graceful shutdown hooks for SIGTERM / SIGINT
  app.enableShutdownHooks();

  // Security middlewares
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.use(
    express.json({
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(
    express.urlencoded({
      extended: true,
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

  // Register global validation pipe BEFORE listen
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

  // Register global HTTP response formatting interceptor BEFORE listen
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Register global unhandled exception and database error filter with centralized logger BEFORE listen
  const infrastructureState = app.get(InfrastructureStateService);
  app.useGlobalFilters(new GlobalExceptionFilter(appLogger, infrastructureState));

  // Handle termination signals cleanly
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, async () => {
      appLogger.log(`Received ${signal}. Initiating graceful shutdown...`, 'Shutdown');
      try {
        await app.close();
        appLogger.log('Application closed cleanly.', 'Shutdown');
        appLogger.flush();
        process.exit(0);
      } catch (err: any) {
        appLogger.error(`Error during graceful shutdown: ${err.message}`, err.stack, 'Shutdown');
        appLogger.flush();
        process.exit(1);
      }
    });
  }

  // Unconditionally listen on all interfaces
  await app.listen(port, '0.0.0.0');

  const bootstrapDuration = Date.now() - bootstrapStartTime;
  appLogger.log(
    `[STARTUP] HTTP server listening on port ${port} (0.0.0.0:${port}) [took ${bootstrapDuration}ms]`,
    'Bootstrap',
  );

  // Evaluate and log startup status of dependent services
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

  // Start optional Ngrok tunnel if enabled
  if (process.env.ENABLE_NGROK === 'true' && process.env.NGROK_AUTHTOKEN) {
    try {
      const ngrok = await import('@ngrok/ngrok');
      const ngrokDomain = process.env.NGROK_DOMAIN || 'footing-gallon-radial.ngrok-free.dev';
      const forwarder = await ngrok.forward({
        addr: `localhost:${port}`,
        domain: ngrokDomain,
        authtoken_from_env: true,
        request_header_add: ['ngrok-skip-browser-warning:true'],
        ...(process.env.NGROK_AUTHTOKEN ? { authtoken: process.env.NGROK_AUTHTOKEN } : {}),
      });
      appLogger.log(
        `[Ngrok] Public tunnel online: ${forwarder.url()} -> localhost:${port}`,
        'Bootstrap',
      );
    } catch (err: any) {
      appLogger.warn(`[Ngrok] Could not establish tunnel: ${err.message}`, 'Bootstrap');
    }
  }

  appLogger.flush();
}

bootstrap();
