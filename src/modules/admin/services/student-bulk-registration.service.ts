import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { OtpService } from '../../auth/services/otp.service';
import { UpdateBulkStudentRowDto } from '../dto/student-bulk-upload.dto';
import * as ExcelJS from 'exceljs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';

import { Optional } from '@nestjs/common';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import {
  CANONICAL_TARGET_EXAMS,
  resolveEligibleExamTypes,
  normalizeTargetExamInput,
  mapExamBooleansToCanonical,
  mapCanonicalToExamBooleans,
  parseBooleanFlag,
} from '../../../common/constants/target-exam.constant';

const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROW_COUNT = 10000;

const MOBILE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class StudentBulkRegistrationService {
  private readonly logger = new Logger(StudentBulkRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEventService: SecurityEventService,
    private readonly otpService: OtpService,
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
   * Generates a sample CSV or Excel template for bulk student registration
   */
  async generateTemplate(format: 'csv' | 'xlsx' = 'xlsx'): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Brainros Exam Management System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Students', {
      views: [{ showGridLines: true }],
    });

    const headers = [
      { header: 'Full Name *', key: 'name', width: 25 },
      { header: 'Mobile Number * (10 Digits)', key: 'mobile', width: 22 },
      { header: 'Email Address (Optional)', key: 'email', width: 28 },
      { header: 'Password * (Min 6 Characters)', key: 'password', width: 26 },
      { header: 'State *', key: 'state', width: 20 },
      { header: 'City / District *', key: 'city', width: 22 },
      { header: 'Class / Grade * (e.g. 11th, 12th, Dropper)', key: 'class', width: 25 },
      { header: 'JEE * (TRUE / FALSE)', key: 'jee', width: 20 },
      { header: 'CET * (TRUE / FALSE)', key: 'cet', width: 20 },
      { header: 'NEET * (TRUE / FALSE)', key: 'neet', width: 20 },
      { header: 'Preferred Language * (e.g. ENGLISH, HINDI, GUJARATI)', key: 'preferredLanguage', width: 26 },
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

    // Sample data rows showcasing combinations with separate Boolean flags
    const sampleRows = [
      {
        name: 'Rahul Sharma',
        mobile: '9876543210',
        email: 'rahul.sharma@example.com',
        password: 'StudentPassword1!',
        state: 'Gujarat',
        city: 'Ahmedabad',
        class: '12th',
        jee: 'FALSE',
        cet: 'TRUE',
        neet: 'TRUE',
        preferredLanguage: 'ENGLISH',
      },
      {
        name: 'Priya Patel',
        mobile: '9876543211',
        email: 'priya.patel@example.com',
        password: 'StudentPassword2!',
        state: 'Gujarat',
        city: 'Surat',
        class: '11th',
        jee: 'TRUE',
        cet: 'TRUE',
        neet: 'FALSE',
        preferredLanguage: 'GUJARATI',
      },
      {
        name: 'Amit Verma',
        mobile: '9876543212',
        email: 'amit.verma@example.com',
        password: 'StudentPassword3!',
        state: 'Maharashtra',
        city: 'Mumbai',
        class: '12th',
        jee: 'TRUE',
        cet: 'FALSE',
        neet: 'TRUE',
        preferredLanguage: 'HINDI',
      },
      {
        name: 'Raj Shah',
        mobile: '9876543213',
        email: 'raj.shah@example.com',
        password: 'StudentPassword4!',
        state: 'Gujarat',
        city: 'Vadodara',
        class: '12th',
        jee: 'TRUE',
        cet: 'FALSE',
        neet: 'FALSE',
        preferredLanguage: 'ENGLISH',
      },
      {
        name: 'Sneha Kulkarni',
        mobile: '9876543214',
        email: 'sneha.k@example.com',
        password: 'StudentPassword5!',
        state: 'Maharashtra',
        city: 'Pune',
        class: 'Dropper',
        jee: 'FALSE',
        cet: 'FALSE',
        neet: 'TRUE',
        preferredLanguage: 'MARATHI',
      },
      {
        name: 'Tanmay Joshi',
        mobile: '9876543215',
        email: 'tanmay.j@example.com',
        password: 'StudentPassword6!',
        state: 'Maharashtra',
        city: 'Nagpur',
        class: '12th',
        jee: 'TRUE',
        cet: 'TRUE',
        neet: 'TRUE',
        preferredLanguage: 'ENGLISH',
      },
      {
        name: 'Ananya Deshmukh',
        mobile: '9876543216',
        email: 'ananya.d@example.com',
        password: 'StudentPassword7!',
        state: 'Karnataka',
        city: 'Bengaluru',
        class: '11th',
        jee: 'FALSE',
        cet: 'TRUE',
        neet: 'FALSE',
        preferredLanguage: 'ENGLISH',
      },
    ];

    sampleRows.forEach((row) => sheet.addRow(row));

    // Style data rows
    for (let r = 2; r <= sampleRows.length + 1; r++) {
      const row = sheet.getRow(r);
      row.height = 22;
      row.eachCell((cell) => {
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      });
    }

    if (format === 'csv') {
      const buffer = (await workbook.csv.writeBuffer()) as unknown as Buffer;
      return {
        buffer: Buffer.from(buffer),
        fileName: 'student_bulk_registration_template.csv',
        mimeType: 'text/csv',
      };
    } else {
      const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
      return {
        buffer: Buffer.from(buffer),
        fileName: 'student_bulk_registration_template.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
  }

  /**
   * Parses raw file buffer into structured rows
   */
  private async parseSpreadsheet(
    fileBuffer: Buffer,
    fileName: string,
  ): Promise<Record<string, string>[]> {
    const ext = path.extname(fileName).toLowerCase();
    const rows: Record<string, string>[] = [];

    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer as any);
      const sheet = workbook.worksheets[0];

      if (!sheet || sheet.rowCount < 2) {
        throw new BadRequestException('Uploaded spreadsheet contains no data rows.');
      }

      // Read header mapping
      const headerMap = new Map<number, string>();
      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell, colNumber) => {
        const val = String(cell.value || '').trim().toLowerCase();
        if (val.includes('name') && !val.includes('state') && !val.includes('school')) headerMap.set(colNumber, 'name');
        else if (val.includes('mobile') || val.includes('phone')) headerMap.set(colNumber, 'mobile');
        else if (val.includes('email')) headerMap.set(colNumber, 'email');
        else if (val.includes('pass')) headerMap.set(colNumber, 'password');
        else if (val.includes('jee')) headerMap.set(colNumber, 'jee');
        else if (val.includes('cet')) headerMap.set(colNumber, 'cet');
        else if (val.includes('neet')) headerMap.set(colNumber, 'neet');
        else if (val.includes('target') || val.includes('exam')) headerMap.set(colNumber, 'examTarget');
        else if (val.includes('state')) headerMap.set(colNumber, 'state');
        else if (val.includes('city') || val.includes('district')) headerMap.set(colNumber, 'city');
        else if (val.includes('class') || val.includes('grade')) headerMap.set(colNumber, 'class');
        else if (val.includes('lang')) headerMap.set(colNumber, 'preferredLanguage');
        // Legacy school_name/school/college columns in file are ignored - UI selected school is source of truth
      });

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header

        const record: Record<string, string> = {};
        let hasValues = false;

        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const key = headerMap.get(colNumber);
          if (key) {
            let strVal = '';
            if (typeof cell.value === 'object' && cell.value !== null) {
              strVal = String((cell.value as any).text || (cell.value as any).result || '');
            } else {
              strVal = String(cell.value ?? '').trim();
            }
            if (strVal) {
              hasValues = true;
              record[key] = strVal;
            }
          }
        });

        if (hasValues) {
          rows.push(record);
        }
      });
    } else {
      // CSV parsing
      const text = fileBuffer.toString('utf-8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        throw new BadRequestException('Uploaded CSV contains no data rows.');
      }

      const parseCsvLine = (line: string): string[] => {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result.map((s) => s.replace(/^"|"$/g, '').trim());
      };

      const headerCols = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
      const headerMap = new Map<number, string>();
      headerCols.forEach((val, idx) => {
        if (val.includes('name') && !val.includes('state') && !val.includes('school')) headerMap.set(idx, 'name');
        else if (val.includes('mobile') || val.includes('phone')) headerMap.set(idx, 'mobile');
        else if (val.includes('email')) headerMap.set(idx, 'email');
        else if (val.includes('pass')) headerMap.set(idx, 'password');
        else if (val.includes('jee')) headerMap.set(idx, 'jee');
        else if (val.includes('cet')) headerMap.set(idx, 'cet');
        else if (val.includes('neet')) headerMap.set(idx, 'neet');
        else if (val.includes('target') || val.includes('exam')) headerMap.set(idx, 'examTarget');
        else if (val.includes('state')) headerMap.set(idx, 'state');
        else if (val.includes('city') || val.includes('district')) headerMap.set(idx, 'city');
        else if (val.includes('class') || val.includes('grade')) headerMap.set(idx, 'class');
        else if (val.includes('lang')) headerMap.set(idx, 'preferredLanguage');
        // Legacy school_name/school/college columns in file are ignored - UI selected school is source of truth
      });

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const record: Record<string, string> = {};
        let hasValues = false;
        cols.forEach((val, colIdx) => {
          const key = headerMap.get(colIdx);
          if (key && val) {
            hasValues = true;
            record[key] = val;
          }
        });
        if (hasValues) {
          rows.push(record);
        }
      }
    }

    return rows;
  }

  /**
   * Upload, stage, and validate spreadsheet rows for Super Admin
   */
  async uploadAndValidate(
    file: Express.Multer.File,
    actor: { userId: string; email?: string; roles?: string[] },
    options?: { schoolId?: string; institutionId?: string },
  ) {
    this.validateFile(file);

    const targetSchoolId = options?.schoolId || options?.institutionId;
    if (!targetSchoolId) {
      throw new BadRequestException('Please select a school before uploading students.');
    }

    // Verify target school exists in DB
    const selectedSchool = await this.prisma.institution.findUnique({
      where: { id: targetSchoolId },
      select: { id: true, name: true, code: true, status: true },
    });

    if (!selectedSchool) {
      throw new BadRequestException('Selected school does not exist.');
    }

    if (selectedSchool.status !== 'ACTIVE') {
      throw new BadRequestException('Selected school is inactive and cannot accept student registrations.');
    }

    // Verify RBAC authorization if actor roles provided
    if (actor?.userId && actor.roles && actor.roles.length > 0) {
      const isSuperAdmin = actor.roles.includes('SUPER_ADMIN') || actor.roles.includes('SUPERADMIN');
      if (!isSuperAdmin) {
        const hasAccess = await this.prisma.institutionAdmin.findFirst({
          where: { userId: actor.userId, institutionId: selectedSchool.id, isActive: true },
        });
        if (!hasAccess) {
          throw new BadRequestException('You are not authorized to upload students for this school.');
        }
      }
    }

    const rows = await this.parseSpreadsheet(file.buffer, file.originalname);
    if (rows.length === 0) {
      throw new BadRequestException('File contains no readable student rows.');
    }
    if (rows.length > MAX_ROW_COUNT) {
      throw new BadRequestException(
        `File contains ${rows.length} rows, which exceeds the maximum limit of ${MAX_ROW_COUNT} rows per upload.`,
      );
    }

    const ext = path.extname(file.originalname).toLowerCase().replace('.', '').toUpperCase();

    // 1. Create BulkUpload staging record with selected school ID
    const bulkUpload = await this.prisma.bulkUpload.create({
      data: {
        uploadType: 'SUPER_ADMIN_STUDENTS',
        fileName: file.originalname,
        fileType: ext,
        fileSize: file.size,
        rowCount: rows.length,
        status: 'VALIDATING',
        uploadedById: actor.userId,
        institutionId: selectedSchool.id,
      },
    });

    // 2. Load Master Data for O(1) in-memory resolution & validation
    const [states, districts, classes, examTargets, languages, institutions] = await Promise.all([
      this.prisma.state.findMany({ where: { isActive: true } }),
      this.prisma.district.findMany({ where: { isActive: true } }),
      this.prisma.studentClass.findMany(),
      this.prisma.examTarget.findMany(),
      this.prisma.preferredLanguage.findMany({ where: { isActive: true } }),
      this.prisma.institution.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, code: true, stateId: true, districtId: true },
      }),
    ]);

    // Lookup Maps
    const stateMap = new Map<string, typeof states[0]>();
    states.forEach((s) => {
      stateMap.set(s.name.toLowerCase().trim(), s);
      stateMap.set(s.code.toLowerCase().trim(), s);
    });

    const districtMap = new Map<string, typeof districts[0]>();
    districts.forEach((d) => {
      districtMap.set(`${d.name.toLowerCase().trim()}_${d.stateId}`, d);
      districtMap.set(d.name.toLowerCase().trim(), d); // fallback
    });

    const classMap = new Map<string, typeof classes[0]>();
    classes.forEach((c) => {
      classMap.set(c.name.toLowerCase().trim(), c);
      classMap.set(c.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(), c);
    });

    const examTargetMap = new Map<string, typeof examTargets[0]>();
    examTargets.forEach((et) => {
      examTargetMap.set(et.name.toLowerCase().trim(), et);
      examTargetMap.set(et.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(), et);
    });

    const languageMap = new Map<string, typeof languages[0]>();
    languages.forEach((l) => {
      languageMap.set(l.name.toLowerCase().trim(), l);
      if (l.code) languageMap.set(l.code.toLowerCase().trim(), l);
    });

    // 3. Batch query DB for existing users with any of the mobiles or emails
    const fileMobiles: string[] = [];
    const fileEmails: string[] = [];
    rows.forEach((r) => {
      if (r.mobile) {
        const cleanMob = r.mobile.replace(/\D/g, '');
        const norm = cleanMob.length === 10 ? `+91${cleanMob}` : cleanMob.startsWith('91') ? `+${cleanMob}` : cleanMob;
        fileMobiles.push(norm);
        if (cleanMob.length === 10) fileMobiles.push(cleanMob);
      }
      if (r.email) {
        fileEmails.push(r.email.toLowerCase().trim());
      }
    });

    const existingUsers = await this.prisma.user.findMany({
      where: {
        OR: [
          { mobileNumber: { in: fileMobiles } },
          { phone: { in: fileMobiles } },
          ...(fileEmails.length > 0 ? [{ email: { in: fileEmails } }] : []),
        ],
      },
      select: { id: true, mobileNumber: true, phone: true, email: true },
    });

    const existingMobileSet = new Set<string>();
    const existingEmailSet = new Set<string>();
    existingUsers.forEach((u) => {
      if (u.mobileNumber) existingMobileSet.add(u.mobileNumber.replace(/\D/g, ''));
      if (u.phone) existingMobileSet.add(u.phone.replace(/\D/g, ''));
      if (u.email) existingEmailSet.add(u.email.toLowerCase().trim());
    });

    // 4. Validate each row & track in-file duplicates
    const mobilesSeen = new Map<string, number>();
    const emailsSeen = new Map<string, number>();

    let validCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;

    const stagedRowsData: any[] = [];
    const allErrorsData: any[] = [];

    rows.forEach((raw, idx) => {
      const rowNumber = idx + 1;
      const rowErrors: { field: string; errorCode: string; message: string }[] = [];

      const name = (raw.name || '').trim();
      const rawMobile = (raw.mobile || '').replace(/\D/g, '');
      const email = raw.email ? raw.email.toLowerCase().trim() : null;
      const stateName = (raw.state || '').trim();
      const cityName = (raw.city || '').trim();
      const className = (raw.class || '').trim();
      const examTargetName = (raw.examTarget || '').trim();
      const languageName = (raw.preferredLanguage || '').trim();
      const schoolCollege = (raw.schoolCollege || '').trim();

      // Field Validations
      if (!name || name.length < 2) {
        rowErrors.push({
          field: 'name',
          errorCode: 'INVALID_NAME',
          message: 'Student name is required (minimum 2 characters).',
        });
      }

      if (!rawMobile) {
        rowErrors.push({
          field: 'mobile',
          errorCode: 'MISSING_MOBILE',
          message: 'Mobile number is required.',
        });
      } else {
        const standardMobile = rawMobile.length === 10 ? rawMobile : rawMobile.startsWith('91') && rawMobile.length === 12 ? rawMobile.substring(2) : rawMobile;
        if (!MOBILE_REGEX.test(standardMobile)) {
          rowErrors.push({
            field: 'mobile',
            errorCode: 'INVALID_MOBILE_FORMAT',
            message: `Invalid mobile number '${raw.mobile}'. Must be a valid 10-digit Indian number starting with 6-9.`,
          });
        }
      }

      if (email && !EMAIL_REGEX.test(email)) {
        rowErrors.push({
          field: 'email',
          errorCode: 'INVALID_EMAIL_FORMAT',
          message: `Invalid email address format '${email}'.`,
        });
      }

      // Master Data Validations with Intelligent Spelling & Alias Resolution
      let resolvedStateId: string | null = null;
      let resolvedDistrictId: string | null = null;
      let resolvedStateName = stateName;
      let resolvedCityName = cityName;

      // State & City
      if (!stateName) {
        rowErrors.push({
          field: 'state',
          errorCode: 'MISSING_STATE',
          message: 'State is required.',
        });
      } else {
        const stateRes = this.resolveStateAndCity(
          stateName,
          cityName,
          stateMap,
          states,
          districtMap,
          districts,
        );
        if (stateRes.stateRecord) {
          resolvedStateId = stateRes.stateRecord.id;
          resolvedStateName = stateRes.stateRecord.name;
        }
        if (stateRes.districtRecord) {
          resolvedDistrictId = stateRes.districtRecord.id;
          resolvedCityName = stateRes.districtRecord.name;
        }
      }

      if (!cityName) {
        rowErrors.push({
          field: 'city',
          errorCode: 'MISSING_CITY',
          message: 'City / District is required.',
        });
      }

      // Class (supports 11th, 12th, Class 11, Class 12, XI, XII, Dropper, Foundation, etc.)
      let resolvedClassId: string | null = null;
      let resolvedClassName = className;

      if (!className) {
        rowErrors.push({
          field: 'class',
          errorCode: 'MISSING_CLASS',
          message: 'Class / Grade is required (e.g. 11th, 12th, Dropper).',
        });
      } else {
        const classRecord = this.resolveAcademicClass(className, classMap, classes);
        if (!classRecord) {
          rowErrors.push({
            field: 'class',
            errorCode: 'UNKNOWN_CLASS',
            message: `Class '${className}' is not a valid academic class. Supported: 11th, 12th, Dropper, Foundation.`,
          });
        } else {
          resolvedClassId = classRecord.id;
          resolvedClassName = classRecord.name === 'CLASS_11' ? '11th' : classRecord.name === 'CLASS_12' ? '12th' : classRecord.name;
        }
      }

      // Password Validation
      const rawPassword = (raw.password || '').trim();
      if (!rawPassword) {
        rowErrors.push({
          field: 'password',
          errorCode: 'MISSING_PASSWORD',
          message: 'Password is required (minimum 6 characters).',
        });
      } else if (rawPassword.length < 6) {
        rowErrors.push({
          field: 'password',
          errorCode: 'PASSWORD_TOO_SHORT',
          message: 'Password must be at least 6 characters long.',
        });
      }

      let passwordHash: string | null = null;
      if (rawPassword && rawPassword.length >= 6) {
        passwordHash = bcrypt.hashSync(rawPassword, 10);
      }

      // Exam Target Validation (supports separate Boolean columns: jee, cet, neet or legacy combo string)
      let resolvedExamTargetId: string | null = null;
      const resolvedExamTargetIds: string[] = [];
      const validTargetNames: string[] = [];
      let hasJee = false;
      let hasCet = false;
      let hasNeet = false;

      if (raw.jee !== undefined || raw.cet !== undefined || raw.neet !== undefined) {
        hasJee = parseBooleanFlag(raw.jee);
        hasCet = parseBooleanFlag(raw.cet);
        hasNeet = parseBooleanFlag(raw.neet);

        if (!hasJee && !hasCet && !hasNeet) {
          rowErrors.push({
            field: 'examTarget',
            errorCode: 'MISSING_EXAM_ELIGIBILITY',
            message: 'At least one target exam (JEE, CET, or NEET) must be TRUE.',
          });
        } else {
          const canonicalTargetName = mapExamBooleansToCanonical(hasJee, hasCet, hasNeet);
          if (canonicalTargetName) {
            const resolved = this.resolveCanonicalExamTarget(canonicalTargetName, examTargets);
            if (resolved) {
              resolvedExamTargetId = resolved.targetRecord.id;
              resolvedExamTargetIds.push(...resolved.resolvedTargetIds);
              validTargetNames.push(resolved.canonicalName);
            } else {
              rowErrors.push({
                field: 'examTarget',
                errorCode: 'INVALID_EXAM_TARGET',
                message: `Target combination (JEE=${hasJee}, CET=${hasCet}, NEET=${hasNeet}) could not be resolved.`,
              });
            }
          }
        }
      } else if (!examTargetName) {
        rowErrors.push({
          field: 'examTarget',
          errorCode: 'MISSING_EXAM_TARGET',
          message:
            'Exam Target is required (Valid options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET).',
        });
      } else {
        const resolved = this.resolveCanonicalExamTarget(examTargetName, examTargets);
        if (!resolved) {
          rowErrors.push({
            field: 'examTarget',
            errorCode: 'INVALID_EXAM_TARGET',
            message: `Exam target '${examTargetName}' is invalid. Valid options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET.`,
          });
        } else {
          resolvedExamTargetId = resolved.targetRecord.id;
          resolvedExamTargetIds.push(...resolved.resolvedTargetIds);
          validTargetNames.push(resolved.canonicalName);
          const booleans = mapCanonicalToExamBooleans(resolved.canonicalName);
          hasJee = booleans.jee;
          hasCet = booleans.cet;
          hasNeet = booleans.neet;
        }
      }

      // Preferred Language (supports English, Hindi, Gujarati, Marathi, Tamil, etc.)
      let resolvedLanguageId: string | null = null;
      let resolvedLanguageName = languageName;

      if (!languageName) {
        rowErrors.push({
          field: 'preferredLanguage',
          errorCode: 'MISSING_LANGUAGE',
          message: 'Preferred Language is required (e.g. ENGLISH, HINDI, GUJARATI).',
        });
      } else {
        const langRecord = this.resolvePreferredLanguage(languageName, languageMap, languages);
        if (!langRecord) {
          rowErrors.push({
            field: 'preferredLanguage',
            errorCode: 'UNKNOWN_LANGUAGE',
            message: `Language '${languageName}' is not supported. Supported: ${languages.map((l) => l.name).join(', ')}.`,
          });
        } else {
          resolvedLanguageId = langRecord.id;
          resolvedLanguageName = langRecord.name;
        }
      }

      // School / College / Institution Resolution from selectedSchool (Source of Truth)
      const resolvedInstitutionId = selectedSchool.id;
      const resolvedInstitutionName = selectedSchool.name;

      // Deduplication checks
      let dedupStatus = 'UNIQUE';
      const standardMobile = rawMobile.length === 10 ? rawMobile : rawMobile.startsWith('91') && rawMobile.length === 12 ? rawMobile.substring(2) : rawMobile;

      if (standardMobile) {
        // In-file duplicate check
        if (mobilesSeen.has(standardMobile)) {
          dedupStatus = 'DUPLICATE_IN_FILE';
          rowErrors.push({
            field: 'mobile',
            errorCode: 'DUPLICATE_MOBILE_IN_FILE',
            message: `Mobile number '${standardMobile}' already appears on row ${mobilesSeen.get(standardMobile)}.`,
          });
        } else {
          mobilesSeen.set(standardMobile, rowNumber);
        }

        // Database duplicate check
        if (existingMobileSet.has(standardMobile)) {
          dedupStatus = 'EXISTING_STUDENT';
          rowErrors.push({
            field: 'mobile',
            errorCode: 'MOBILE_ALREADY_REGISTERED',
            message: `A user with mobile number '${standardMobile}' is already registered in the system.`,
          });
        }
      }

      if (email) {
        if (emailsSeen.has(email)) {
          dedupStatus = 'DUPLICATE_IN_FILE';
          rowErrors.push({
            field: 'email',
            errorCode: 'DUPLICATE_EMAIL_IN_FILE',
            message: `Email '${email}' already appears on row ${emailsSeen.get(email)}.`,
          });
        } else {
          emailsSeen.set(email, rowNumber);
        }

        if (existingEmailSet.has(email)) {
          dedupStatus = 'EXISTING_STUDENT';
          rowErrors.push({
            field: 'email',
            errorCode: 'EMAIL_ALREADY_REGISTERED',
            message: `A user with email '${email}' is already registered in the system.`,
          });
        }
      }

      const isValid = rowErrors.length === 0;
      if (isValid) {
        validCount++;
      } else {
        invalidCount++;
        if (dedupStatus !== 'UNIQUE') {
          duplicateCount++;
        }
      }

      const normalizedMobile = standardMobile.length === 10 ? `+91${standardMobile}` : standardMobile;

      const normalizedData = {
        name,
        mobile: normalizedMobile,
        rawMobile: standardMobile,
        email,
        passwordHash,
        jee: hasJee,
        cet: hasCet,
        neet: hasNeet,
        state: stateName,
        city: cityName,
        stateId: resolvedStateId,
        districtId: resolvedDistrictId,
        class: className,
        classId: resolvedClassId,
        examTarget: validTargetNames.length > 0 ? validTargetNames.join(', ') : examTargetName,
        examTargetId: resolvedExamTargetId,
        examTargetIds: resolvedExamTargetIds,
        preferredLanguage: languageName,
        preferredLanguageId: resolvedLanguageId,
        schoolCollege: selectedSchool.name,
        institutionId: selectedSchool.id,
        institutionName: selectedSchool.name,
      };

      const sanitizedRaw = { ...raw };
      delete sanitizedRaw.password;

      stagedRowsData.push({
        uploadId: bulkUpload.id,
        rowNumber,
        rawData: sanitizedRaw,
        normalizedData,
        validationStatus: isValid ? 'VALID' : 'INVALID',
        deduplicationStatus: dedupStatus,
        errorCount: rowErrors.length,
        activationStatus: 'PENDING',
        errors: rowErrors,
      });
    });

    // 5. Save staged rows and errors in DB
    for (const stagedRow of stagedRowsData) {
      const createdRow = await this.prisma.bulkUploadRow.create({
        data: {
          uploadId: stagedRow.uploadId,
          rowNumber: stagedRow.rowNumber,
          rawData: stagedRow.rawData,
          normalizedData: stagedRow.normalizedData,
          validationStatus: stagedRow.validationStatus,
          deduplicationStatus: stagedRow.deduplicationStatus,
          errorCount: stagedRow.errorCount,
          activationStatus: stagedRow.activationStatus,
        },
      });

      if (stagedRow.errors && stagedRow.errors.length > 0) {
        for (const err of stagedRow.errors) {
          allErrorsData.push({
            uploadId: bulkUpload.id,
            rowId: createdRow.id,
            rowNumber: stagedRow.rowNumber,
            field: err.field,
            errorCode: err.errorCode,
            message: err.message,
          });
        }
      }
    }

    if (allErrorsData.length > 0) {
      await this.prisma.bulkUploadError.createMany({
        data: allErrorsData,
      });
    }

    // 6. Update BulkUpload summary record
    const updatedUpload = await this.prisma.bulkUpload.update({
      where: { id: bulkUpload.id },
      data: {
        validRowCount: validCount,
        invalidRowCount: invalidCount,
        duplicateRowCount: duplicateCount,
        status: validCount > 0 ? 'READY_FOR_REVIEW' : 'FAILED',
        processedAt: new Date(),
      },
      include: {
        _count: {
          select: { rows: true, errors: true },
        },
      },
    });

    await this.securityEventService.log('STUDENT_BULK_UPLOAD_VALIDATED' as any, {
      userId: actor.userId,
      metadata: {
        uploadId: bulkUpload.id,
        total: rows.length,
        valid: validCount,
        invalid: invalidCount,
        duplicates: duplicateCount,
      },
    });

    return {
      uploadId: updatedUpload.id,
      fileName: updatedUpload.fileName,
      totalRows: rows.length,
      validRows: validCount,
      invalidRows: invalidCount,
      duplicateRows: duplicateCount,
      status: updatedUpload.status,
      message:
        validCount > 0
          ? `Validation complete: ${validCount} valid rows ready for registration, ${invalidCount} invalid rows.`
          : `Validation failed: All ${invalidCount} rows contain errors.`,
    };
  }

  /**
   * Retrieves preview of an uploaded batch with paginated rows and row-level errors
   */
  async getUploadPreview(
    uploadId: string,
    page = 1,
    limit = 10,
    filterStatus?: 'ALL' | 'VALID' | 'INVALID',
  ) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
      include: {
        institution: {
          select: { id: true, name: true, code: true },
        },
        errors: {
          take: 50,
          orderBy: { rowNumber: 'asc' },
        },
      },
    });

    if (!upload) {
      throw new NotFoundException(`Bulk upload session '${uploadId}' not found.`);
    }

    const whereClause: any = { uploadId };
    if (filterStatus === 'VALID') whereClause.validationStatus = 'VALID';
    if (filterStatus === 'INVALID') whereClause.validationStatus = 'INVALID';

    const [rows, totalFilteredRows] = await Promise.all([
      this.prisma.bulkUploadRow.findMany({
        where: whereClause,
        orderBy: { rowNumber: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          errors: true,
        },
      }),
      this.prisma.bulkUploadRow.count({ where: whereClause }),
    ]);

    return {
      upload: {
        id: upload.id,
        fileName: upload.fileName,
        fileType: upload.fileType,
        rowCount: upload.rowCount,
        validRowCount: upload.validRowCount,
        invalidRowCount: upload.invalidRowCount,
        duplicateRowCount: upload.duplicateRowCount,
        activatedCount: upload.activatedCount,
        failedCount: upload.failedCount,
        status: upload.status,
        createdAt: upload.createdAt,
        processedAt: upload.processedAt,
        activatedAt: upload.activatedAt,
        institutionId: upload.institutionId,
        institutionName: upload.institution?.name,
      },
      selectedSchool: upload.institution
        ? { id: upload.institution.id, name: upload.institution.name, code: upload.institution.code }
        : null,
      pagination: {
        page,
        limit,
        total: totalFilteredRows,
        totalPages: Math.ceil(totalFilteredRows / limit),
      },
      rows: rows.map((r) => {
        const rowData = { ...((r.normalizedData as any) || (r.rawData as any) || {}) };
        delete rowData.password;
        delete rowData.passwordHash;
        return {
          id: r.id,
          rowNumber: r.rowNumber,
          data: rowData,
          validationStatus: r.validationStatus,
          deduplicationStatus: r.deduplicationStatus,
          activationStatus: r.activationStatus,
          activationError: r.activationError,
          matchedStudentId: r.matchedStudentId,
          errors: r.errors.map((e) => ({
            field: e.field,
            errorCode: e.errorCode,
            message: e.message,
          })),
        };
      }),
    };
  }

  /**
   * Retrieves list of Super Admin bulk student uploads history
   */
  async getUploadHistory(page = 1, limit = 10, status?: string) {
    const where: any = { uploadType: 'SUPER_ADMIN_STUDENTS' };
    if (status && status !== 'ALL') {
      where.status = status;
    }

    const [uploads, total] = await Promise.all([
      this.prisma.bulkUpload.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.bulkUpload.count({ where }),
    ]);

    return {
      uploads: uploads.map((u) => ({
        id: u.id,
        fileName: u.fileName,
        fileType: u.fileType,
        fileSize: u.fileSize,
        rowCount: u.rowCount,
        validRowCount: u.validRowCount,
        invalidRowCount: u.invalidRowCount,
        duplicateRowCount: u.duplicateRowCount,
        activatedCount: u.activatedCount,
        failedCount: u.failedCount,
        status: u.status,
        createdAt: u.createdAt,
        activatedAt: u.activatedAt,
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
   * Confirms registration and executes transactional batch creation for valid rows.
   * - SUPER_ADMIN / ADMIN: activates directly.
   * - OPERATOR: routes to PENDING_APPROVAL and creates an ApprovalRequest.
   */
  async confirmAndRegisterStudents(
    uploadId: string,
    actor: { userId: string; email?: string; roles?: string[] },
  ) {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
    });

    if (!upload) {
      throw new NotFoundException(`Upload batch '${uploadId}' not found.`);
    }

    if (upload.status !== 'READY_FOR_REVIEW' && upload.status !== 'UPLOADED') {
      throw new BadRequestException(
        `Upload batch is in '${upload.status}' state and cannot be registered. Expected READY_FOR_REVIEW.`,
      );
    }

    if (upload.validRowCount === 0) {
      throw new BadRequestException('This batch has 0 valid rows to register.');
    }

    // ─── OPERATOR: route to approval queue instead of direct activation ───
    const actorRoles: string[] = actor.roles || [];
    const isOperator =
      actorRoles.includes('OPERATOR') &&
      !actorRoles.includes('SUPER_ADMIN') &&
      !actorRoles.includes('ADMIN');

    if (isOperator) {
      await this.prisma.bulkUpload.update({
        where: { id: uploadId },
        data: { status: 'PENDING_APPROVAL' as any },
      });

      await this.prisma.approvalRequest.create({
        data: {
          resourceType: 'BULK_UPLOAD',
          resourceId: uploadId,
          requestedById: actor.userId,
          status: 'PENDING',
          metadata: {
            uploadType: 'STUDENT_BULK_REGISTRATION',
            creatorRole: 'OPERATOR',
            fileName: upload.fileName,
            validRows: upload.validRowCount,
          },
        },
      });

      this.logger.log(
        `Operator ${actor.userId} submitted student batch ${uploadId} for approval (${upload.validRowCount} valid rows).`,
      );

      return {
        uploadId,
        status: 'PENDING_APPROVAL',
        totalValid: upload.validRowCount,
        activated: 0,
        failed: 0,
        message:
          'Your student registration has been submitted for Super Admin approval. Students will be registered once approved.',
      };
    }

    // ─── SUPER_ADMIN / ADMIN: activate directly (existing flow) ──────────
    // Set status to ACTIVATING
    await this.prisma.bulkUpload.update({
      where: { id: uploadId },
      data: { status: 'ACTIVATING' },
    });

    // Execute bulk registration synchronously in controlled transactional batches
    return this.executeBulkRegistration(uploadId, actor);
  }

  /**
   * Executes transactional batch registration for all valid staged rows
   */
  async executeBulkRegistration(
    uploadId: string,
    actor?: { userId: string; email?: string },
  ): Promise<{
    uploadId: string;
    totalValid: number;
    activated: number;
    failed: number;
    status: string;
  }> {
    const validRows = await this.prisma.bulkUploadRow.findMany({
      where: {
        uploadId,
        validationStatus: 'VALID',
        activationStatus: 'PENDING',
        deduplicationStatus: 'UNIQUE',
      },
      orderBy: { rowNumber: 'asc' },
    });

    if (this.jobProgressService && validRows.length > 0) {
      await this.jobProgressService.publishStarted('student-bulk-registration', uploadId, {
        type: 'STUDENT_BULK_REGISTRATION',
        stage: 'ACTIVATING_STUDENTS',
        userId: actor?.userId,
        message: `Starting registration for ${validRows.length} students...`,
      });
    }

    let activated = 0;
    let failed = 0;

    const CHUNK_SIZE = validRows.length <= 10 ? 1 : Math.min(25, Math.max(1, Math.floor(validRows.length / 20)));
    for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + CHUNK_SIZE);

      for (const row of chunk) {
        const data = row.normalizedData as any;

        try {
          await this.prisma.$transaction(async (tx) => {
            // 1. Race condition duplicate check inside transaction
            const existingUser = await tx.user.findFirst({
              where: {
                OR: [
                  { mobileNumber: data.mobile },
                  { phone: data.mobile },
                  ...(data.email ? [{ email: data.email }] : []),
                ],
              },
            });

            if (existingUser) {
              throw new BadRequestException(
                `Mobile '${data.mobile}' or email '${data.email}' already registered.`,
              );
            }

            // 2. Create User (with hashed password, status ACTIVE, verified)
            const newUser = await tx.user.create({
              data: {
                phone: data.mobile,
                mobileNumber: data.mobile,
                email: data.email || null,
                passwordHash: data.passwordHash || null,
                status: 'ACTIVE',
                isVerified: true,
                isActive: true,
                mobileVerifiedAt: new Date(),
                emailVerifiedAt: data.email ? new Date() : null,
              },
            });

            // 3. Ensure STUDENT role exists & assign
            let studentRole = await tx.role.findUnique({
              where: { name: 'STUDENT' },
            });
            if (!studentRole) {
              studentRole = await tx.role.create({ data: { name: 'STUDENT' } });
            }

            await tx.userRole.create({
              data: { userId: newUser.id, roleId: studentRole.id },
            });

            // 4. Generate unique sequential collision-safe Student ID
            const year = new Date().getFullYear();
            let sequenceNum = (await tx.student.count()) + 1;
            let studentIdStr = `STU${String(sequenceNum + 1000).padStart(6, '0')}`;
            let studentCode = `BRN-${year}-${String(sequenceNum).padStart(6, '0')}`;

            let collision = await tx.student.findFirst({
              where: { OR: [{ studentCode }, { studentId: studentIdStr }] },
            });
            while (collision) {
              sequenceNum++;
              studentIdStr = `STU${String(sequenceNum + 1000).padStart(6, '0')}`;
              studentCode = `BRN-${year}-${String(sequenceNum).padStart(6, '0')}`;
              collision = await tx.student.findFirst({
                where: { OR: [{ studentCode }, { studentId: studentIdStr }] },
              });
            }

            // 5. Create Student profile
            const student = await tx.student.create({
              data: {
                userId: newUser.id,
                studentId: studentIdStr,
                studentCode,
                name: data.name,
                state: data.state || 'Not Specified',
                district: data.city || 'Not Specified',
                stateId: data.stateId || null,
                districtId: data.districtId || null,
                schoolCollege: data.schoolCollege || data.institutionName || 'Not Specified',
                institutionId: data.institutionId || null,
                classId: data.classId,
                examTargetId: data.examTargetId,
                jee: Boolean(data.jee),
                cet: Boolean(data.cet),
                neet: Boolean(data.neet),
                preferredLanguageId: data.preferredLanguageId,
                status: 'ACTIVE',
                registrationSource: 'OPERATOR',
              },
            });

            // 5b. Create StudentExamTarget entries (supports multi-target e.g. NEET, CET)
            const targetIds: string[] =
              Array.isArray(data.examTargetIds) && data.examTargetIds.length > 0
                ? data.examTargetIds
                : data.examTargetId
                  ? [data.examTargetId]
                  : [];

            if (targetIds.length > 0) {
              await tx.studentExamTarget.createMany({
                data: targetIds.map((tId: string, idx: number) => ({
                  studentId: student.id,
                  examTargetId: tId,
                  isPrimary: idx === 0,
                })),
                skipDuplicates: true,
              });
            }

            // 6. Update Row status
            await tx.bulkUploadRow.update({
              where: { id: row.id },
              data: {
                activationStatus: 'ACTIVATED',
                matchedStudentId: student.id,
              },
            });
          });

          activated++;
        } catch (err: any) {
          failed++;
          this.logger.error(
            `Failed to register student row ${row.rowNumber} for upload ${uploadId}: ${err.message}`,
          );

          await this.prisma.bulkUploadRow.update({
            where: { id: row.id },
            data: {
              activationStatus: 'FAILED',
              activationError: err.message,
            },
          });
        }
      }

      // Update progress in DB and WebSocket
      await this.prisma.bulkUpload.update({
        where: { id: uploadId },
        data: {
          activatedCount: activated,
          failedCount: failed,
        },
      });

      if (this.jobProgressService && validRows.length > 0) {
        await this.jobProgressService.publishProgress(
          'student-bulk-registration',
          uploadId,
          activated + failed,
          validRows.length,
          {
            stage: 'ACTIVATING_STUDENTS',
            message: `Registered ${activated} students (${activated + failed}/${validRows.length})...`,
            userId: actor?.userId,
          },
        );
      }
    }

    const finalStatus =
      failed > 0 && activated > 0
        ? 'PARTIALLY_ACTIVATED'
        : failed > 0
          ? 'FAILED'
          : 'ACTIVATED';

    const finalUpload = await this.prisma.bulkUpload.update({
      where: { id: uploadId },
      data: {
        status: finalStatus as any,
        activatedCount: activated,
        failedCount: failed,
        activatedAt: new Date(),
      },
    });

    if (this.jobProgressService) {
      await this.jobProgressService.publishCompleted(
        'student-bulk-registration',
        uploadId,
        {
          message: `Bulk registration completed: ${activated} registered, ${failed} failed.`,
          resultSummary: {
            uploadId,
            totalValid: validRows.length,
            activated,
            failed,
            status: finalStatus,
          },
          totalProcessed: activated + failed,
          userId: actor?.userId,
        },
      );
    }

    if (actor?.userId) {
      await this.securityEventService.log('STUDENTS_BULK_IMPORTED' as any, {
        userId: actor.userId,
        metadata: {
          uploadId,
          totalValid: validRows.length,
          activated,
          failed,
          status: finalStatus,
        },
      });
    }

    return {
      uploadId,
      totalValid: validRows.length,
      activated,
      failed,
      status: finalUpload.status,
    };
  }

  /**
   * Generates downloadable error report for failed / invalid rows
   */
  async generateErrorReport(
    uploadId: string,
    format: 'csv' | 'xlsx' = 'xlsx',
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const upload = await this.prisma.bulkUpload.findUnique({
      where: { id: uploadId },
      include: {
        rows: {
          where: {
            OR: [
              { validationStatus: 'INVALID' },
              { activationStatus: 'FAILED' },
              { deduplicationStatus: { not: 'UNIQUE' } },
            ],
          },
          orderBy: { rowNumber: 'asc' },
          include: { errors: true },
        },
      },
    });

    if (!upload) {
      throw new NotFoundException(`Upload batch '${uploadId}' not found.`);
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Error Report');

    sheet.columns = [
      { header: 'Row #', key: 'rowNumber', width: 10 },
      { header: 'Full Name', key: 'name', width: 22 },
      { header: 'Mobile Number', key: 'mobile', width: 18 },
      { header: 'Email', key: 'email', width: 26 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Error Reasons', key: 'errors', width: 45 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.height = 26;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF991B1B' }, // Dark red
      };
      cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    upload.rows.forEach((r) => {
      const data = (r.normalizedData || r.rawData) as any;
      const errorMsg =
        r.activationError ||
        r.errors.map((e) => `[${e.field}] ${e.message}`).join('; ') ||
        `Deduplication status: ${r.deduplicationStatus}`;

      sheet.addRow({
        rowNumber: r.rowNumber,
        name: data?.name || 'N/A',
        mobile: data?.mobile || data?.phone || 'N/A',
        email: data?.email || 'N/A',
        status: r.activationStatus === 'FAILED' ? 'ACTIVATION_FAILED' : r.validationStatus,
        errors: errorMsg,
      });
    });

    if (format === 'csv') {
      const buffer = (await workbook.csv.writeBuffer()) as unknown as Buffer;
      return {
        buffer: Buffer.from(buffer),
        fileName: `bulk_student_errors_${uploadId.substring(0, 8)}.csv`,
        mimeType: 'text/csv',
      };
    } else {
      const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
      return {
        buffer: Buffer.from(buffer),
        fileName: `bulk_student_errors_${uploadId.substring(0, 8)}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
  }

  /**
   * Update a staged row's values and re-run row-level validation
   */
  async updateStagedRow(
    rowId: string,
    patchData: UpdateBulkStudentRowDto,
    actor?: { userId: string; email?: string },
  ) {
    const row = await this.prisma.bulkUploadRow.findUnique({
      where: { id: rowId },
      include: {
        upload: {
          include: { institution: true },
        },
      },
    });

    if (!row) {
      throw new NotFoundException(`Bulk upload row '${rowId}' not found.`);
    }

    if (row.upload.status === 'ACTIVATING' || row.upload.status === 'ACTIVATED') {
      throw new BadRequestException(
        `Cannot edit rows in a batch that is already in '${row.upload.status}' state.`,
      );
    }

    const currentNormalized = (row.normalizedData || {}) as any;

    const merged = {
      ...currentNormalized,
      ...patchData,
    };

    const rowErrors: { field: string; errorCode: string; message: string }[] = [];

    const name = (merged.name || '').trim();
    const rawMobile = (merged.mobile || '').replace(/\D/g, '');
    const email = merged.email ? merged.email.toLowerCase().trim() : null;
    let stateName = (merged.state || '').trim();
    let cityName = (merged.city || '').trim();
    let className = (merged.class || '').trim();
    const examTargetName = (merged.examTarget || '').trim();
    let languageName = (merged.preferredLanguage || '').trim();
    const schoolCollege = (merged.schoolCollege || '').trim();
    const institutionId = merged.institutionId || null;

    if (!name || name.length < 2) {
      rowErrors.push({
        field: 'name',
        errorCode: 'INVALID_NAME',
        message: 'Student name is required (minimum 2 characters).',
      });
    }

    if (!rawMobile) {
      rowErrors.push({
        field: 'mobile',
        errorCode: 'MISSING_MOBILE',
        message: 'Mobile number is required.',
      });
    } else {
      const standardMobile =
        rawMobile.length === 10
          ? rawMobile
          : rawMobile.startsWith('91') && rawMobile.length === 12
            ? rawMobile.substring(2)
            : rawMobile;
      if (!MOBILE_REGEX.test(standardMobile)) {
        rowErrors.push({
          field: 'mobile',
          errorCode: 'INVALID_MOBILE_FORMAT',
          message: `Invalid mobile number '${rawMobile}'. Must be a 10-digit number starting with 6-9.`,
        });
      }
    }

    if (email && !EMAIL_REGEX.test(email)) {
      rowErrors.push({
        field: 'email',
        errorCode: 'INVALID_EMAIL_FORMAT',
        message: `Invalid email address format '${email}'.`,
      });
    }

    // Load Master Data
    const [states, districts, classes, examTargets, languages, institutions] = await Promise.all([
      this.prisma.state.findMany({ where: { isActive: true } }),
      this.prisma.district.findMany({ where: { isActive: true } }),
      this.prisma.studentClass.findMany(),
      this.prisma.examTarget.findMany(),
      this.prisma.preferredLanguage.findMany({ where: { isActive: true } }),
      this.prisma.institution.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, code: true },
      }),
    ]);

    const stateMap = new Map<string, any>();
    states.forEach((s) => {
      stateMap.set(s.name.toLowerCase().trim(), s);
      stateMap.set(s.code.toLowerCase().trim(), s);
    });

    const districtMap = new Map<string, any>();
    districts.forEach((d) => {
      districtMap.set(`${d.name.toLowerCase().trim()}_${d.stateId}`, d);
      districtMap.set(d.name.toLowerCase().trim(), d);
    });

    const classMap = new Map<string, any>();
    classes.forEach((c) => {
      classMap.set(c.name.toLowerCase().trim(), c);
      classMap.set(c.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(), c);
    });

    const examTargetMap = new Map<string, any>();
    examTargets.forEach((et) => {
      examTargetMap.set(et.name.toLowerCase().trim(), et);
      examTargetMap.set(et.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(), et);
    });

    const languageMap = new Map<string, any>();
    languages.forEach((l) => {
      languageMap.set(l.name.toLowerCase().trim(), l);
      if (l.code) languageMap.set(l.code.toLowerCase().trim(), l);
    });

    const institutionMap = new Map<string, any>();
    institutions.forEach((i) => {
      institutionMap.set(i.id.toLowerCase(), i);
      institutionMap.set(i.code.toLowerCase().trim(), i);
      institutionMap.set(i.name.toLowerCase().trim(), i);
    });

    let resolvedStateId: string | null = null;
    let resolvedDistrictId: string | null = null;
    let resolvedClassId: string | null = null;
    let resolvedLanguageId: string | null = null;
    let resolvedExamTargetId: string | null = null;
    const resolvedExamTargetIds: string[] = [];
    const validTargetNames: string[] = [];
    let resolvedInstitutionId: string | null = null;
    let resolvedInstitutionName: string | null = null;

    // State & City Resolution
    if (stateName || cityName) {
      const stateRes = this.resolveStateAndCity(
        stateName,
        cityName,
        stateMap,
        states,
        districtMap,
        districts,
      );
      if (stateRes.stateRecord) {
        resolvedStateId = stateRes.stateRecord.id;
        stateName = stateRes.stateRecord.name;
      }
      if (stateRes.districtRecord) {
        resolvedDistrictId = stateRes.districtRecord.id;
        cityName = stateRes.districtRecord.name;
      }
    }

    // Class Resolution
    if (className) {
      const classRecord = this.resolveAcademicClass(className, classMap, classes);
      if (classRecord) {
        resolvedClassId = classRecord.id;
        className = classRecord.name === 'CLASS_11' ? '11th' : classRecord.name === 'CLASS_12' ? '12th' : classRecord.name;
      } else {
        rowErrors.push({ field: 'class', errorCode: 'UNKNOWN_CLASS', message: `Class '${className}' not recognized.` });
      }
    }

    // Language Resolution
    if (languageName) {
      const langRecord = this.resolvePreferredLanguage(languageName, languageMap, languages);
      if (langRecord) {
        resolvedLanguageId = langRecord.id;
        languageName = langRecord.name;
      } else {
        rowErrors.push({ field: 'preferredLanguage', errorCode: 'UNKNOWN_LANGUAGE', message: `Language '${languageName}' not supported.` });
      }
    }

    // Password validation & hashing on edit
    let passwordHash = currentNormalized.passwordHash || null;
    if (patchData.password) {
      const trimmedPass = patchData.password.trim();
      if (trimmedPass.length < 6) {
        rowErrors.push({
          field: 'password',
          errorCode: 'PASSWORD_TOO_SHORT',
          message: 'Password must be at least 6 characters long.',
        });
      } else {
        passwordHash = bcrypt.hashSync(trimmedPass, 10);
      }
    } else if (!passwordHash) {
      rowErrors.push({
        field: 'password',
        errorCode: 'MISSING_PASSWORD',
        message: 'Password is required (minimum 6 characters).',
      });
    }

    // Exam Target validation (supports separate Boolean flags or legacy target name)
    let hasJee = currentNormalized.jee ?? false;
    let hasCet = currentNormalized.cet ?? false;
    let hasNeet = currentNormalized.neet ?? false;

    if (patchData.jee !== undefined || patchData.cet !== undefined || patchData.neet !== undefined) {
      if (patchData.jee !== undefined) hasJee = Boolean(patchData.jee);
      if (patchData.cet !== undefined) hasCet = Boolean(patchData.cet);
      if (patchData.neet !== undefined) hasNeet = Boolean(patchData.neet);

      if (!hasJee && !hasCet && !hasNeet) {
        rowErrors.push({
          field: 'examTarget',
          errorCode: 'MISSING_EXAM_ELIGIBILITY',
          message: 'At least one target exam (JEE, CET, or NEET) must be TRUE.',
        });
      } else {
        const canonicalTargetName = mapExamBooleansToCanonical(hasJee, hasCet, hasNeet);
        if (canonicalTargetName) {
          const resolved = this.resolveCanonicalExamTarget(canonicalTargetName, examTargets);
          if (resolved) {
            resolvedExamTargetId = resolved.targetRecord.id;
            resolvedExamTargetIds.push(...resolved.resolvedTargetIds);
            validTargetNames.push(resolved.canonicalName);
          } else {
            rowErrors.push({
              field: 'examTarget',
              errorCode: 'INVALID_EXAM_TARGET',
              message: `Target combination (JEE=${hasJee}, CET=${hasCet}, NEET=${hasNeet}) could not be resolved.`,
            });
          }
        }
      }
    } else if (examTargetName) {
      const resolved = this.resolveCanonicalExamTarget(examTargetName, examTargets);
      if (!resolved) {
        rowErrors.push({
          field: 'examTarget',
          errorCode: 'INVALID_EXAM_TARGET',
          message: `Exam target '${examTargetName}' is invalid. Valid options: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET.`,
        });
      } else {
        resolvedExamTargetId = resolved.targetRecord.id;
        resolvedExamTargetIds.push(...resolved.resolvedTargetIds);
        validTargetNames.push(resolved.canonicalName);
        const booleans = mapCanonicalToExamBooleans(resolved.canonicalName);
        hasJee = booleans.jee;
        hasCet = booleans.cet;
        hasNeet = booleans.neet;
      }
    } else if (currentNormalized.examTargetId) {
      resolvedExamTargetId = currentNormalized.examTargetId;
      if (Array.isArray(currentNormalized.examTargetIds)) {
        resolvedExamTargetIds.push(...currentNormalized.examTargetIds);
      }
      if (currentNormalized.examTarget) {
        validTargetNames.push(currentNormalized.examTarget);
      }
    } else {
      rowErrors.push({
        field: 'examTarget',
        errorCode: 'MISSING_EXAM_TARGET',
        message: 'Exam Target is required (Valid: JEE, CET, NEET, NEET + JEE, NEET + State CET, JEE + State CET, JEE + NEET + State CET).',
      });
    }

    // Institution resolution fixed to upload context
    resolvedInstitutionId = row.upload.institutionId || currentNormalized.institutionId;
    resolvedInstitutionName = row.upload.institution?.name || currentNormalized.institutionName || currentNormalized.schoolCollege || 'Not Specified';

    // Deduplication check
    const standardMobile =
      rawMobile.length === 10
        ? rawMobile
        : rawMobile.startsWith('91') && rawMobile.length === 12
          ? rawMobile.substring(2)
          : rawMobile;
    const normalizedMobile = standardMobile ? `+91${standardMobile}` : '';

    let dedupStatus = 'UNIQUE';
    if (standardMobile) {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { mobileNumber: normalizedMobile },
            { phone: normalizedMobile },
            { mobileNumber: standardMobile },
            { phone: standardMobile },
          ],
        },
      });
      if (existingUser) {
        dedupStatus = 'EXISTING_STUDENT';
        rowErrors.push({
          field: 'mobile',
          errorCode: 'MOBILE_ALREADY_REGISTERED',
          message: `Mobile '${standardMobile}' is already registered in DB.`,
        });
      }
    }

    const isValid = rowErrors.length === 0;

    const newNormalizedData = {
      name,
      mobile: normalizedMobile,
      rawMobile: standardMobile,
      email,
      passwordHash,
      jee: hasJee,
      cet: hasCet,
      neet: hasNeet,
      state: stateName,
      city: cityName,
      stateId: resolvedStateId,
      districtId: resolvedDistrictId,
      class: className,
      classId: resolvedClassId,
      examTarget: validTargetNames.length > 0 ? validTargetNames.join(', ') : examTargetName,
      examTargetId: resolvedExamTargetId,
      examTargetIds: resolvedExamTargetIds,
      preferredLanguage: languageName,
      preferredLanguageId: resolvedLanguageId,
      schoolCollege: resolvedInstitutionName,
      institutionId: resolvedInstitutionId,
      institutionName: resolvedInstitutionName,
    };

    // Delete old errors for this row
    await this.prisma.bulkUploadError.deleteMany({ where: { rowId: row.id } });

    // Insert new errors if invalid
    if (rowErrors.length > 0) {
      await this.prisma.bulkUploadError.createMany({
        data: rowErrors.map((err) => ({
          uploadId: row.uploadId,
          rowId: row.id,
          rowNumber: row.rowNumber,
          field: err.field,
          errorCode: err.errorCode,
          message: err.message,
        })),
      });
    }

    // Update row
    const updatedRow = await this.prisma.bulkUploadRow.update({
      where: { id: row.id },
      data: {
        normalizedData: newNormalizedData,
        validationStatus: isValid ? 'VALID' : 'INVALID',
        deduplicationStatus: dedupStatus,
        errorCount: rowErrors.length,
      },
      include: { errors: true },
    });

    // Recalculate summary counts on BulkUpload
    const [validCount, invalidCount, duplicateCount] = await Promise.all([
      this.prisma.bulkUploadRow.count({ where: { uploadId: row.uploadId, validationStatus: 'VALID' } }),
      this.prisma.bulkUploadRow.count({ where: { uploadId: row.uploadId, validationStatus: 'INVALID' } }),
      this.prisma.bulkUploadRow.count({ where: { uploadId: row.uploadId, deduplicationStatus: { not: 'UNIQUE' } } }),
    ]);

    const updatedUpload = await this.prisma.bulkUpload.update({
      where: { id: row.uploadId },
      data: {
        validRowCount: validCount,
        invalidRowCount: invalidCount,
        duplicateRowCount: duplicateCount,
        status: validCount > 0 ? 'READY_FOR_REVIEW' : 'FAILED',
      },
    });

    return {
      row: {
        id: updatedRow.id,
        rowNumber: updatedRow.rowNumber,
        data: updatedRow.normalizedData,
        validationStatus: updatedRow.validationStatus,
        deduplicationStatus: updatedRow.deduplicationStatus,
        errors: updatedRow.errors.map((e) => ({ field: e.field, errorCode: e.errorCode, message: e.message })),
      },
      uploadSummary: {
        uploadId: updatedUpload.id,
        validRowCount: updatedUpload.validRowCount,
        invalidRowCount: updatedUpload.invalidRowCount,
        duplicateRowCount: updatedUpload.duplicateRowCount,
        status: updatedUpload.status,
      },
    };
  }

  /**
   * Helper: Resolve academic class with comprehensive alias & spelling tolerance
   */
  private resolveAcademicClass(
    className: string,
    classMap: Map<string, any>,
    classes: any[],
  ) {
    if (!className) return null;
    const raw = className.toLowerCase().trim();
    const clean = raw.replace(/[^a-z0-9]/g, '');

    // 1. Direct map lookup
    if (classMap.has(raw)) return classMap.get(raw);
    if (classMap.has(clean)) return classMap.get(clean);

    // 2. Class 11 variations
    if (
      /^(11|11th|xi|class\s*11|class\s*11th|class\s*xi|11th\s*std|11th\s*standard|11th\s*grade|first\s*puc|1st\s*puc|puc\s*1|plus\s*1|\+1|fyjc|inter\s*1st)/i.test(raw) ||
      clean === '11' || clean === '11th' || clean === 'xi' || clean === 'class11' || clean === 'class11th' || clean === 'classxi'
    ) {
      return (
        classes.find((c) => /11/i.test(c.name)) ||
        classMap.get('class 11') ||
        classMap.get('class_11') ||
        classMap.get('11th') ||
        null
      );
    }

    // 3. Class 12 variations
    if (
      /^(12|12th|xii|class\s*12|class\s*12th|class\s*xii|12th\s*std|12th\s*standard|12th\s*grade|second\s*puc|2nd\s*puc|puc\s*2|plus\s*2|\+2|syjc|hsc|inter\s*2nd)/i.test(raw) ||
      clean === '12' || clean === '12th' || clean === 'xii' || clean === 'class12' || clean === 'class12th' || clean === 'classxii'
    ) {
      return (
        classes.find((c) => /12/i.test(c.name)) ||
        classMap.get('class 12') ||
        classMap.get('class_12') ||
        classMap.get('12th') ||
        null
      );
    }

    // 4. Dropper / Repeater variations
    if (
      /^(drop|dropper|repeat|repeater|long\s*term|longterm|13|13th|target)/i.test(raw) ||
      clean.includes('drop') || clean.includes('repeat')
    ) {
      return (
        classes.find((c) => /drop/i.test(c.name)) ||
        classMap.get('dropper') ||
        null
      );
    }

    // 5. Foundation variations
    if (
      /^(foundation|9|9th|10|10th|ix|x|class\s*9|class\s*10|class\s*9th|class\s*10th)/i.test(raw) ||
      clean.includes('foundation')
    ) {
      return (
        classes.find((c) => /found/i.test(c.name)) ||
        classMap.get('foundation') ||
        null
      );
    }

    // 6. Substring match fallback
    for (const c of classes) {
      const cClean = c.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.includes(cClean) || cClean.includes(clean)) return c;
    }

    return null;
  }

  /**
   * Helper: Resolve canonical Exam Target strictly to one of the 7 supported combinations
   */
  private resolveCanonicalExamTarget(
    targetInput: string,
    examTargets: any[],
  ): { targetRecord: any; canonicalName: string; resolvedTargetIds: string[] } | null {
    if (!targetInput || !targetInput.trim()) return null;
    const normalized = normalizeTargetExamInput(targetInput);
    if (!normalized) return null;

    const targetRecord = examTargets.find(
      (et) =>
        et.name.toLowerCase().trim() === normalized.toLowerCase() ||
        normalizeTargetExamInput(et.name)?.toLowerCase() === normalized.toLowerCase() ||
        et.name.toLowerCase().replace(/\s*and\s*/g, ' + ') === normalized.toLowerCase() ||
        et.name.toLowerCase().replace(/\s*\+\s*/g, ' and ') === normalized.toLowerCase(),
    );
    if (!targetRecord) return null;

    // Resolve eligible actual exam types (e.g. ['NEET', 'JEE'])
    const eligibleTypes = resolveEligibleExamTypes(normalized);
    const eligibleRecords = examTargets.filter((et) =>
      eligibleTypes.some((t) => t.toLowerCase() === et.name.toLowerCase().trim()),
    );
    const resolvedTargetIds = Array.from(
      new Set([targetRecord.id, ...eligibleRecords.map((r) => r.id)]),
    );

    return {
      targetRecord,
      canonicalName: normalized,
      resolvedTargetIds,
    };
  }

  /**
   * Helper: Resolve exam target with aliases (JEE Main, MHT-CET, NEET-UG, CAT, etc.)
   */
  private resolveSingleExamTarget(
    targetName: string,
    examTargetMap: Map<string, any>,
    examTargets: any[],
  ) {
    if (!targetName) return null;
    const raw = targetName.toLowerCase().trim();
    const clean = raw.replace(/[^a-z0-9]/g, '');

    // 1. Direct map lookup
    if (examTargetMap.has(raw)) return examTargetMap.get(raw);
    if (examTargetMap.has(clean)) return examTargetMap.get(clean);

    // 2. JEE variations
    if (
      /^(jee|iit|iit_jee|iit\s*jee|jee\s*main|jee_main|jee-main|jeemain|jee\s*adv|engineering)/i.test(raw) ||
      clean.startsWith('jee') || clean.includes('iit')
    ) {
      return examTargets.find((et) => et.name === 'JEE') || examTargetMap.get('jee') || null;
    }

    // 3. NEET variations
    if (
      /^(neet|neet_ug|neet-ug|neet\s*ug|neetug|aipmt|medical|pmt)/i.test(raw) ||
      clean.startsWith('neet')
    ) {
      return examTargets.find((et) => et.name === 'NEET') || examTargetMap.get('neet') || null;
    }

    // 4. CET variations (MHT-CET, GUJCET, KCET, State CET, etc.)
    if (
      /^(cet|mht|mht_cet|mht-cet|mht\s*cet|mhtcet|gujcet|kcet|state\s*cet|keam|eamcet|wbjee)/i.test(raw) ||
      clean.includes('cet')
    ) {
      return examTargets.find((et) => et.name === 'CET') || examTargetMap.get('cet') || null;
    }


    // 6. Substring match fallback
    for (const et of examTargets) {
      const etClean = et.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.includes(etClean) || etClean.includes(clean)) return et;
    }

    return null;
  }

  /**
   * Helper: Resolve preferred language with aliases & spelling tolerance
   */
  private resolvePreferredLanguage(
    languageName: string,
    languageMap: Map<string, any>,
    languages: any[],
  ) {
    if (!languageName) return null;
    const raw = languageName.toLowerCase().trim();
    const clean = raw.replace(/[^a-z0-9]/g, '');

    // 1. Direct map lookup
    if (languageMap.has(raw)) return languageMap.get(raw);
    if (languageMap.has(clean)) return languageMap.get(clean);

    // 2. Language variations
    if (/^(en|eng|english|angrezi)/i.test(raw)) return languages.find((l) => l.name === 'ENGLISH') || null;
    if (/^(hi|hin|hindi)/i.test(raw)) return languages.find((l) => l.name === 'HINDI') || null;
    if (/^(gu|guj|gujarati|gujrati)/i.test(raw)) return languages.find((l) => l.name === 'GUJARATI') || null;
    if (/^(mr|mar|marathi)/i.test(raw)) return languages.find((l) => l.name === 'MARATHI') || null;
    if (/^(kn|kan|kannada)/i.test(raw)) return languages.find((l) => l.name === 'KANNADA') || null;
    if (/^(ta|tam|tamil)/i.test(raw)) return languages.find((l) => l.name === 'TAMIL') || null;
    if (/^(te|tel|telugu)/i.test(raw)) return languages.find((l) => l.name === 'TELUGU') || null;
    if (/^(ml|mal|malayalam)/i.test(raw)) return languages.find((l) => l.name === 'MALAYALAM') || null;
    if (/^(bn|ben|bengali|bangla)/i.test(raw)) return languages.find((l) => l.name === 'BENGALI') || null;

    // 3. Substring match
    for (const l of languages) {
      const lClean = l.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.includes(lClean) || lClean.includes(clean)) return l;
    }

    return null;
  }

  /**
   * Helper: Resolve state and district with alias map and city fallback
   */
  private resolveStateAndCity(
    stateName: string,
    cityName: string,
    stateMap: Map<string, any>,
    states: any[],
    districtMap: Map<string, any>,
    districts: any[],
  ) {
    let stateRecord: any = null;
    if (stateName) {
      const sRaw = stateName.toLowerCase().trim();
      const sClean = sRaw.replace(/[^a-z0-9]/g, '');

      // Direct map check
      stateRecord = stateMap.get(sRaw) || stateMap.get(sClean);

      // State alias map
      if (!stateRecord) {
        const STATE_ALIASES: Record<string, string> = {
          up: 'Uttar Pradesh',
          'u.p.': 'Uttar Pradesh',
          uttarpradesh: 'Uttar Pradesh',
          mp: 'Madhya Pradesh',
          'm.p.': 'Madhya Pradesh',
          madhyapradesh: 'Madhya Pradesh',
          wb: 'West Bengal',
          'w.b.': 'West Bengal',
          westbengal: 'West Bengal',
          tn: 'Tamil Nadu',
          't.n.': 'Tamil Nadu',
          tamilnadu: 'Tamil Nadu',
          mh: 'Maharashtra',
          maharastra: 'Maharashtra',
          gj: 'Gujarat',
          gujrat: 'Gujarat',
          ka: 'Karnataka',
          karnatka: 'Karnataka',
          rj: 'Rajasthan',
          rajastan: 'Rajasthan',
          ts: 'Telangana',
          tg: 'Telangana',
          telengana: 'Telangana',
          ap: 'Andhra Pradesh',
          'a.p.': 'Andhra Pradesh',
          andhra: 'Andhra Pradesh',
          dl: 'Delhi',
          newdelhi: 'Delhi',
          nct: 'Delhi',
          pb: 'Punjab',
          kl: 'Kerala',
          hr: 'Haryana',
          br: 'Bihar',
          od: 'Odisha',
          or: 'Odisha',
          orissa: 'Odisha',
          jk: 'Jammu and Kashmir',
          'j&k': 'Jammu and Kashmir',
          uk: 'Uttarakhand',
          uttaranchal: 'Uttarakhand',
          jh: 'Jharkhand',
          cg: 'Chhattisgarh',
          ga: 'Goa',
          as: 'Assam',
        };

        const canonicalName = STATE_ALIASES[sRaw] || STATE_ALIASES[sClean];
        if (canonicalName) {
          stateRecord =
            stateMap.get(canonicalName.toLowerCase()) ||
            states.find((s) => s.name.toLowerCase() === canonicalName.toLowerCase());
        }

        // Substring / partial match
        if (!stateRecord) {
          stateRecord = states.find((s) => {
            const sc = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return sc.includes(sClean) || sClean.includes(sc);
          });
        }
      }
    }

    let districtRecord: any = null;
    if (cityName) {
      const cRaw = cityName.toLowerCase().trim();
      const cClean = cRaw.replace(/[^a-z0-9]/g, '');

      // Check with state ID if state is resolved
      if (stateRecord) {
        districtRecord =
          districtMap.get(`${cRaw}_${stateRecord.id}`) ||
          districtMap.get(`${cClean}_${stateRecord.id}`);
      }

      // Fallback direct check
      if (!districtRecord) {
        districtRecord = districtMap.get(cRaw) || districtMap.get(cClean);
      }

      // City aliases
      if (!districtRecord) {
        const CITY_ALIASES: Record<string, string> = {
          bangalore: 'Bengaluru',
          bengaluru: 'Bengaluru',
          bombay: 'Mumbai',
          mumbai: 'Mumbai',
          calcutta: 'Kolkata',
          kolkata: 'Kolkata',
          madras: 'Chennai',
          chennai: 'Chennai',
          cochin: 'Kochi',
          kochi: 'Kochi',
          ernakulam: 'Ernakulam',
          trivandrum: 'Thiruvananthapuram',
          poona: 'Pune',
          pune: 'Pune',
          nasik: 'Nashik',
          nashik: 'Nashik',
          baroda: 'Vadodara',
          vadodara: 'Vadodara',
          gurgaon: 'Gurugram',
          gurugram: 'Noida',
          allahabad: 'Prayagraj',
          prayagraj: 'Prayagraj',
          banaras: 'Varanasi',
          varanasi: 'Varanasi',
        };

        const canonCity = CITY_ALIASES[cRaw] || CITY_ALIASES[cClean];
        if (canonCity) {
          if (stateRecord) {
            districtRecord = districtMap.get(`${canonCity.toLowerCase()}_${stateRecord.id}`);
          }
          if (!districtRecord) {
            districtRecord = districtMap.get(canonCity.toLowerCase());
          }
        }
      }

      // Substring match in state districts
      if (!districtRecord && stateRecord) {
        districtRecord = districts.find(
          (d) =>
            d.stateId === stateRecord.id &&
            (d.name.toLowerCase().includes(cRaw) || cRaw.includes(d.name.toLowerCase())),
        );
      }
    }

    return {
      stateRecord,
      districtRecord,
    };
  }

  /**
   * Helper: Resolve School / College / Institution with fuzzy and token matching
   */
  private resolveInstitution(
    schoolCollege: string,
    selectedInstitution: any,
    institutionMap: Map<string, any>,
    institutions: any[],
  ) {
    if (selectedInstitution) {
      return {
        id: selectedInstitution.id,
        name: selectedInstitution.name,
      };
    }

    if (!schoolCollege) return { id: null, name: null };

    const raw = schoolCollege.toLowerCase().trim();
    const clean = raw.replace(/[^a-z0-9]/g, '');

    // 1. Direct map lookup by ID, code, or exact name
    const direct = institutionMap.get(raw) || institutionMap.get(clean);
    if (direct) {
      return { id: direct.id, name: direct.name };
    }

    // 2. Token / keyword matching
    const stopWords = new Set([
      'school',
      'college',
      'high',
      'the',
      'international',
      'secondary',
      'vidyalaya',
      'academy',
      'institute',
      'senior',
      'public',
    ]);
    const tokens = raw.split(/[\s,.-]+/).filter((t) => t.length > 2 && !stopWords.has(t));

    if (tokens.length > 0) {
      for (const inst of institutions) {
        const instLower = inst.name.toLowerCase();
        const matchesAll = tokens.every((token) => instLower.includes(token));
        if (matchesAll) {
          return { id: inst.id, name: inst.name };
        }
      }

      // Match at least 1 strong distinctive token
      for (const inst of institutions) {
        const instLower = inst.name.toLowerCase();
        const firstTokenMatch = tokens.length > 0 && instLower.includes(tokens[0]);
        if (firstTokenMatch) {
          return { id: inst.id, name: inst.name };
        }
      }
    }

    // Retain user's provided school name string
    return {
      id: null,
      name: schoolCollege.trim(),
    };
  }
}
