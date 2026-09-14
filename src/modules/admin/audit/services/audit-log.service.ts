import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogFilterDto } from '../../dto/admin.dto';

export interface CreateAuditLogParams {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: Record<string, any> | null;
  afterState?: Record<string, any> | null;
  reason?: string | null;
  metadata?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  tx?: any;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an immutable audit log record.
   * Can run within a transaction or standalone.
   */
  async logAction(params: CreateAuditLogParams) {
    const db = params.tx || this.prisma;

    try {
      const log = await db.auditLog.create({
        data: {
          actorUserId: params.actorUserId || null,
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId,
          beforeState: params.beforeState
            ? (params.beforeState as any)
            : undefined,
          afterState: params.afterState
            ? (params.afterState as any)
            : undefined,
          reason: params.reason || null,
          metadata: params.metadata ? (params.metadata as any) : undefined,
          ipAddress: params.ipAddress || null,
          userAgent: params.userAgent || null,
          correlationId: params.correlationId || null,
        },
      });

      return log;
    } catch (err: any) {
      this.logger.error(
        `Failed to persist audit log [${params.action} on ${params.entityType}:${params.entityId}]: ${err.message}`,
      );
      // Non-fatal fallback: do not crash caller if standalone
      if (params.tx) throw err;
      return null;
    }
  }

  /**
   * Query immutable audit logs with pagination and filters.
   */
  async getAuditLogs(filter: AuditLogFilterDto) {
    const page = filter.page || 1;
    const limit = filter.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filter.action) where.action = filter.action;
    if (filter.entityType) where.entityType = filter.entityType;
    if (filter.entityId) where.entityId = filter.entityId;
    if (filter.actorUserId) where.actorUserId = filter.actorUserId;

    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt.gte = new Date(filter.from);
      if (filter.to) where.createdAt.lte = new Date(filter.to);
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: logs,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get audit log detail by ID.
   */
  async getAuditLogById(id: string) {
    return this.prisma.auditLog.findUnique({
      where: { id },
    });
  }
}
