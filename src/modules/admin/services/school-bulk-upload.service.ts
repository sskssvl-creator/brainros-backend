import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import * as ExcelJS from 'exceljs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';

const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

interface SchoolRowData {
  rowNumber: number;
  name: string;
  code: string;
  email?: string;
  phone?: string;
  state?: string;
  city?: string;
  address?: string;
}

@Injectable()
export class SchoolBulkUploadService {
  private readonly logger = new Logger(SchoolBulkUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly jobProgressService?: JobProgressService,
  ) {}

  /**
   * Validate uploaded file type, extension, and size
   */
  validateFile(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded.');
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new BadRequestException(
        `Invalid file format '${ext}'. Supported formats: CSV, XLSX, XLS.`,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File size ${(file.size / (1024 * 1024)).toFixed(1)}MB exceeds maximum limit of 10MB.`,
      );
    }
  }

  /**
   * Generates a sample CSV or Excel template for bulk school onboarding
   */
  async generateTemplate(
    format: 'csv' | 'xlsx' = 'xlsx',
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Brainros Exam Management System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Schools', {
      views: [{ showGridLines: true }],
    });

    const headers = [
      { header: 'School Name *', key: 'name', width: 32 },
      { header: 'School Code * (e.g. SCH-001 or UDISE)', key: 'code', width: 28 },
      { header: 'Email Address (Optional)', key: 'email', width: 26 },
      { header: 'Phone Number (Optional)', key: 'phone', width: 20 },
      { header: 'State (Optional)', key: 'state', width: 22 },
      { header: 'City / District (Optional)', key: 'city', width: 22 },
      { header: 'Address (Optional)', key: 'address', width: 35 },
      { header: 'Status (Optional - Default: ACTIVE)', key: 'status', width: 25 },
    ];

    sheet.columns = headers;

    // Style Header Row
    const headerRow = sheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' }, // Dark slate
      };
      cell.font = {
        name: 'Segoe UI',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Sample data rows
    const sampleRows = [
      {
        name: 'Delhi Public School R.K. Puram',
        code: 'DPS-RKP-001',
        email: 'admin@dpsrkp.edu.in',
        phone: '9876543210',
        state: 'Delhi',
        city: 'South West Delhi',
        address: 'Sector XII, R.K. Puram',
      },
      {
        name: 'St. Xavier High School',
        code: 'STX-MUM-002',
        email: 'contact@stxaviermum.ac.in',
        phone: '9811223344',
        state: 'Maharashtra',
        city: 'Mumbai',
        address: '5 Mahapalika Marg, Dhobi Talao',
      },
      {
        name: 'Kendriya Vidyalaya IIT Powai',
        code: 'KV-POW-003',
        email: 'kviitpowai@gmail.com',
        phone: '9922334455',
        state: 'Maharashtra',
        city: 'Mumbai Suburban',
        address: 'IIT Campus, Powai',
      },
    ];

    sampleRows.forEach((row) => sheet.addRow(row));

    if (format === 'csv') {
      const buf = (await workbook.csv.writeBuffer()) as unknown as Buffer;
      return {
        buffer: Buffer.from(buf),
        fileName: 'brainros_schools_template.csv',
        mimeType: 'text/csv',
      };
    } else {
      const buf = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
      return {
        buffer: Buffer.from(buf),
        fileName: 'brainros_schools_template.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
  }

  /**
   * Upload and stage/validate schools spreadsheet
   */
  async uploadAndValidate(
    file: Express.Multer.File,
    actor: { userId: string; email?: string },
  ) {
    this.validateFile(file);

    const workbook = new ExcelJS.Workbook();
    const ext = path.extname(file.originalname).toLowerCase();

    try {
      if (ext === '.csv') {
        const stream = require('stream');
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);
        await workbook.csv.read(bufferStream);
      } else {
        await workbook.xlsx.load(file.buffer as any);
      }
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to parse spreadsheet: ${err.message || 'Corrupted file'}`,
      );
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet || worksheet.rowCount < 2) {
      throw new BadRequestException(
        'The uploaded spreadsheet is empty or has no data rows.',
      );
    }

