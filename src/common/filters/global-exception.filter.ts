import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiErrorResponse } from '../interfaces/api-error.interface';
import { AppLoggerService } from '../logger/logger.service';
import { RequestContext } from '../logger/request-context';
import { InfrastructureStateService } from '../infrastructure/infrastructure-state.service';

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly appLogger: AppLoggerService = new AppLoggerService(),
    private readonly infrastructureState?: InfrastructureStateService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error = 'Internal Server Error';
    let code: string | undefined = undefined;
    let details: any = null;
    let errorName = 'UnhandledException';

    const path = request.url;
    const method = request.method;
    const timestamp = new Date().toISOString();
    const requestId =
      request.id ||
      request.headers['x-request-id'] ||
      RequestContext.getRequestId() ||
      undefined;

    const user = request.user;
    const userId = user?.userId || user?.id || user?.sub || RequestContext.getUserId() || undefined;
    const role = user?.role || user?.roles?.[0]?.name || user?.userRoles?.[0]?.role?.name || RequestContext.getRole() || undefined;

    // 1. Handle NestJS HttpException (BadRequest, NotFound, Unauthorized, etc.)
    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      errorName = exception.name;
      const resBody = exception.getResponse();

      if (typeof resBody === 'object' && resBody !== null) {
        error = (resBody as any).error || exception.name;
        const rawMessage = (resBody as any).message || exception.message;
        message = Array.isArray(rawMessage)
          ? rawMessage.join('. ')
          : String(rawMessage);
        code = (resBody as any).code || undefined;
        details = (resBody as any).details || null;
      } else {
        message = exception.message || String(resBody);
      }

      // Safe fallback for standard HTTP statuses if message is generic
      if (!message || message === 'Http Exception') {
        if (statusCode === HttpStatus.FORBIDDEN) {
          message = 'You do not have permission to perform this action.';
        } else if (statusCode === HttpStatus.UNAUTHORIZED) {
          message = 'Your session has expired or you are not authorized. Please log in again.';
        } else if (statusCode === HttpStatus.NOT_FOUND) {
          message = 'The requested resource could not be found.';
        } else if (statusCode === HttpStatus.CONFLICT) {
          message = 'A conflict occurred with an existing record.';
        }
      }
    }
    // 2. Handle Prisma Known Request Database Exceptions (Unique constraint, record missing, relation errors, etc.)
    else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      errorName = 'PrismaClientKnownRequestError';
      const prismaMapping = this.handlePrismaError(exception);
      statusCode = prismaMapping.statusCode;
      message = prismaMapping.message;
      error = prismaMapping.error;
      code = prismaMapping.code || exception.code;
      details = prismaMapping.details;
    }
    // 3. Handle Other Prisma validation/initialization/panic errors
    else if (exception instanceof Prisma.PrismaClientValidationError) {
      errorName = 'PrismaClientValidationError';
      statusCode = HttpStatus.BAD_REQUEST;
      code = 'DATA_VALIDATION_ERROR';
      message = 'Invalid data format provided for this operation. Please verify your input and try again.';
      error = 'Bad Request';
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      this.infrastructureState?.setDatabaseState('DOWN', exception.message);
      errorName = 'PrismaClientInitializationError';
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'DATABASE_UNAVAILABLE';
      message = 'Database service is temporarily unavailable. Please retry in a few moments.';
      error = 'Service Unavailable';
    } else if (exception instanceof Prisma.PrismaClientRustPanicError) {
      this.infrastructureState?.setDatabaseState('DOWN', exception.message);
      errorName = 'PrismaClientRustPanicError';
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'DATABASE_ENGINE_ERROR';
      message = 'Database engine error. Service temporarily unavailable. Please retry shortly.';
      error = 'Service Unavailable';
    } else if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      errorName = 'PrismaClientUnknownRequestError';
      const msg = exception.message || '';
      if (
        msg.includes('Connection') ||
        msg.includes('connection') ||
        msg.includes('socket') ||
        msg.includes('timeout') ||
        msg.includes('terminated')
      ) {
        this.infrastructureState?.setDatabaseState('DOWN', msg);
        statusCode = HttpStatus.SERVICE_UNAVAILABLE;
        code = 'DATABASE_CONNECTION_LOST';
        message = 'Database connection was interrupted. Please try again shortly.';
        error = 'Service Unavailable';
      } else {
        statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
        code = 'DATABASE_REQUEST_ERROR';
        message = 'A database request error occurred. Please try again.';
        error = 'Internal Server Error';
      }
    }
    // 4. Handle Redis / BullMQ / Network infrastructure errors gracefully
    else {
      const exMessage = exception instanceof Error ? exception.message : String(exception);
      errorName = exception instanceof Error ? exception.name : 'UnknownError';

      if (
        exMessage.includes('Connection is closed') ||
        exMessage.includes('ECONNREFUSED') ||
        exMessage.includes('enableOfflineQueue') ||
        exMessage.includes('Redis connection lost') ||
        exMessage.includes('connect ETIMEDOUT')
      ) {
        statusCode = HttpStatus.SERVICE_UNAVAILABLE;
        code = 'INFRASTRUCTURE_UNAVAILABLE';
        message = 'Background processing is temporarily unavailable. Please try again.';
        error = 'Service Unavailable';
      } else {
        message = exMessage;
      }
    }

    // 5. Centralized Structured Logging
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.appLogger.logError({
      message: `[${method}] ${path} ${statusCode} - ${message}`,
      errorName,
      errorCode: code,
      statusCode,
      method,
      path,
      userId,
      role,
      requestId,
      stack: statusCode >= 500 ? stack : undefined,
    });

    // 6. Safe response to client (NEVER returns stack traces, internal connection strings, or database hosts)
    const errorResponse: ApiErrorResponse = {
      success: false,
      statusCode,
      message,
      error,
      ...(code ? { code } : {}),
      details,
      timestamp,
      path,
      ...(requestId ? { requestId } : {}),
    };

    response.status(statusCode).json(errorResponse);
  }

  /**
   * Safe mapping of database-layer errors to client-layer HTTP responses
   */
  private handlePrismaError(err: Prisma.PrismaClientKnownRequestError): {
    statusCode: number;
    message: string;
    error: string;
    code?: string;
    details: any;
  } {
    switch (err.code) {
      case 'P1000':
      case 'P1001':
      case 'P1002':
      case 'P1008':
      case 'P1011':
      case 'P1017':
        this.infrastructureState?.setDatabaseState('DOWN', err.message);
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'DATABASE_UNREACHABLE',
          message: 'Database service is temporarily unreachable. Please try again shortly.',
          error: 'Service Unavailable',
          details: null,
        };

      case 'P2000':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          code: 'INPUT_VALUE_TOO_LONG',
          message: 'One or more fields exceed the maximum allowable character limit.',
          error: 'Bad Request',
          details: null,
        };

      case 'P2002': {
        const target = err.meta?.target;
        const targetStr = Array.isArray(target)
          ? target.join(',').toLowerCase()
          : String(target || '').toLowerCase();

        let message = 'A record with this unique value already exists.';
        let code = 'DUPLICATE_RESOURCE_CONFLICT';

        if (targetStr.includes('mobile') || targetStr.includes('phone')) {
          message = 'A student or user with this mobile number already exists.';
          code = 'STUDENT_MOBILE_EXISTS';
        } else if (targetStr.includes('email')) {
          message = 'A user with this email address already exists.';
          code = 'EMAIL_ALREADY_EXISTS';
        } else if (
          targetStr.includes('billnumber') ||
          (targetStr.includes('institutionid') && targetStr.includes('billingmonth'))
        ) {
          message = 'An invoice already exists for this school and billing period.';
          code = 'INVOICE_ALREADY_EXISTS';
        } else if (targetStr.includes('examid') && targetStr.includes('studentid')) {
          message = 'This student is already registered for or has attempted this exam.';
          code = 'ATTEMPT_ALREADY_EXISTS';
        } else if (
          targetStr.includes('questionnumber') ||
          targetStr.includes('orderindex') ||
          targetStr.includes('sequencenumber')
        ) {
          message = 'A question with this number already exists in this question paper.';
          code = 'DUPLICATE_QUESTION_NUMBER';
        } else if (targetStr.includes('rollnumber') || targetStr.includes('roll_no')) {
          message = 'A student with this roll number already exists.';
          code = 'ROLL_NUMBER_EXISTS';
        } else if (targetStr.includes('code')) {
          message = 'A record with this unique code already exists.';
          code = 'CODE_ALREADY_EXISTS';
        } else if (targetStr.includes('username')) {
          message = 'This username is already taken.';
          code = 'USERNAME_ALREADY_EXISTS';
        }

        return {
          statusCode: HttpStatus.CONFLICT,
          code,
          message,
          error: 'Conflict',
          details: {
            constraint: 'UniqueConstraint',
            fields: target || null,
          },
        };
      }

      case 'P2003': {
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          code: 'FOREIGN_KEY_CONSTRAINT_VIOLATION',
          message: 'The referenced related record (such as selected school, subject, chapter, or user) does not exist or is no longer available.',
          error: 'Bad Request',
          details: null,
        };
      }

      case 'P2014':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          code: 'RELATION_CONSTRAINT_VIOLATION',
          message: 'This operation cannot be completed because it is linked to other existing records.',
          error: 'Bad Request',
          details: null,
        };

      case 'P2025': {
        const cause = typeof err.meta?.cause === 'string' ? err.meta.cause : '';
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: 'RESOURCE_NOT_FOUND',
          message: cause.length > 0 && !cause.includes('Record to update not found')
            ? cause
            : 'The requested record could not be found or has already been removed.',
          error: 'Not Found',
          details: null,
        };
      }

      case 'P2028':
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'DATABASE_TRANSACTION_TIMEOUT',
          message: 'The database operation timed out due to high load. Please retry your request.',
          error: 'Service Unavailable',
          details: null,
        };

      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          code: `DB_${err.code}`,
          message: 'A database error occurred while processing your request. Please try again.',
          error: 'Internal Server Error',
          details: { code: err.code },
        };
    }
  }
}
