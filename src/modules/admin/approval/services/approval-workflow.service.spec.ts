import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalWorkflowService } from './approval-workflow.service';
import { ApprovalHandlerRegistry } from '../handlers/approval-handler.registry';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('ApprovalWorkflowService (Central Workflow & Self-Approval Prevention)', () => {
  let service: ApprovalWorkflowService;
  let prisma: any;
  let registry: any;
  let auditService: any;
  let mockHandler: any;

  beforeEach(async () => {
    mockHandler = {
      entityType: 'QUESTION',
      validateEntity: jest
        .fn()
        .mockResolvedValue({ id: 'q-1', status: 'SUBMITTED' }),
      onApprove: jest.fn().mockResolvedValue({
        beforeState: { status: 'SUBMITTED' },
        afterState: { status: 'APPROVED' },
      }),
      onReject: jest.fn().mockResolvedValue({
        beforeState: { status: 'SUBMITTED' },
        afterState: { status: 'REJECTED' },
      }),
      onCancel: jest.fn().mockResolvedValue({
        beforeState: { status: 'SUBMITTED' },
        afterState: { status: 'DRAFT' },
      }),
    };

    registry = {
      getHandler: jest.fn().mockReturnValue(mockHandler),
    };

    prisma = {
      approvalRequest: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((cb) =>
        typeof cb === 'function' ? cb(prisma) : Promise.all(cb),
      ),
    };

    auditService = {
      logAction: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalWorkflowService,
        { provide: PrismaService, useValue: prisma },
        { provide: ApprovalHandlerRegistry, useValue: registry },
        { provide: AuditLogService, useValue: auditService },
      ],
    }).compile();

    service = module.get<ApprovalWorkflowService>(ApprovalWorkflowService);
  });

  describe('submit', () => {
    it('should submit request when valid and no duplicate pending request exists', async () => {
      prisma.approvalRequest.findFirst.mockResolvedValue(null);
      prisma.approvalRequest.create.mockResolvedValue({
        id: 'req-1',
        resourceType: 'QUESTION',
        resourceId: 'q-1',
        status: 'PENDING',
      });

      const res = await service.submit(
        { entityType: 'QUESTION', entityId: 'q-1' },
        'admin-user-1',
      );

      expect(res.id).toBe('req-1');
      expect(mockHandler.validateEntity).toHaveBeenCalledWith('q-1');
      expect(auditService.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUBMIT_APPROVAL',
          actorUserId: 'admin-user-1',
          entityType: 'QUESTION',
        }),
      );
    });

    it('should block duplicate pending approval request for the same entity', async () => {
      prisma.approvalRequest.findFirst.mockResolvedValue({
        id: 'existing-pending',
        status: 'PENDING',
      });

      await expect(
        service.submit(
          { entityType: 'QUESTION', entityId: 'q-1' },
          'admin-user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('approve (Self-Approval Prevention & State Enforcement)', () => {
    it('should throw ForbiddenException (403) when submitter tries to self-approve', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        resourceType: 'QUESTION',
        resourceId: 'q-1',
        requestedById: 'user-same-id',
        status: 'PENDING',
      });

      await expect(
        service.approve('req-1', 'user-same-id', { comment: 'Looks good' }),
      ).rejects.toThrow(ForbiddenException);

      expect(mockHandler.onApprove).not.toHaveBeenCalled();
    });

    it('should approve when reviewer is a different Super Admin and record audit log', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        resourceType: 'QUESTION',
        resourceId: 'q-1',
        requestedById: 'admin-creator',
        status: 'PENDING',
      });
      prisma.approvalRequest.update.mockResolvedValue({
        id: 'req-1',
        status: 'APPROVED',
        reviewedById: 'super-admin-reviewer',
      });

      const result = await service.approve('req-1', 'super-admin-reviewer', {
        comment: 'Verified',
      });

      expect(result.status).toBe('APPROVED');
      expect(mockHandler.onApprove).toHaveBeenCalled();
      expect(auditService.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'APPROVE',
          actorUserId: 'super-admin-reviewer',
          entityType: 'QUESTION',
          beforeState: { status: 'SUBMITTED' },
          afterState: { status: 'APPROVED' },
        }),
      );
    });

    it('should throw BadRequestException if request is not in PENDING status', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        resourceType: 'QUESTION',
        resourceId: 'q-1',
        requestedById: 'admin-creator',
        status: 'APPROVED', // already approved
      });

      await expect(
        service.approve('req-1', 'super-admin-reviewer'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('reject', () => {
    it('should require a non-empty reason for rejection', async () => {
      await expect(
        service.reject('req-1', 'reviewer-1', { reason: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject pending request, invoke handler, and record audit log with reason', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        resourceType: 'QUESTION',
        resourceId: 'q-1',
        requestedById: 'admin-creator',
        status: 'PENDING',
      });
      prisma.approvalRequest.update.mockResolvedValue({
        id: 'req-1',
        status: 'REJECTED',
        rejectionReason: 'Invalid answer explanation',
      });

      const result = await service.reject('req-1', 'super-admin-reviewer', {
        reason: 'Invalid answer explanation',
      });

      expect(result.status).toBe('REJECTED');
      expect(mockHandler.onReject).toHaveBeenCalledWith(
        expect.anything(),
        'super-admin-reviewer',
        'Invalid answer explanation',
        expect.anything(),
      );
      expect(auditService.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REJECT',
          reason: 'Invalid answer explanation',
        }),
      );
    });
  });
});
