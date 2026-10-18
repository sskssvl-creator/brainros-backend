import { Test, TestingModule } from '@nestjs/testing';
import { StudentBulkRegistrationService } from './student-bulk-registration.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { OtpService } from '../../auth/services/otp.service';
import { BadRequestException } from '@nestjs/common';

describe('StudentBulkRegistrationService', () => {
  let service: StudentBulkRegistrationService;
  let prismaMock: any;
  let securityEventMock: any;
  let otpServiceMock: any;

  const mockSchool = {
    id: 'school-abc-123',
    name: 'ABC Public School',
    code: 'ABC001',
    status: 'ACTIVE',
  };

  beforeEach(async () => {
    prismaMock = {
      institution: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'school-abc-123') return Promise.resolve(mockSchool);
          if (where.id === 'school-inactive-123')
            return Promise.resolve({ ...mockSchool, id: 'school-inactive-123', status: 'INACTIVE' });
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([mockSchool]),
      },
      institutionAdmin: {
        findFirst: jest.fn().mockResolvedValue({ id: 'admin-link-1' }),
      },
      state: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'state-gujarat-1', name: 'Gujarat', code: 'GJ', isActive: true },
          { id: 'state-maharashtra-1', name: 'Maharashtra', code: 'MH', isActive: true },
        ]),
      },
      district: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'dist-ahmedabad-1', stateId: 'state-gujarat-1', name: 'Ahmedabad', isActive: true },
          { id: 'dist-mumbai-1', stateId: 'state-maharashtra-1', name: 'Mumbai', isActive: true },
        ]),
      },
      studentClass: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'class-12-1', name: '12th' },
          { id: 'class-11-1', name: '11th' },
        ]),
      },
      examTarget: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'target-jee-1', name: 'JEE' },
          { id: 'target-cet-1', name: 'CET' },
          { id: 'target-neet-1', name: 'NEET' },
          { id: 'target-neet-jee-1', name: 'NEET + JEE' },
          { id: 'target-neet-state-cet-1', name: 'NEET + State CET' },
          { id: 'target-jee-state-cet-1', name: 'JEE + State CET' },
          { id: 'target-jee-neet-state-cet-1', name: 'JEE + NEET + State CET' },
        ]),
      },
      preferredLanguage: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'lang-eng-1', name: 'ENGLISH', code: 'en', isActive: true },
          { id: 'lang-hin-1', name: 'HINDI', code: 'hi', isActive: true },
        ]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'user-new-1' }),
      },
      role: {
        findUnique: jest.fn().mockResolvedValue({ id: 'role-student-1', name: 'STUDENT' }),
        create: jest.fn().mockResolvedValue({ id: 'role-student-1', name: 'STUDENT' }),
      },
      userRole: {
        create: jest.fn().mockResolvedValue({ userId: 'user-new-1', roleId: 'role-student-1' }),
      },
      student: {
        count: jest.fn().mockResolvedValue(5),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'student-new-1', studentId: 'STU001006' }),
      },
      studentExamTarget: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bulkUpload: {
        create: jest.fn().mockResolvedValue({ id: 'upload-123', status: 'VALIDATING', institutionId: 'school-abc-123' }),
        update: jest.fn().mockResolvedValue({ id: 'upload-123', status: 'READY_FOR_REVIEW' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'upload-123', institutionId: 'school-abc-123', institution: mockSchool }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      bulkUploadRow: {
        create: jest.fn().mockResolvedValue({ id: 'row-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'row-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      bulkUploadError: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn().mockImplementation((cb) => cb(prismaMock)),
    };

    securityEventMock = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    otpServiceMock = {
      normalizeMobileNumber: jest.fn((m) => (m.startsWith('+') ? m : `+91${m.replace(/\D/g, '')}`)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentBulkRegistrationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: SecurityEventService, useValue: securityEventMock },
        { provide: OtpService, useValue: otpServiceMock },
      ],
    }).compile();

    service = module.get<StudentBulkRegistrationService>(StudentBulkRegistrationService);
  });

  describe('generateTemplate', () => {
    it('should generate CSV template with student headers and NO school_name column', async () => {
      const { buffer, fileName, mimeType } = await service.generateTemplate('csv');
      expect(fileName).toBe('student_bulk_registration_template.csv');
      expect(mimeType).toBe('text/csv');
      expect(buffer.length).toBeGreaterThan(0);
      const content = buffer.toString();
      expect(content).toContain('Full Name');
      expect(content).toContain('Mobile Number');
      expect(content).toContain('State');
      expect(content).toContain('City');
      expect(content).not.toContain('School / College / Institution');
    });

    it('should generate XLSX template without school_name column', async () => {
      const { buffer, fileName, mimeType } = await service.generateTemplate('xlsx');
      expect(fileName).toBe('student_bulk_registration_template.xlsx');
      expect(mimeType).toContain('spreadsheet');
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe('validateFile', () => {
    it('should throw if file is missing', () => {
      expect(() => service.validateFile(null as any)).toThrow(BadRequestException);
    });

    it('should throw if file extension is unsupported', () => {
      const invalidFile = { originalname: 'students.txt', size: 100 } as any;
      expect(() => service.validateFile(invalidFile)).toThrow(/Invalid file format/);
    });

    it('should throw if file size exceeds 10MB', () => {
      const hugeFile = { originalname: 'students.xlsx', size: 15 * 1024 * 1024 } as any;
      expect(() => service.validateFile(hugeFile)).toThrow(/exceeds maximum limit/);
    });
  });

  describe('uploadAndValidate Target Exam & Password Validations', () => {
    it('should accept and validate all 7 combinations using separate boolean columns (jee, cet, neet) with password', async () => {
      const rows = [
        // 1. JEE only
        'John,9876543210,john@example.com,Gujarat,Ahmedabad,12th,Pass1234!,TRUE,FALSE,FALSE,ENGLISH',
        // 2. CET only
        'Rita,9876543211,rita@example.com,Gujarat,Ahmedabad,12th,Pass1234!,FALSE,TRUE,FALSE,ENGLISH',
        // 3. NEET only
        'Rahul,9876543212,rahul@example.com,Gujarat,Ahmedabad,12th,Pass1234!,FALSE,FALSE,TRUE,ENGLISH',
        // 4. NEET + JEE
        'Amit,9876543213,amit@example.com,Gujarat,Ahmedabad,12th,Pass1234!,TRUE,FALSE,TRUE,ENGLISH',
        // 5. NEET + State CET
        'Sneha,9876543214,sneha@example.com,Gujarat,Ahmedabad,12th,Pass1234!,FALSE,TRUE,TRUE,ENGLISH',
        // 6. JEE + State CET
        'Raj,9876543215,raj@example.com,Gujarat,Ahmedabad,12th,Pass1234!,TRUE,TRUE,FALSE,ENGLISH',
        // 7. JEE + NEET + State CET
        'Vikas,9876543216,vikas@example.com,Gujarat,Ahmedabad,12th,Pass1234!,TRUE,TRUE,TRUE,ENGLISH',
      ];

      const csvContent =
        'Full Name,Mobile Number,Email,State,City,Class,Password,jee,cet,neet,Preferred Language\n' +
        rows.join('\n');

      const file = {
        originalname: 'students.csv',
        buffer: Buffer.from(csvContent),
        size: csvContent.length,
      } as any;

      const res = await service.uploadAndValidate(
        file,
        { userId: 'admin-1', roles: ['SUPER_ADMIN'] },
        { schoolId: 'school-abc-123' },
      );

      expect(res.totalRows).toBe(7);
      expect(res.validRows).toBe(7);
      expect(res.invalidRows).toBe(0);
    });

    it('should accept and validate all 7 canonical Target Exam combinations using legacy target column when password is provided', async () => {
      const rows = [
        'John,9876543210,john@example.com,Gujarat,Ahmedabad,12th,Pass1234!,JEE,ENGLISH',
        'Rita,9876543211,rita@example.com,Gujarat,Ahmedabad,12th,Pass1234!,CET,ENGLISH',
        'Rahul,9876543212,rahul@example.com,Gujarat,Ahmedabad,12th,Pass1234!,NEET,ENGLISH',
        'Amit,9876543213,amit@example.com,Gujarat,Ahmedabad,12th,Pass1234!,NEET + JEE,ENGLISH',
        'Sneha,9876543214,sneha@example.com,Gujarat,Ahmedabad,12th,Pass1234!,NEET + State CET,ENGLISH',
        'Raj,9876543215,raj@example.com,Gujarat,Ahmedabad,12th,Pass1234!,JEE + State CET,ENGLISH',
        'Vikas,9876543216,vikas@example.com,Gujarat,Ahmedabad,12th,Pass1234!,JEE + NEET + State CET,ENGLISH',
      ];

      const csvContent =
        'Full Name,Mobile Number,Email,State,City,Class,Password,Exam Target,Preferred Language\n' +
        rows.join('\n');

      const file = {
        originalname: 'students.csv',
        buffer: Buffer.from(csvContent),
        size: csvContent.length,
      } as any;

      const res = await service.uploadAndValidate(
        file,
        { userId: 'admin-1', roles: ['SUPER_ADMIN'] },
        { schoolId: 'school-abc-123' },
      );

      expect(res.totalRows).toBe(7);
      expect(res.validRows).toBe(7);
      expect(res.invalidRows).toBe(0);
    });

    it('should reject missing password with MISSING_PASSWORD', async () => {
      const csvContent =
        'Full Name,Mobile Number,Email,State,City,Class,Password,jee,cet,neet,Preferred Language\n' +
        'NoPass,9876543219,,Gujarat,Ahmedabad,12th,,TRUE,FALSE,FALSE,ENGLISH';

      const file = {
        originalname: 'students.csv',
        buffer: Buffer.from(csvContent),
        size: csvContent.length,
      } as any;

      const res = await service.uploadAndValidate(
        file,
        { userId: 'admin-1', roles: ['SUPER_ADMIN'] },
        { schoolId: 'school-abc-123' },
      );

      expect(res.totalRows).toBe(1);
      expect(res.invalidRows).toBe(1);
    });

    it('should reject row when all three boolean flags are FALSE', async () => {
      const csvContent =
        'Full Name,Mobile Number,Email,State,City,Class,Password,jee,cet,neet,Preferred Language\n' +
        'AllFalse,9876543218,,Gujarat,Ahmedabad,12th,Pass1234!,FALSE,FALSE,FALSE,ENGLISH';

      const file = {
        originalname: 'students.csv',
        buffer: Buffer.from(csvContent),
        size: csvContent.length,
      } as any;

      const res = await service.uploadAndValidate(
        file,
        { userId: 'admin-1', roles: ['SUPER_ADMIN'] },
        { schoolId: 'school-abc-123' },
      );

      expect(res.totalRows).toBe(1);
      expect(res.invalidRows).toBe(1);
    });

    it('should reject invalid Target Exam values with INVALID_EXAM_TARGET', async () => {
      const invalidRows = [
        'User1,9876543220,,Gujarat,Ahmedabad,12th,Pass1234!,JEE + CET,ENGLISH', // 'JEE + CET' is invalid (must be 'JEE + State CET')
        'User2,9876543221,,Gujarat,Ahmedabad,12th,Pass1234!,State CET,ENGLISH', // Standalone 'State CET' is invalid
        'User3,9876543222,,Gujarat,Ahmedabad,12th,Pass1234!,Physics,ENGLISH', // Subject name is invalid
        'User4,9876543223,,Gujarat,Ahmedabad,12th,Pass1234!,JEE + State NEET,ENGLISH', // Invalid combination
        'User5,9876543224,,Gujarat,Ahmedabad,12th,Pass1234!,Random Target,ENGLISH', // Random string is invalid
      ];

      const csvContent =
        'Full Name,Mobile Number,Email,State,City,Class,Password,Exam Target,Preferred Language\n' +
        invalidRows.join('\n');

      const file = {
        originalname: 'students.csv',
        buffer: Buffer.from(csvContent),
        size: csvContent.length,
      } as any;

      const res = await service.uploadAndValidate(
        file,
        { userId: 'admin-1', roles: ['SUPER_ADMIN'] },
        { schoolId: 'school-abc-123' },
      );

      expect(res.totalRows).toBe(5);
      expect(res.validRows).toBe(0);
      expect(res.invalidRows).toBe(5);
    });

    it('should reject empty or whitespace-only Target Exam with MISSING_EXAM_TARGET', async () => {
      const csvContent =
        'Full Name,Mobile Number,Email,State,City,Class,Password,Exam Target,Preferred Language\n' +
        'User1,9876543230,,Gujarat,Ahmedabad,12th,Pass1234!,,ENGLISH\n' +
        'User2,9876543231,,Gujarat,Ahmedabad,12th,Pass1234!,   ,ENGLISH';

      const file = {
        originalname: 'students.csv',
        buffer: Buffer.from(csvContent),
        size: csvContent.length,
      } as any;

      const res = await service.uploadAndValidate(
        file,
        { userId: 'admin-1', roles: ['SUPER_ADMIN'] },
        { schoolId: 'school-abc-123' },
      );

      expect(res.totalRows).toBe(2);
      expect(res.invalidRows).toBe(2);
    });
  });
});
