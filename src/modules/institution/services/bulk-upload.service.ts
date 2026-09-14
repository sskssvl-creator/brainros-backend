import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BulkUploadParserService } from './bulk-upload-parser.service';
import { BulkUploadValidatorService } from './bulk-upload-validator.service';
import { BulkUploadActivationService } from './bulk-upload-activation.service';
import {
  BulkUploadPreview,
  BulkUploadErrorItem,
} from '../interfaces/institution.interface';

@Injectable()
export class BulkUploadService {
  private readonly logger = new Logger(BulkUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: BulkUploadParserService,
    private readonly validator: BulkUploadValidatorService,
    private readonly activator: BulkUploadActivationService,
  ) {}

  /**
   * Upload and stage a CSV/XLSX file.
   */
  async uploadFile(
    institutionId: string,
    batchId: string | null,
    userId: string,
    file: Express.Multer.File,
  ) {
    this.parser.validateFile(file);

    // Verify institution is ACTIVE
    const institution = await this.prisma.institution.findUnique({
      where: { id: institutionId },
    });
    if (!institution || institution.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Bulk uploads are only permitted for ACTIVE institutions.',
      );
    }

    // Verify batch belongs to institution if provided
    if (batchId) {
      const batch = await this.prisma.institutionBatch.findUnique({
        where: { id: batchId },
      });
      if (!batch || batch.institutionId !== institutionId) {
        throw new BadRequestException(
          'Specified batch does not belong to your institution.',
        );
      }
    }

    // Create BulkUpload header record
    const bulkUpload = await this.prisma.bulkUpload.create({
      data: {
        institutionId,
        batchId: batchId || null,
        fileName: file.originalname,
        fileType: file.mimetype || 'application/octet-stream',
        fileSize: file.size,
        status: 'UPLOADED',
        uploadedById: userId,
      },
    });