    // 1. Create BulkUpload record
    const bulkUpload = await this.prisma.bulkUpload.create({
      data: {
        uploadType: 'SCHOOLS',
        fileName: file.originalname,
        fileType: ext.replace('.', '').toUpperCase(),
        fileSize: file.size,
        status: 'VALIDATING',
        uploadedById: actor.userId,
      },
    });

    // 2. Fetch existing school codes from database
    const existingSchools = await this.prisma.institution.findMany({
      select: { code: true },
    });
    const existingCodeSet = new Set(
      existingSchools.map((s) => s.code.toUpperCase()),
    );

    // 3. Map dynamic column headers
    const colMap: Record<string, number> = {};
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      const text = String(cell.value || '')
        .toLowerCase()
        .trim()
        .replace(/[*()_/-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.includes('school name') || text === 'name') colMap['name'] = colNumber;
      else if (text.includes('school code') || text === 'code' || text.includes('udise')) colMap['code'] = colNumber;
      else if (text.includes('email')) colMap['email'] = colNumber;
      else if (text.includes('phone') || text.includes('mobile') || text.includes('contact')) colMap['phone'] = colNumber;
      else if (text.includes('state') || text.includes('province') || text.includes('region')) colMap['state'] = colNumber;
      else if (text.includes('city') || text.includes('district') || text.includes('town')) colMap['city'] = colNumber;
      else if (text.includes('address') || text.includes('location')) colMap['address'] = colNumber;
      else if (text.includes('status')) colMap['status'] = colNumber;
    });

    // 4. Parse and validate rows
    const rowsToInsert: any[] = [];
    const seenCodesInFile = new Set<string>();

    let validCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const getVal = (field: string, fallbackCol: number) => {
        const col = colMap[field] || fallbackCol;
        const val = row.getCell(col).value;
        if (val === null || val === undefined) return '';
        if (typeof val === 'object' && 'text' in val) return String((val as any).text).trim();
        if (typeof val === 'object' && 'result' in val) return String((val as any).result).trim();
        return String(val).trim();
      };

      const name = getVal('name', 1);
      const code = getVal('code', 2).toUpperCase();
      const email = getVal('email', 3);
      const phone = getVal('phone', 4);
      const state = getVal('state', 5);
      const city = getVal('city', 6);
      const address = getVal('address', 7);
      const rawStatus = getVal('status', 8);
      const status = rawStatus ? rawStatus.toUpperCase() : 'ACTIVE';

      // Skip completely blank rows
      if (!name && !code && !state && !city && !email && !phone && !address) return;

      const errors: string[] = [];

      if (!name) {
        errors.push('School Name is required.');
      }
      if (!code) {
        errors.push('School Code is required.');
      } else if (!/^[A-Z0-9_\-\.]{2,30}$/.test(code)) {
        errors.push(
          'School Code must be 2-30 characters (letters, numbers, hyphens, underscores).',
        );
      } else if (seenCodesInFile.has(code)) {
        errors.push(`Duplicate School Code '${code}' found in uploaded file.`);
      } else if (existingCodeSet.has(code)) {
        errors.push(`School Code '${code}' already exists in database.`);
      }

      // State, City, Email, Phone, Address are optional - missing state/city does NOT cause invalid error

      const isValid = errors.length === 0;
      let deduplicationStatus = 'UNIQUE';

      if (code && seenCodesInFile.has(code)) {
        deduplicationStatus = 'DUPLICATE_IN_FILE';
        duplicateCount++;
      } else if (code && existingCodeSet.has(code)) {
        deduplicationStatus = 'EXISTING_SCHOOL';
        duplicateCount++;
      }

      if (code) {
        seenCodesInFile.add(code);
      }

      if (isValid) {
        validCount++;
      } else {
        invalidCount++;
      }

      rowsToInsert.push({
        uploadId: bulkUpload.id,
        rowNumber,
        rawData: {
          name,
          code,
          email,
          phone,
          state,
          city,
          address,
          status,
        },
        normalizedData: {
          name,
          code,
          email: email || null,
          phone: phone || null,
          state: state || null,
          city: city || null,
          address: address || null,
          status: status || 'ACTIVE',
          errors,
        },
        validationStatus: isValid ? 'VALID' : 'INVALID',
        deduplicationStatus,
        errorCount: errors.length,
      });
    });

    // 4. Batch insert rows
    if (rowsToInsert.length > 0) {
      await this.prisma.bulkUploadRow.createMany({
        data: rowsToInsert,
      });
    }

    // 5. Update BulkUpload status
    const finalStatus =
      validCount > 0
        ? invalidCount === 0
          ? 'READY_FOR_REVIEW'
          : 'READY_FOR_REVIEW'
        : 'READY_FOR_REVIEW';

    const updatedUpload = await this.prisma.bulkUpload.update({
      where: { id: bulkUpload.id },
      data: {
        rowCount: rowsToInsert.length,
        validRowCount: validCount,
        invalidRowCount: invalidCount,
        duplicateRowCount: duplicateCount,
        status: finalStatus,
        processedAt: new Date(),
      },
    });

    this.logger.log(
      `Schools batch uploaded (id: ${bulkUpload.id}): ${validCount} valid, ${invalidCount} invalid of ${rowsToInsert.length} total`,
    );

    return {
      uploadId: updatedUpload.id,
      fileName: updatedUpload.fileName,
      totalRows: updatedUpload.rowCount,
      validRows: updatedUpload.validRowCount,
      invalidRows: updatedUpload.invalidRowCount,
      duplicateRows: updatedUpload.duplicateRowCount,
      status: updatedUpload.status,
    };
  }

  /**
   * Get validation preview and row details for a batch
   */
  async getUploadPreview(
    uploadId: string,
    page = 1,
    limit = 10,
    filterStatus?: 'ALL' | 'VALID' | 'INVALID',
  ) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
    });

    if (!upload) {
      throw new NotFoundException(`Upload batch '${uploadId}' not found.`);
    }

    const where: any = { uploadId };
    if (filterStatus && filterStatus !== 'ALL') {
      where.validationStatus = filterStatus;
    }

    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);

    const [rows, totalFiltered] = await Promise.all([
      this.prisma.bulkUploadRow.findMany({
        where,
        skip,
        take: Math.max(1, limit),
        orderBy: { rowNumber: 'asc' },
      }),
      this.prisma.bulkUploadRow.count({ where }),
    ]);

    return {
      upload: {
        id: upload.id,
        fileName: upload.fileName,
        status: upload.status,
        totalRows: upload.rowCount,
        validRows: upload.validRowCount,
        invalidRows: upload.invalidRowCount,
        duplicateRows: upload.duplicateRowCount,
        createdAt: upload.createdAt,
      },
      rows: rows.map((r) => ({
        id: r.id,
        rowNumber: r.rowNumber,
        data: r.normalizedData || r.rawData,
        validationStatus: r.validationStatus,
        deduplicationStatus: r.deduplicationStatus,
        errorCount: r.errorCount,
      })),
      meta: {
        page,
        limit,
        total: totalFiltered,
        totalPages: Math.ceil(totalFiltered / limit),
      },
    };
  }

  /**
   * Get paginated school bulk upload history
   */
  async getUploadHistory(page = 1, limit = 10, status?: string) {
    const skip = (Math.max(1, page) - 1) * limit;
    const where: any = { uploadType: 'SCHOOLS' };
    if (status && status !== 'ALL') {
      where.status = status;
    }

    const [uploads, total] = await Promise.all([
      this.prisma.bulkUpload.findMany({
        where,
        skip,
        take: Math.max(1, limit),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.bulkUpload.count({ where }),
    ]);

    const uploaderIds = Array.from(new Set(uploads.map((u) => u.uploadedById).filter(Boolean)));
    const users = uploaderIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: uploaderIds } },
          select: { id: true, name: true, email: true, phone: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    return {
      uploads: uploads.map((u) => ({
        id: u.id,
        fileName: u.fileName,
        fileSize: u.fileSize,
        status: u.status,
        rowCount: u.rowCount,
        validRowCount: u.validRowCount,
        invalidRowCount: u.invalidRowCount,
        duplicateRowCount: u.duplicateRowCount,
        activatedCount: u.activatedCount,
        createdAt: u.createdAt,
        activatedAt: u.activatedAt,
        uploadedBy: userMap.get(u.uploadedById) || { id: u.uploadedById, name: 'Admin', email: null, phone: null },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Confirm and register valid schools in the batch.
   * - SUPER_ADMIN / ADMIN: activates directly.
   * - OPERATOR: routes to PENDING_APPROVAL and creates an ApprovalRequest.
   */
  async confirmAndCreateSchools(
    uploadId: string,
    actor: { userId: string; email?: string; roles?: string[] },
  ) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
    });

    if (!upload) {
      throw new NotFoundException(`Upload batch '${uploadId}' not found.`);
    }

    if (upload.status === 'ACTIVATED') {
      throw new BadRequestException('This batch has already been processed and activated.');
    }

    const validRows = await this.prisma.bulkUploadRow.findMany({
      where: {
        uploadId,
        validationStatus: 'VALID',
        activationStatus: 'PENDING',
      },
      orderBy: { rowNumber: 'asc' },
    });

    if (validRows.length === 0) {
      throw new BadRequestException(
        'No pending valid rows to create in this batch.',
      );
    }

    // ─── OPERATOR: route to approval queue instead of direct activation ───
    const actorRoles: string[] = actor.roles || [];
    const isOperator =
      actorRoles.includes('OPERATOR') &&
      !actorRoles.includes('SUPER_ADMIN') &&
      !actorRoles.includes('ADMIN');

    if (isOperator) {
      // Stage the upload as PENDING_APPROVAL
      await this.prisma.bulkUpload.update({
        where: { id: uploadId },
        data: { status: 'PENDING_APPROVAL' as any },
      });

      // Create an ApprovalRequest for Super Admin
      await this.prisma.approvalRequest.create({
        data: {
          resourceType: 'BULK_UPLOAD',
          resourceId: uploadId,
          requestedById: actor.userId,
          status: 'PENDING',
          metadata: {
            uploadType: 'SCHOOL_BULK_UPLOAD',
            creatorRole: 'OPERATOR',
            fileName: upload.fileName,
            validRows: validRows.length,
          },
        },
      });

      this.logger.log(
        `Operator ${actor.userId} submitted school batch ${uploadId} for approval (${validRows.length} valid rows).`,
      );

      return {
        uploadId,
        status: 'PENDING_APPROVAL',
        validRows: validRows.length,
        message:
          'Your school upload has been submitted for Super Admin approval. Schools will be created once approved.',
      };
    }

    // ─── SUPER_ADMIN / ADMIN: activate directly (existing flow) ──────────
    const queue = 'schools-bulk-upload';
    const jobId = uploadId;

    if (this.jobProgressService) {
      await this.jobProgressService.publishStarted(queue, jobId, {
        type: 'SCHOOL_BULK_CREATION',
        userId: actor.userId,
        totalRecords: validRows.length,
        message: `Starting onboarding of ${validRows.length} schools...`,
      });
    }

    let createdCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      const data = (row.normalizedData || row.rawData) as any;
      try {
        const validStatuses = ['ACTIVE', 'INACTIVE', 'DRAFT', 'SUSPENDED'];
        const schoolStatus = validStatuses.includes(data.status) ? data.status : 'ACTIVE';
        let rawPhone = (data.phone || data.phoneNumber || '').toString().trim();
        if (rawPhone && !rawPhone.startsWith('+')) {
          const digits = rawPhone.replace(/\D/g, '');
          if (digits.length === 10) {
            rawPhone = `+91${digits}`;
          } else if (digits.length === 12 && digits.startsWith('91')) {
            rawPhone = `+${digits}`;
          }
        }

        const school = await this.prisma.institution.create({
          data: {
            name: data.name,
            code: data.code,
            type: 'SCHOOL',
            status: schoolStatus,
            email: data.email?.trim().toLowerCase() || null,
            phone: rawPhone || null,
            state: data.state || null,
            city: data.city || null,
            address: data.address || null,
            country: 'India',
            createdById: actor.userId,
          },
        });

        // If phone is provided, create/link User account with INSTITUTION_ADMIN role for login
        if (rawPhone) {
          const tenDigit = rawPhone.replace(/^\+91/, '');
          let schoolUser = await this.prisma.user.findFirst({
            where: {
              OR: [
                { phone: rawPhone },
                { mobileNumber: rawPhone },
                { phone: tenDigit },
                { mobileNumber: tenDigit },
                ...(data.email ? [{ email: data.email.trim().toLowerCase() }] : []),
              ],
            },
          });

          if (!schoolUser) {
            const tempPassword = await bcrypt.hash(`brainros_${rawPhone.slice(-6)}`, 10);
            schoolUser = await this.prisma.user.create({
              data: {
                phone: rawPhone,
                mobileNumber: rawPhone,
                email: data.email?.trim().toLowerCase() || null,
                name: `${data.name} Admin`,
                passwordHash: tempPassword,
                status: 'ACTIVE',
                isActive: true,
                isVerified: true,
              },
            });
          } else {
            schoolUser = await this.prisma.user.update({
              where: { id: schoolUser.id },
              data: {
                status: 'ACTIVE',
                isActive: true,
                isVerified: true,
              },
            });
          }

          const instRole = await this.prisma.role.findFirst({
            where: { name: 'INSTITUTION_ADMIN' },
          });

          if (instRole && schoolUser) {
            await this.prisma.userRole.upsert({
              where: {
                userId_roleId: {
                  userId: schoolUser.id,
                  roleId: instRole.id,
                },
              },
              update: {},
              create: {
                userId: schoolUser.id,
                roleId: instRole.id,
              },
            });
          }

          if (schoolUser) {
            const existingAdmin = await this.prisma.institutionAdmin.findFirst({
              where: {
                institutionId: school.id,
                userId: schoolUser.id,
              },
            });

            if (!existingAdmin) {
              await this.prisma.institutionAdmin.create({
                data: {
                  institutionId: school.id,
                  userId: schoolUser.id,
                  role: 'ADMIN',
                  isActive: true,
                },
              });
            } else if (!existingAdmin.isActive) {
              await this.prisma.institutionAdmin.update({
                where: { id: existingAdmin.id },
                data: { isActive: true },
              });
            }
          }
        }

        await this.prisma.bulkUploadRow.update({
          where: { id: row.id },
          data: { activationStatus: 'ACTIVATED' },
        });

        createdCount++;
      } catch (err: any) {
        errors.push(`Row ${row.rowNumber} (${data.name}): ${err.message}`);
        await this.prisma.bulkUploadRow.update({
          where: { id: row.id },
          data: { activationStatus: 'FAILED' },
        });
      }

      if (this.jobProgressService) {
        await this.jobProgressService.publishProgress(queue, jobId, {
          current: i + 1,
          total: validRows.length,
          stage: 'CREATING_SCHOOLS',
          message: `Onboarded ${i + 1} of ${validRows.length} schools... (${data.name})`,
          userId: actor.userId,
        });
      }
    }

    await this.prisma.bulkUpload.update({
      where: { id: uploadId },
      data: {
        status: 'ACTIVATED',
        activatedCount: createdCount,
        activatedAt: new Date(),
        approvedById: actor.userId,
        approvedAt: new Date(),
      },
    });

    if (this.jobProgressService) {
      await this.jobProgressService.publishCompleted(queue, jobId, {
        message: `Successfully onboarded ${createdCount} schools (${errors.length} failed).`,
        userId: actor.userId,
        totalProcessed: validRows.length,
        resultSummary: {
          total: validRows.length,
          createdCount,
          failedCount: errors.length,
        },
      });
    }

    this.logger.log(
      `Schools batch ${uploadId} activated: ${createdCount} created, ${errors.length} failed`,
    );

    return {
      uploadId,
      createdCount,
      failedCount: errors.length,
      errors: errors.slice(0, 10),
      status: 'ACTIVATED',
    };
  }
}
