import { Test, TestingModule } from '@nestjs/testing';
import { BillingService } from './billing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BillPdfService } from './bill-pdf.service';
import { JobProgressService } from '../../job-progress/services/job-progress.service';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('BillingService - Invalid Combinations & Guard Tests', () => {
  let service: BillingService;
  let prisma: any;

  const mockPrisma = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    institution: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    student: {
      count: jest.fn(),
    },
    bill: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(mockPrisma)),
  };

  const mockPdfService = {
    generateBillPdf: jest.fn(),
  };

  const mockQueue = {
    add: jest.fn(),
  };

  const mockJobProgressService = {
    publishStarted: jest.fn(),
    publishProgress: jest.fn(),
    publishCompleted: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BillPdfService, useValue: mockPdfService },
        { provide: 'BullQueue_bill-email', useValue: mockQueue },
        { provide: JobProgressService, useValue: mockJobProgressService },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('1. Duplicate Invoice Generation Guard', () => {
    it('should throw ConflictException if invoice already exists for same school + month + year', async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: 'school-123',
        name: 'Delhi Public School',
      });

      mockPrisma.bill.findUnique.mockResolvedValue({
        id: 'bill-1',
        billNumber: 'INV-202608-0001',
      });

      await expect(
        service.generateInvoice(
          { institutionId: 'school-123', billingMonth: 8, billingYear: 2026 },
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('2. Zero Active Students Protection Guard', () => {
    it('should throw BadRequestException if target school has 0 eligible active students', async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: 'school-456',
        name: 'Empty Academy',
      });

      // Existing bill check returns null (not a duplicate)
      mockPrisma.bill.findUnique.mockResolvedValue(null);

      // Student count returns 0
      mockPrisma.student.count.mockResolvedValue(0);

      await expect(
        service.generateInvoice(
          { institutionId: 'school-456', billingMonth: 8, billingYear: 2026 },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('3. Non-Existent School Protection Guard', () => {
    it('should throw NotFoundException if school ID does not exist', async () => {
      mockPrisma.institution.findUnique.mockResolvedValue(null);

      await expect(
        service.generateInvoice(
          { institutionId: 'non-existent-id', billingMonth: 8, billingYear: 2026 },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('4. Invalid Pricing Rate Guard', () => {
    it('should throw BadRequestException if new price is <= 0', async () => {
      await expect(service.updatePricingSetting(0, 'user-1')).rejects.toThrow(BadRequestException);
      await expect(service.updatePricingSetting(-50, 'user-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('5. Invalid GST Tax Configuration Guard', () => {
    it('should throw BadRequestException if GST rate is negative or exceeds 100%', async () => {
      mockPrisma.systemSetting.findUnique.mockResolvedValue(null);

      await expect(
        service.updateTaxConfiguration({ gstRate: -15 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateTaxConfiguration({ gstRate: 150 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('6. Invalid Email Dispatch Guard', () => {
    it('should throw BadRequestException if school email is missing or invalid', async () => {
      mockPrisma.bill.findUnique.mockResolvedValue({
        id: 'bill-1',
        institution: { name: 'School Without Email', email: null },
      });

      await expect(service.sendBill('bill-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if email dispatch job is already QUEUED or PROCESSING', async () => {
      mockPrisma.bill.findUnique.mockResolvedValue({
        id: 'bill-2',
        emailStatus: 'QUEUED',
        institution: { name: 'Processing School', email: 'billing@school.com' },
      });

      await expect(service.sendBill('bill-2', 'user-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('7. Price Tampering Resistance Guard', () => {
    it('should ignore client-supplied price and use authoritative database price', async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: 'school-100',
        name: 'Shield High School',
        state: 'Karnataka',
      });
      mockPrisma.bill.findUnique.mockResolvedValue(null);
      mockPrisma.bill.findFirst.mockResolvedValue(null);
      mockPrisma.student.count.mockResolvedValue(50);
      mockPrisma.systemSetting.findUnique.mockResolvedValue({ key: 'PRICE_PER_STUDENT_PER_MONTH', value: '350' });

      // Mock institutionPricing query
      mockPrisma.institutionPricing = {
        findFirst: jest.fn().mockResolvedValue({
          institutionId: 'school-100',
          pricePerStudent: 350,
          isActive: true,
        }),
      };

      mockPrisma.bill.create.mockImplementation((args: any) => ({
        id: 'bill-tamper-proof',
        ...args.data,
      }));

      // Client attempts to pass pricePerStudent: 1 (tampering attempt)
      const result = await service.generateInvoice(
        { institutionId: 'school-100', billingMonth: 8, billingYear: 2026, pricePerStudent: 1 },
        'user-1',
      );

      // Price should be authoritative 350, not 1
      expect(result.pricePerStudent).toBe(350);
      expect(result.amount).toBe(50 * 350);
    });
  });

  describe('8. School Price Update Validation Guards', () => {
    it('should throw BadRequestException if school price is <= 0 or NaN', async () => {
      await expect(
        service.updateSchoolPricing('school-1', { pricePerStudent: 0 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateSchoolPricing('school-1', { pricePerStudent: -100 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if school price exceeds 10,00,000', async () => {
      await expect(
        service.updateSchoolPricing('school-1', { pricePerStudent: 2000000 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('9. Automatic Invoice Regeneration on Price Update', () => {
    it('should recalculate and regenerate invoice if and only if an invoice is already generated for the school', async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: 'school-1',
        name: 'Greenwood High',
        code: 'GWH01',
        state: 'Karnataka',
      });

      mockPrisma.institutionPricing = {
        findFirst: jest.fn().mockResolvedValue({ pricePerStudent: 300 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'pricing-1', pricePerStudent: 450 }),
      };

      // Existing generated invoice with 100 students at old price ₹300 = ₹30,000
      mockPrisma.bill.findMany.mockResolvedValue([
        {
          id: 'bill-1',
          billNumber: 'INV-202608-0001',
          institutionId: 'school-1',
          billingMonth: 8,
          billingYear: 2026,
          studentCount: 100,
          pricePerStudent: 300,
          amount: 30000,
          tax: 5400,
          totalAmount: 35400,
          status: 'GENERATED',
          metadata: {},
        },
      ]);

      mockPrisma.systemSetting.findUnique.mockResolvedValue(null);

      const result = await service.updateSchoolPricing(
        'school-1',
        { pricePerStudent: 450, billingMonth: 8, billingYear: 2026 },
        'user-1',
      );

      expect(result.recalculatedCount).toBe(1);
      expect(mockPrisma.bill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bill-1' },
          data: expect.objectContaining({
            pricePerStudent: 450,
            studentCount: 100,
            amount: 45000,
            tax: 8100,
            totalAmount: 53100,
            pdfStorageKey: null,
          }),
        }),
      );
    });

    it('should NOT generate any invoice if no invoice was already generated for that school', async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: 'school-2',
        name: 'National Academy',
        code: 'NA02',
        state: 'Karnataka',
      });

      mockPrisma.institutionPricing = {
        findFirst: jest.fn().mockResolvedValue({ pricePerStudent: 300 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'pricing-2', pricePerStudent: 500 }),
      };

      // No existing bills for school-2
      mockPrisma.bill.findMany.mockResolvedValue([]);

      const result = await service.updateSchoolPricing(
        'school-2',
        { pricePerStudent: 500 },
        'user-1',
      );

      expect(result.recalculatedCount).toBe(0);
      expect(mockPrisma.bill.create).not.toHaveBeenCalled();
      expect(mockPrisma.bill.update).not.toHaveBeenCalled();
    });
  });

  describe('10. Update Bill Payment Status (Paid / Unpaid)', () => {
    it('should update invoice status to PAID and record audit log', async () => {
      mockPrisma.bill.findUnique.mockResolvedValue({
        id: 'bill-10',
        billNumber: 'INV-202608-0010',
        status: 'GENERATED',
        institutionId: 'school-1',
        institution: { name: 'Greenwood High' },
      });

      mockPrisma.bill.update.mockResolvedValue({
        id: 'bill-10',
        billNumber: 'INV-202608-0010',
        status: 'PAID',
        institution: { id: 'school-1', name: 'Greenwood High' },
      });

      const result = await service.updateBillStatus('bill-10', 'PAID', 'user-1');

      expect(result.bill.status).toBe('PAID');
      expect(mockPrisma.bill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bill-10' },
          data: expect.objectContaining({
            status: 'PAID',
            approvedById: 'user-1',
          }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BILL_STATUS_CHANGED',
            entityId: 'bill-10',
          }),
        }),
      );
    });

    it('should update invoice status to UNPAID (GENERATED) when requested', async () => {
      mockPrisma.bill.findUnique.mockResolvedValue({
        id: 'bill-11',
        billNumber: 'INV-202608-0011',
        status: 'PAID',
        institutionId: 'school-1',
        institution: { name: 'Greenwood High' },
      });

      mockPrisma.bill.update.mockResolvedValue({
        id: 'bill-11',
        billNumber: 'INV-202608-0011',
        status: 'GENERATED',
        institution: { id: 'school-1', name: 'Greenwood High' },
      });

      const result = await service.updateBillStatus('bill-11', 'UNPAID', 'user-1');

      expect(result.bill.status).toBe('GENERATED');
      expect(mockPrisma.bill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bill-11' },
          data: expect.objectContaining({
            status: 'GENERATED',
          }),
        }),
      );
    });
  });
});