    // Parse and Stage Rows
    try {
      await this.prisma.bulkUpload.update({
        where: { id: bulkUpload.id },
        data: { status: 'PARSING' },
      });

      await this.parser.parseAndStage(
        bulkUpload.id,
        file.buffer,
        file.originalname,
      );

      // Perform synchronous or inline initial validation
      await this.validator.validateUpload(bulkUpload.id, batchId || undefined);

      return this.prisma.bulkUpload.findUnique({
        where: { id: bulkUpload.id },
        include: {
          batch: { select: { id: true, name: true } },
          _count: { select: { rows: true, errors: true } },
        },
      });
    } catch (error) {
      await this.prisma.bulkUpload.update({
        where: { id: bulkUpload.id },
        data: { status: 'FAILED' },
      });
      throw error;
    }
  }

  /**
   * Get preview details for a bulk upload.
   */
  async getPreview(uploadId: string): Promise<BulkUploadPreview> {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
      include: {
        errors: {
          take: 20,
          orderBy: { rowNumber: 'asc' },
        },
      },
    });

    if (!upload) {
      throw new NotFoundException(`Upload '${uploadId}' not found.`);
    }

    const sampleErrors: BulkUploadErrorItem[] = upload.errors.map((e) => ({
      rowNumber: e.rowNumber || 0,
      field: e.field,
      errorCode: e.errorCode,
      message: e.message,
    }));

    return {
      uploadId: upload.id,
      fileName: upload.fileName,
      status: upload.status,
      summary: {
        totalRows: upload.rowCount,
        validRows: upload.validRowCount,
        invalidRows: upload.invalidRowCount,
        duplicateRows: upload.duplicateRowCount,
        existingStudents: upload.existingStudentCount,
        newStudents: upload.newStudentCount,
      },
      sampleErrors,
    };
  }

  /**
   * List all errors for an upload with pagination.
   */
  async getErrors(uploadId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [errors, total] = await Promise.all([
      this.prisma.bulkUploadError.findMany({
        where: { uploadId },
        skip,
        take: limit,
        orderBy: { rowNumber: 'asc' },
      }),
      this.prisma.bulkUploadError.count({ where: { uploadId } }),
    ]);

    return {
      data: errors,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Institution Admin submits the upload for Super Admin approval.
   */
  async submitForApproval(uploadId: string, userId: string, notes?: string) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
    });

    if (!upload) {
      throw new NotFoundException(`Upload '${uploadId}' not found.`);
    }

    if (upload.status !== 'READY_FOR_REVIEW' && upload.status !== 'REJECTED') {
      throw new BadRequestException(
        `Cannot submit upload with status '${upload.status}'. Must be READY_FOR_REVIEW.`,
      );
    }

    if (upload.validRowCount === 0) {
      throw new BadRequestException('Cannot submit upload with 0 valid rows.');
    }

    // Re-validate against fresh database state before submission
    await this.validator.validateUpload(uploadId, upload.batchId || undefined);

    const refreshed = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
    });
    if (!refreshed || refreshed.validRowCount === 0) {
      throw new BadRequestException(
        'Re-validation failed. No valid rows remaining.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedUpload = await tx.bulkUpload.update({
        where: { id: uploadId },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
        },
      });

      const approvalRequest = await tx.approvalRequest.create({
        data: {
          resourceType: 'BULK_UPLOAD',
          resourceId: uploadId,
          requestedById: userId,
          status: 'PENDING',
          metadata: {
            notes,
            fileName: upload.fileName,
            validRowCount: refreshed.validRowCount,
            invalidRowCount: refreshed.invalidRowCount,
            batchId: upload.batchId,
          },
        },
      });

      return {
        upload: updatedUpload,
        approvalRequest,
      };
    });
  }

  /**
   * Super Admin reviews and approves or rejects the bulk upload.
   */
  async reviewUpload(
    uploadId: string,
    adminUserId: string,
    action: 'APPROVE' | 'REJECT',
    reason?: string,
  ) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
    });

    if (!upload) {
      throw new NotFoundException(`Upload '${uploadId}' not found.`);
    }

    if (upload.status !== 'SUBMITTED') {
      throw new BadRequestException(
        `Cannot review upload with status '${upload.status}'.`,
      );
    }

    const pendingRequest = await this.prisma.approvalRequest.findFirst({
      where: { resourceId: uploadId, status: 'PENDING' },
    });

    if (action === 'REJECT') {
      return this.prisma.$transaction(async (tx) => {
        if (pendingRequest) {
          await tx.approvalRequest.update({
            where: { id: pendingRequest.id },
            data: {
              status: 'REJECTED',
              reviewedById: adminUserId,
              reviewedAt: new Date(),
              rejectionReason: reason || 'Rejected by administrator',
            },
          });
        }

        return tx.bulkUpload.update({
          where: { id: uploadId },
          data: {
            status: 'REJECTED',
            rejectionReason: reason || 'Rejected by administrator',
          },
        });
      });
    }

    // APPROVE
    const approvedUpload = await this.prisma.$transaction(async (tx) => {
      if (pendingRequest) {
        await tx.approvalRequest.update({
          where: { id: pendingRequest.id },
          data: {
            status: 'APPROVED',
            reviewedById: adminUserId,
            reviewedAt: new Date(),
          },
        });
      }

      return tx.bulkUpload.update({
        where: { id: uploadId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedById: adminUserId,
        },
      });
    });

    // Trigger activation pipeline
    const activationResult = await this.activator.activateUpload(uploadId);

    return {
      upload: await this.prisma.bulkUpload.findUnique({
        where: { id: uploadId },
      }),
      activation: activationResult,
    };
  }

  /**
   * List all uploads for an institution.
   */
  async listUploads(institutionId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const [uploads, total] = await Promise.all([
      this.prisma.bulkUpload.findMany({
        where: { institutionId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          batch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.bulkUpload.count({ where: { institutionId } }),
    ]);

    return {
      data: uploads,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get single upload details.
   */
  async getUploadById(uploadId: string) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
      include: {
        batch: { select: { id: true, name: true } },
        _count: { select: { rows: true, errors: true } },
      },
    });

    if (!upload) {
      throw new NotFoundException(`Upload '${uploadId}' not found.`);
    }

    return upload;
  }
}
