import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { BillPdfService } from './bill-pdf.service';
import {
  CreateBillDto,
  UpdateBillDto,
  RejectBillDto,
  BillFilterDto,
  GenerateInvoiceDto,
  UpdateSchoolPricingDto,
  SendBulkInvoicesDto,
} from '../dto/billing.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BillEmailProcessor } from '../processors/bill-email.processor';
import { JobProgressService } from '../../job-progress/services/job-progress.service';

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DEFAULT_PRICE_PER_STUDENT = 300;
const PRICING_SETTING_KEY = 'PRICE_PER_STUDENT_PER_MONTH';
const TAX_CONFIG_SETTING_KEY = 'BILLING_TAX_CONFIGURATION';

export const GST_STATE_CODES: Record<string, string> = {
  'JAMMU AND KASHMIR': '01',
  'HIMACHAL PRADESH': '02',
  'PUNJAB': '03',
  'CHANDIGARH': '04',
  'UTTARAKHAND': '05',
  'HARYANA': '06',
  'DELHI': '07',
  'RAJASTHAN': '08',
  'UTTAR PRADESH': '09',
  'BIHAR': '10',
  'SIKKIM': '11',
  'ARUNACHAL PRADESH': '12',
  'NAGALAND': '13',
  'MANIPUR': '14',
  'MIZORAM': '15',
  'TRIPURA': '16',
  'MEGHALAYA': '17',
  'ASSAM': '18',
  'WEST BENGAL': '19',
  'JHARKHAND': '20',
  'ODISHA': '21',
  'CHHATTISGARH': '22',
  'MADHYA PRADESH': '23',
  'GUJARAT': '24',
  'DAMAN AND DIU': '25',
  'DADRA AND NAGAR HAVELI': '26',
  'MAHARASHTRA': '27',
  'ANDHRA PRADESH': '37',
  'KARNATAKA': '29',
  'GOA': '30',
  'LAKSHADWEEP': '31',
  'KERALA': '32',
  'TAMIL NADU': '33',
  'PUDUCHERRY': '34',
  'ANDAMAN AND NICOBAR ISLANDS': '35',
  'TELANGANA': '36',
  'LADAKH': '38',
  'OTHER TERRITORY': '97',
};

export interface TaxConfigurationData {
  taxName: string;
  hsnSacCode: string;
  gstRate: number;
  cessRate: number;
  isGstEnabled: boolean;
  reverseCharge: boolean;
  supplierLegalName: string;
  supplierTradeName: string;
  supplierGstin: string;
  supplierPan: string;
  supplierState: string;
  supplierStateCode: string;
  supplierAddress: string;
  supplierEmail: string;
  supplierPhone: string;
  bankName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  bankBranch: string;
  additionalCharges?: any[];
}

export const DEFAULT_TAX_CONFIG: TaxConfigurationData = {
  taxName: 'Goods and Services Tax (GST)',
  hsnSacCode: '999293',
  gstRate: 18,
  cessRate: 0,
  isGstEnabled: true,
  reverseCharge: false,
  supplierLegalName: 'Brainros Educational Technologies Pvt. Ltd.',
  supplierTradeName: 'Brainros',
  supplierGstin: '29AABCB1234F1Z5',
  supplierPan: 'AABCB1234F',
  supplierState: 'Karnataka',
  supplierStateCode: '29',
  supplierAddress: 'Tech Park, Outer Ring Road, Bangalore - 560103, Karnataka',
  supplierEmail: 'billing@brainros.com',
  supplierPhone: '+91 90000 00000',
  bankName: 'HDFC Bank',
  bankAccountNumber: '50200012345678',
  bankIfsc: 'HDFC0001234',
  bankBranch: 'Koramangala, Bangalore',
  additionalCharges: [],
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: BillPdfService,
    @InjectQueue('bill-email')
    private readonly billEmailQueue: Queue,
    private readonly jobProgressService: JobProgressService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * ── CENTRALIZED PRICING CONFIGURATION ──────────────────────────
   * Default: ₹300 per student per month.
   * Can be configured by Super Admin; stored in system_settings table.
   */
  async getPricingSetting(): Promise<number> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: PRICING_SETTING_KEY },
    });
    if (!setting) {
      return DEFAULT_PRICE_PER_STUDENT;
    }
    const parsed = Number(setting.value);
    return isNaN(parsed) || parsed <= 0 ? DEFAULT_PRICE_PER_STUDENT : parsed;
  }

  async updatePricingSetting(
    newPrice: number,
    userId: string,
  ): Promise<{ pricePerStudent: number; message: string }> {
    if (!newPrice || isNaN(newPrice) || newPrice <= 0) {
      throw new BadRequestException('Invalid pricing rate. Price must be greater than zero.');
    }

    const oldPrice = await this.getPricingSetting();

    await this.prisma.systemSetting.upsert({
      where: { key: PRICING_SETTING_KEY },
      create: {
        key: PRICING_SETTING_KEY,
        value: String(newPrice),
        description: 'Centralized default price per student per month for institutional billing',
        updatedById: userId,
      },
      update: {
        value: String(newPrice),
        updatedById: userId,
      },
    });

    // Price Audit Log
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'PRICE_PER_STUDENT_CHANGED',
        entityType: 'SYSTEM_SETTING',
        entityId: PRICING_SETTING_KEY,
        beforeState: { pricePerStudent: oldPrice },
        afterState: { pricePerStudent: newPrice },
        metadata: {
          oldPrice,
          newPrice,
          changedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.log(
      `Billing price per student updated from ₹${oldPrice} to ₹${newPrice} by user '${userId}'`,
    );

    return {
      pricePerStudent: newPrice,
      message: `Price per student per month updated to ₹${newPrice}. Future invoices will use this rate; historical invoices remain strictly unaffected.`,
    };
  }

  /**
   * ── SCHOOL-SPECIFIC PRICING RESOLUTION ───────────────────────────
   * Resolves the active price per student for a specific institution.
   * Checks institution_pricings first; falls back to system setting rate.
   */
  async getSchoolPrice(institutionId: string, forDate: Date = new Date()): Promise<number> {
    const pricing = await (this.prisma as any).institutionPricing.findFirst({
      where: {
        institutionId,
        isActive: true,
        effectiveFrom: { lte: forDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: forDate } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });

    if (pricing && pricing.pricePerStudent > 0) {
      return pricing.pricePerStudent;
    }

    return this.getPricingSetting();
  }

  /**
   * ── GET ALL SCHOOL PRICINGS ──────────────────────────────────────
   * Returns list of all institutions with their current active pricing.
   */
  async getSchoolPricings() {
    const institutions = await this.prisma.institution.findMany({
      where: { status: { in: ['ACTIVE', 'APPROVED', 'DRAFT'] } },
      select: {
        id: true,
        name: true,
        code: true,
        email: true,
        phone: true,
        city: true,
        state: true,
        pricings: {
          where: { isActive: true },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          take: 1,
          include: {
            updatedBy: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const defaultPrice = await this.getPricingSetting();

    return institutions.map((inst: any) => {
      const activePricing = inst.pricings?.[0];
      return {
        institutionId: inst.id,
        name: inst.name,
        code: inst.code,
        email: inst.email,
        phone: inst.phone,
        city: inst.city,
        state: inst.state,
        pricePerStudent: activePricing ? activePricing.pricePerStudent : defaultPrice,
        currency: activePricing?.currency || 'INR',
        effectiveFrom: activePricing?.effectiveFrom || null,
        effectiveTo: activePricing?.effectiveTo || null,
        isActive: activePricing?.isActive ?? true,
        isCustom: Boolean(activePricing),
        updatedBy: activePricing?.updatedBy || null,
        updatedAt: activePricing?.updatedAt || null,
      };
    });
  }

  /**
   * ── GET PRICING FOR A SPECIFIC SCHOOL ───────────────────────────
   */
  async getSchoolPricing(institutionId: string) {
    const institution = await this.prisma.institution.findUnique({
      where: { id: institutionId },
      include: {
        pricings: {
          orderBy: { effectiveFrom: 'desc' },
          include: {
            updatedBy: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!institution) {
      throw new NotFoundException(`School/Institution '${institutionId}' not found.`);
    }

    const defaultPrice = await this.getPricingSetting();
    const activePricing = institution.pricings.find((p: any) => p.isActive);

    return {
      institutionId: institution.id,
      name: institution.name,
      code: institution.code,
      currentPrice: activePricing ? activePricing.pricePerStudent : defaultPrice,
      isCustom: Boolean(activePricing),
      activePricing: activePricing || null,
      history: institution.pricings,
    };
  }

  /**
   * ── UPDATE SCHOOL-SPECIFIC PRICING ──────────────────────────────
   */
  async updateSchoolPricing(
    institutionId: string,
    dto: UpdateSchoolPricingDto,
    userId: string,
  ) {
    const rawPrice = dto.pricePerStudent ?? dto.price;
    if (rawPrice === undefined || rawPrice === null || isNaN(Number(rawPrice)) || Number(rawPrice) <= 0) {
      throw new BadRequestException('Invalid pricing rate. Price must be greater than zero.');
    }

    const priceNumber = Number(rawPrice);
    if (priceNumber > 1000000) {
      throw new BadRequestException('Price per student cannot exceed ₹10,00,000.');
    }

    const finalPrice = Math.round(priceNumber * 100) / 100;

    const institution = await this.prisma.institution.findUnique({
      where: { id: institutionId },
    });

    if (!institution) {
      throw new NotFoundException(`School/Institution '${institutionId}' not found.`);
    }

    const oldPrice = await this.getSchoolPrice(institutionId);
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;

    return this.prisma.$transaction(async (tx) => {
      // Deactivate previous active pricing records
      await (tx as any).institutionPricing.updateMany({
        where: { institutionId, isActive: true },
        data: { isActive: false, effectiveTo: effectiveFrom },
      });

      // Insert new active pricing record
      const newPricing = await (tx as any).institutionPricing.create({
        data: {
          institutionId,
          pricePerStudent: finalPrice,
          currency: 'INR',
          effectiveFrom,
          effectiveTo,
          isActive: dto.isActive ?? true,
          updatedById: userId,
        },
        include: {
          updatedBy: { select: { id: true, name: true, email: true } },
        },
      });

      // Price Audit Log
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'SCHOOL_PRICE_CHANGED',
          entityType: 'INSTITUTION',
          entityId: institutionId,
          beforeState: { pricePerStudent: oldPrice },
          afterState: { pricePerStudent: finalPrice },
          metadata: {
            schoolName: institution.name,
            schoolCode: institution.code,
            oldPrice,
            newPrice: finalPrice,
            effectiveFrom: effectiveFrom.toISOString(),
            changedAt: new Date().toISOString(),
          },
        },
      });

      // Recalculate & regenerate already generated invoices for this school (if and only if already generated)
      const existingBillsWhere: any = {
        institutionId,
        status: { not: 'REJECTED' },
      };

      if (dto.billingYear && dto.billingMonth) {
        existingBillsWhere.billingYear = dto.billingYear;
        existingBillsWhere.billingMonth = dto.billingMonth;
      }

      const existingBills = await tx.bill.findMany({
        where: existingBillsWhere,
      });

      let recalculatedCount = 0;
      const taxConfig = await this.getTaxConfiguration();

      for (const bill of existingBills) {
        const studentCount = bill.studentCount > 0 ? bill.studentCount : await this.countEligibleStudents(institutionId);
        const taxableAmount = Math.round(studentCount * finalPrice * 100) / 100;
        const taxDetails = this.calculateTaxForInstitution(taxableAmount, institution, taxConfig);

        const updatedMetadata = {
          ...(typeof bill.metadata === 'object' && bill.metadata !== null ? (bill.metadata as Record<string, any>) : {}),
          taxSnapshot: {
            ...taxDetails,
            taxConfig,
            recalculatedAt: new Date().toISOString(),
            previousPrice: bill.pricePerStudent,
            newPrice: finalPrice,
          },
          lastPriceRecalculatedAt: new Date().toISOString(),
        };

        await tx.bill.update({
          where: { id: bill.id },
          data: {
            pricePerStudent: finalPrice,
            studentCount,
            amount: taxableAmount,
            tax: taxDetails.totalTax,
            totalAmount: taxDetails.grandTotal,
            pdfStorageKey: null,
            metadata: JSON.parse(JSON.stringify(updatedMetadata)),
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'INVOICE_RECALCULATED_ON_PRICE_UPDATE',
            entityType: 'BILL',
            entityId: bill.id,
            beforeState: {
              billNumber: bill.billNumber,
              pricePerStudent: bill.pricePerStudent,
              amount: bill.amount,
              tax: bill.tax,
              totalAmount: bill.totalAmount,
            },
            afterState: {
              billNumber: bill.billNumber,
              pricePerStudent: finalPrice,
              amount: taxableAmount,
              tax: taxDetails.totalTax,
              totalAmount: taxDetails.grandTotal,
            },
            metadata: {
              billNumber: bill.billNumber,
              institutionId,
              schoolName: institution.name,
              oldPrice: bill.pricePerStudent,
              newPrice: finalPrice,
              studentCount,
              taxableAmount,
              totalTax: taxDetails.totalTax,
              grandTotal: taxDetails.grandTotal,
              reason: 'Automatic regeneration on school price update',
              timestamp: new Date().toISOString(),
            },
          },
        });

        recalculatedCount++;
      }

      this.logger.log(
        `School pricing for '${institution.name}' updated from ₹${oldPrice} to ₹${finalPrice} by user '${userId}'. Regenerated ${recalculatedCount} existing invoice(s).`,
      );

      const message = recalculatedCount > 0
        ? `Pricing updated to ₹${finalPrice}/student. Regenerated ${recalculatedCount} existing invoice(s) with new rate.`
        : `Pricing updated to ₹${finalPrice}/student.`;

      return {
        pricing: newPricing,
        recalculatedCount,
        message,
      };
    });
  }

  /**
   * ── DYNAMIC INDIAN GST & TAX CONFIGURATION ─────────────────────
   */
  async getTaxConfiguration(): Promise<TaxConfigurationData> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: TAX_CONFIG_SETTING_KEY },
    });

    if (!setting || !setting.value) {
      return DEFAULT_TAX_CONFIG;
    }

    try {
      const parsed = JSON.parse(setting.value);
      return {
        ...DEFAULT_TAX_CONFIG,
        ...parsed,
      };
    } catch {
      return DEFAULT_TAX_CONFIG;
    }
  }

  async updateTaxConfiguration(
    dto: Partial<TaxConfigurationData>,
    userId: string,
  ): Promise<{ taxConfiguration: TaxConfigurationData; message: string }> {
    const current = await this.getTaxConfiguration();
    const updated: TaxConfigurationData = {
      ...current,
      ...dto,
    };

    if (updated.gstRate < 0 || updated.gstRate > 100) {
      throw new BadRequestException('GST rate must be between 0% and 100%.');
    }

    await this.prisma.systemSetting.upsert({
      where: { key: TAX_CONFIG_SETTING_KEY },
      create: {
        key: TAX_CONFIG_SETTING_KEY,
        value: JSON.stringify(updated),
        description: 'Dynamic Indian GST & tax compliance configuration for institutional invoices',
        updatedById: userId,
      },
      update: {
        value: JSON.stringify(updated),
        updatedById: userId,
      },
    });

    // Audit Log for Tax Config change
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'TAX_CONFIGURATION_CHANGED',
        entityType: 'SYSTEM_SETTING',
        entityId: TAX_CONFIG_SETTING_KEY,
        beforeState: current as any,
        afterState: updated as any,
        metadata: {
          changedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.log(`GST Tax Configuration updated by user '${userId}'`);

    return {
      taxConfiguration: updated,
      message: 'Indian GST & Tax Configuration updated successfully. Future invoices will adhere to this tax structure.',
    };
  }

  /**
   * Calculates compliant GST taxes based on intra-state vs inter-state supply rules
   */
  public calculateTaxForInstitution(
    taxableAmount: number,
    institution: any,
    config: TaxConfigurationData,
  ) {
    if (!config.isGstEnabled || config.gstRate <= 0) {
      return {
        taxableAmount,
        isInterState: false,
        cgstRate: 0,
        cgstAmount: 0,
        sgstRate: 0,
        sgstAmount: 0,
        igstRate: 0,
        igstAmount: 0,
        cessRate: 0,
        cessAmount: 0,
        totalTax: 0,
        grandTotal: taxableAmount,
        placeOfSupply: institution?.state || config.supplierState,
        placeOfSupplyCode: config.supplierStateCode,
        hsnSacCode: config.hsnSacCode,
        reverseCharge: config.reverseCharge,
      };
    }

    const rawState = (institution?.stateRef?.name || institution?.state || config.supplierState || 'Karnataka').trim();
    const normalizedState = rawState.toUpperCase();
    const stateCode =
      institution?.stateRef?.code ||
      GST_STATE_CODES[normalizedState] ||
      (normalizedState === config.supplierState.toUpperCase() ? config.supplierStateCode : '97');

    const supplierStateCode = (config.supplierStateCode || '29').trim();
    const isInterState = stateCode !== supplierStateCode;

    let cgstRate = 0;
    let cgstAmount = 0;
    let sgstRate = 0;
    let sgstAmount = 0;
    let igstRate = 0;
    let igstAmount = 0;

    if (!isInterState) {
      cgstRate = Math.round((config.gstRate / 2) * 100) / 100;
      sgstRate = Math.round((config.gstRate / 2) * 100) / 100;
      cgstAmount = Math.round(((taxableAmount * cgstRate) / 100) * 100) / 100;
      sgstAmount = Math.round(((taxableAmount * sgstRate) / 100) * 100) / 100;
    } else {
      igstRate = config.gstRate;
      igstAmount = Math.round(((taxableAmount * igstRate) / 100) * 100) / 100;
    }

    const cessRate = config.cessRate || 0;
    const cessAmount = cessRate > 0 ? Math.round(((taxableAmount * cessRate) / 100) * 100) / 100 : 0;

    const totalTax = Math.round((cgstAmount + sgstAmount + igstAmount + cessAmount) * 100) / 100;
    const grandTotal = Math.round((taxableAmount + totalTax) * 100) / 100;

    return {
      taxableAmount,
      isInterState,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate,
      igstAmount,
      cessRate,
      cessAmount,
      totalTax,
      grandTotal,
      placeOfSupply: rawState,
      placeOfSupplyCode: stateCode,
      hsnSacCode: config.hsnSacCode,
      reverseCharge: config.reverseCharge,
    };
  }

  /**
   * ── DYNAMIC STUDENT COUNT ELIGIBILITY ──────────────────────────
   * Counts verified active students linked to this institution.
   * Inactive, suspended, deleted, or unverified students are excluded.
   */
  async countEligibleStudents(institutionId: string): Promise<number> {
    return this.prisma.student.count({
      where: {
        institutionId,
        status: 'ACTIVE',
        user: { isActive: true },
      },
    });
  }

  /**
   * Generates a unique, sequential server-side invoice number: INV-YYYYMM-XXXX
   */
  private async generateInvoiceNumber(billingYear?: number, billingMonth?: number): Promise<string> {
    const now = new Date();
    const year = billingYear || now.getFullYear();
    const month = billingMonth || now.getMonth() + 1;
    const yearMonth = `${year}${String(month).padStart(2, '0')}`;
    const prefix = `INV-${yearMonth}-`;

    const latest = await this.prisma.bill.findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: 'desc' },
      select: { billNumber: true },
    });

    let sequence = 1;
    if (latest && latest.billNumber) {
      const parts = latest.billNumber.split('-');
      const lastSeq = parseInt(parts[2] || '0', 10);
      if (!isNaN(lastSeq)) {
        sequence = lastSeq + 1;
      }
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  /**
   * Generates a unique sequential manual bill number: BILL-YYYYMM-XXXX
   */
  private async generateBillNumber(): Promise<string> {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `BILL-${yearMonth}-`;

    const latest = await this.prisma.bill.findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: 'desc' },
      select: { billNumber: true },
    });

    let sequence = 1;
    if (latest && latest.billNumber) {
      const parts = latest.billNumber.split('-');
      const lastSeq = parseInt(parts[2] || '0', 10);
      if (!isNaN(lastSeq)) {
        sequence = lastSeq + 1;
      }
    }

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  /**
   * Validates if a user is authorized to manage billing for an institution.
   */
  private async assertInstitutionScope(userId: string, userRoles: string[], institutionId: string) {
    if (userRoles.includes('SUPER_ADMIN')) {
      return;
    }

    const adminRecord = await this.prisma.institutionAdmin.findFirst({
      where: { userId, isActive: true },
    });

    if (adminRecord && adminRecord.institutionId !== institutionId) {
      throw new ForbiddenException(
        'Access denied. You are not authorized to manage billing for this school.',
      );
    }
  }

  /**
   * ── INVOICE PREVIEW ─────────────────────────────────────────────
   * Calculates live student count, taxable subtotal, GST breakdown, and grand total.
   */
  async getInvoicePreview(
    institutionId: string,
    billingMonth: number,
    billingYear: number,
    customPrice?: number,
  ) {
    const institution = await this.prisma.institution.findUnique({
      where: { id: institutionId },
      select: {
        id: true,
        name: true,
        code: true,
        email: true,
        phone: true,
        city: true,
        state: true,
        stateRef: { select: { id: true, name: true, code: true } },
      },
    });

    if (!institution) {
      throw new NotFoundException(`School/Institution '${institutionId}' not found.`);
    }

    const studentCount = await this.countEligibleStudents(institutionId);
    const schoolPrice = await this.getSchoolPrice(institutionId);
    const pricePerStudent = typeof customPrice === 'number' && customPrice >= 0 ? customPrice : schoolPrice;
    const taxableAmount = studentCount * pricePerStudent;
    const taxConfig = await this.getTaxConfiguration();
    const taxDetails = this.calculateTaxForInstitution(taxableAmount, institution, taxConfig);

    const existingInvoice = await this.prisma.bill.findUnique({
      where: {
        institutionId_billingYear_billingMonth: {
          institutionId,
          billingYear,
          billingMonth,
        },
      },
      select: { id: true, billNumber: true, totalAmount: true, status: true, emailStatus: true },
    });

    return {
      institution,
      billingMonth,
      billingYear,
      periodLabel: `${MONTH_NAMES[billingMonth]} ${billingYear}`,
      studentCount,
      pricePerStudent,
      taxableAmount,
      amount: taxableAmount,
      tax: taxDetails.totalTax,
      totalAmount: taxDetails.grandTotal,
      taxDetails,
      taxConfig,
      alreadyGenerated: Boolean(existingInvoice),
      existingInvoice,
    };
  }

  /**
   * ── GENERATE SCHOOL INVOICE ─────────────────────────────────────
   * Generates invoice for a specific school and billing period.
   * Stores price snapshot (pricePerStudent), studentCount, and immutable GST tax snapshot.
   */
  async generateInvoice(dto: GenerateInvoiceDto, userId: string) {
    const { institutionId, billingMonth, billingYear } = dto;

    if (!institutionId) {
      throw new BadRequestException('School/Institution is required for single invoice generation.');
    }

    const institution = await this.prisma.institution.findUnique({
      where: { id: institutionId },
      include: {
        stateRef: { select: { id: true, name: true, code: true } },
      },
    });

    if (!institution) {
      throw new NotFoundException(`School/Institution '${institutionId}' not found.`);
    }

    // Duplicate invoice protection
    const existing = await this.prisma.bill.findUnique({
      where: {
        institutionId_billingYear_billingMonth: {
          institutionId,
          billingYear,
          billingMonth,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Invoice for ${institution.name} for ${MONTH_NAMES[billingMonth]} ${billingYear} already exists (${existing.billNumber}).`,
      );
    }

    // Dynamic eligible student count
    const studentCount = await this.countEligibleStudents(institutionId);
    if (studentCount === 0) {
      throw new BadRequestException(
        `Cannot generate invoice: School '${institution.name}' has no eligible active students for ${MONTH_NAMES[billingMonth]} ${billingYear}.`,
      );
    }

    // Current school-specific price snapshot and dynamic GST calculation
    const billingPeriodDate = new Date(billingYear, billingMonth - 1, 28);
    const pricePerStudent = await this.getSchoolPrice(institutionId, billingPeriodDate);
    const taxableAmount = studentCount * pricePerStudent;
    const taxConfig = await this.getTaxConfiguration();
    const taxDetails = this.calculateTaxForInstitution(taxableAmount, institution, taxConfig);

    const billNumber = await this.generateInvoiceNumber(billingYear, billingMonth);
    const periodLabel = `${MONTH_NAMES[billingMonth]} ${billingYear}`;

    const taxSnapshot = {
      ...taxDetails,
      taxConfig,
      calculatedAt: new Date().toISOString(),
    };

    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.create({
        data: {
          billNumber,
          institutionId,
          createdById: userId,
          billDate: new Date(),
          billingMonth,
          billingYear,
          studentCount,
          pricePerStudent,
          amount: taxableAmount,
          tax: taxDetails.totalTax,
          totalAmount: taxDetails.grandTotal,
          status: 'GENERATED',
          emailStatus: 'IDLE',
          description: `Student Platform Subscription (${periodLabel})`,
          metadata: JSON.parse(JSON.stringify({ taxSnapshot })),
        },
        include: {
          institution: { select: { id: true, name: true, code: true, email: true, phone: true } },
          createdBy: { select: { id: true, name: true, mobileNumber: true, email: true } },
        },
      });

      // Audit Log for Invoice Generation
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'INVOICE_GENERATED',
          entityType: 'BILL',
          entityId: bill.id,
          afterState: {
            billNumber: bill.billNumber,
            institutionId: bill.institutionId,
            billingMonth,
            billingYear,
            studentCount,
            pricePerStudent,
            amount: taxableAmount,
            tax: taxDetails.totalTax,
            totalAmount: taxDetails.grandTotal,
            status: 'GENERATED',
          },
          metadata: {
            schoolName: institution.name,
            studentCount,
            pricePerStudent,
            taxableAmount,
            totalTax: taxDetails.totalTax,
            totalAmount: taxDetails.grandTotal,
            isInterState: taxDetails.isInterState,
            billingPeriod: periodLabel,
          },
        },
      });

      this.logger.log(
        `Generated GST invoice ${billNumber} for ${institution.name}: ${studentCount} students × ₹${pricePerStudent} = ₹${taxableAmount} + GST ₹${taxDetails.totalTax} = ₹${taxDetails.grandTotal}`,
      );

      return bill;
    });
  }

  /**
   * ── BULK INVOICE GENERATION ─────────────────────────────────────
   * Generates invoices for all active institutions for a billing month/year.
   * Reports live WebSocket progress through JobProgressService.
   */
  async generateBulkInvoices(dto: GenerateInvoiceDto, userId: string) {
    const { billingMonth, billingYear } = dto;
    const periodLabel = `${MONTH_NAMES[billingMonth]} ${billingYear}`;
    const periodDate = new Date(billingYear, billingMonth - 1, 28);
    const defaultPrice = await this.getPricingSetting();
    const taxConfig = await this.getTaxConfiguration();

    const institutions = await this.prisma.institution.findMany({
      where: { status: { in: ['ACTIVE', 'APPROVED'] } },
      include: { stateRef: { select: { id: true, name: true, code: true } } },
      orderBy: { name: 'asc' },
    });

    const totalSchools = institutions.length;
    const instIds = institutions.map((i) => i.id);
    const jobId = `bulk_invoice_${billingYear}_${billingMonth}_${Date.now()}`;

    await this.jobProgressService.publishStarted(
      'bulk-invoices',
      jobId,
      'INVOICE_GENERATION',
      `Generating invoices for ${totalSchools} schools (${periodLabel})...`,
      { totalSchools, billingMonth, billingYear },
    );

    // 1. Batch pre-fetch active custom pricings across candidate institutions for this billing period
    const customPricings = await (this.prisma as any).institutionPricing.findMany({
      where: {
        institutionId: { in: instIds },
        isActive: true,
        effectiveFrom: { lte: periodDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodDate } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    const pricingMap = new Map<string, number>();
    for (const p of customPricings) {
      if (!pricingMap.has(p.institutionId) && p.pricePerStudent > 0) {
        pricingMap.set(p.institutionId, p.pricePerStudent);
      }
    }

    // 2. Batch pre-fetch existing bills for this period across all candidate institutions
    const existingBills = await this.prisma.bill.findMany({
      where: {
        billingYear,
        billingMonth,
        institutionId: { in: instIds },
      },
      select: { institutionId: true },
    });
    const existingInstitutionIds = new Set(existingBills.map((b) => b.institutionId));

    // 3. Batch pre-aggregate student counts across all candidate institutions
    const studentCountGroups = await this.prisma.student.groupBy({
      by: ['institutionId'],
      where: {
        institutionId: { in: instIds },
        status: 'ACTIVE',
        user: { isActive: true },
      },
      _count: { _all: true },
    });
    const studentCountMap = new Map<string, number>();
    for (const sc of studentCountGroups) {
      if (sc.institutionId) {
        studentCountMap.set(sc.institutionId, sc._count._all);
      }
    }

    // 4. Determine starting invoice sequence for this period
    const yearMonth = `${billingYear}${String(billingMonth).padStart(2, '0')}`;
    const invoicePrefix = `INV-${yearMonth}-`;
    const latestBill = await this.prisma.bill.findFirst({
      where: { billNumber: { startsWith: invoicePrefix } },
      orderBy: { billNumber: 'desc' },
      select: { billNumber: true },
    });
    let currentSequence = 1;
    if (latestBill && latestBill.billNumber) {
      const parts = latestBill.billNumber.split('-');
      const lastSeq = parseInt(parts[2] || '0', 10);
      if (!isNaN(lastSeq)) {
        currentSequence = lastSeq + 1;
      }
    }

    let generatedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    // Process iteratively with real-time WebSocket progress
    for (let i = 0; i < totalSchools; i++) {
      const inst = institutions[i];
      try {
        if (existingInstitutionIds.has(inst.id)) {
          skippedCount++;
        } else {
          const studentCount = studentCountMap.get(inst.id) || 0;
          if (studentCount === 0) {
            skippedCount++;
          } else {
            const schoolPrice = pricingMap.get(inst.id) || defaultPrice;
            const taxableAmount = studentCount * schoolPrice;
            const taxDetails = this.calculateTaxForInstitution(taxableAmount, inst, taxConfig);
            const billNumber = `${invoicePrefix}${String(currentSequence++).padStart(4, '0')}`;

            const taxSnapshot = {
              ...taxDetails,
              taxConfig,
              calculatedAt: new Date().toISOString(),
            };

            await this.prisma.bill.create({
              data: {
                billNumber,
                institutionId: inst.id,
                createdById: userId,
                billDate: new Date(),
                billingMonth,
                billingYear,
                studentCount,
                pricePerStudent: schoolPrice,
                amount: taxableAmount,
                tax: taxDetails.totalTax,
                totalAmount: taxDetails.grandTotal,
                status: 'GENERATED',
                emailStatus: 'IDLE',
                description: `Student Platform Subscription (${periodLabel})`,
                metadata: JSON.parse(JSON.stringify({ taxSnapshot })),
              },
            });

            generatedCount++;
          }
        }
      } catch (err: any) {
        errors.push(`${inst.name}: ${err.message}`);
      }

      await this.jobProgressService.publishProgress(
        'bulk-invoices',
        jobId,
        i + 1,
        totalSchools,
        {
          stage: 'GENERATING_INVOICES',
          message: `${i + 1} / ${totalSchools} schools processed (${Math.round(((i + 1) / totalSchools) * 100)}%)`,
          currentSchool: inst.name,
        },
      );
    }

    await this.jobProgressService.publishCompleted(
      'bulk-invoices',
      jobId,
      `Invoice generation completed: ${generatedCount} generated, ${skippedCount} skipped.`,
      { generatedCount, skippedCount, errorsCount: errors.length },
    );

    return {
      jobId,
      totalSchools,
      generatedCount,
      skippedCount,
      errors,
    };
  }

  /**
   * ── CREATE MANUAL BILL (Staff / Legacy) ─────────────────────────
   */
  async createBill(dto: CreateBillDto, userId: string, userRoles: string[]) {
    await this.assertInstitutionScope(userId, userRoles, dto.institutionId);

    const institution = await this.prisma.institution.findUnique({
      where: { id: dto.institutionId },
    });

    if (!institution) {
      throw new NotFoundException(`School/Institution '${dto.institutionId}' not found.`);
    }

    const amount = Number(dto.amount);
    const tax = Number(dto.tax || 0);
    const totalAmount = Math.round((amount + tax) * 100) / 100;

    const billNumber = await this.generateBillNumber();
    const billDate = dto.billDate ? new Date(dto.billDate) : new Date();
    const initialStatus = dto.submitImmediately ? 'PENDING_APPROVAL' : 'DRAFT';

    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.create({
        data: {
          billNumber,
          institutionId: dto.institutionId,
          createdById: userId,
          billDate,
          description: dto.description.trim(),
          amount,
          tax,
          totalAmount,
          status: initialStatus as any,
          emailStatus: 'IDLE',
        },
        include: {
          institution: { select: { id: true, name: true, code: true, email: true } },
          createdBy: { select: { id: true, name: true, mobileNumber: true, email: true } },
        },
      });

      // Audit Log for Bill creation
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'BILL_CREATED',
          entityType: 'BILL',
          entityId: bill.id,
          afterState: {
            billNumber: bill.billNumber,
            institutionId: bill.institutionId,
            totalAmount: bill.totalAmount,
            status: bill.status,
          },
          metadata: {
            schoolName: institution.name,
            amount,
            tax,
            totalAmount,
            status: initialStatus,
          },
        },
      });

      if (dto.submitImmediately) {
        await tx.approvalRequest.create({
          data: {
            resourceType: 'BILL',
            resourceId: bill.id,
            requestedById: userId,
            status: 'PENDING',
            metadata: {
              billNumber: bill.billNumber,
              schoolName: institution.name,
              totalAmount: bill.totalAmount,
              submittedAt: new Date().toISOString(),
            },
          },
        });

        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'BILL_SUBMITTED',
            entityType: 'BILL',
            entityId: bill.id,
            afterState: { status: 'PENDING_APPROVAL' },
            metadata: { billNumber: bill.billNumber },
          },
        });
      }

      this.logger.log(`Bill '${bill.billNumber}' created with status '${initialStatus}' by '${userId}'`);
      return bill;
    });
  }

  /**
   * ── SUBMIT DRAFT BILL ──────────────────────────────────────────
   */
  async submitBill(billId: string, userId: string, userRoles: string[]) {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { institution: true },
    });

    if (!bill) {
      throw new NotFoundException(`Bill '${billId}' not found.`);
    }

    if (!userRoles.includes('SUPER_ADMIN') && bill.createdById !== userId) {
      throw new ForbiddenException('You are not authorized to submit this bill.');
    }

    if (bill.status !== 'DRAFT') {
      throw new BadRequestException(
        `Cannot submit bill with status '${bill.status}'. Only DRAFT bills can be submitted.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.bill.update({
        where: { id: billId },
        data: { status: 'PENDING_APPROVAL' },
        include: {
          institution: { select: { id: true, name: true, code: true, email: true } },
          createdBy: { select: { id: true, name: true, mobileNumber: true, email: true } },
        },
      });

      await tx.approvalRequest.create({
        data: {
          resourceType: 'BILL',
          resourceId: bill.id,
          requestedById: userId,
          status: 'PENDING',
          metadata: {
            billNumber: bill.billNumber,
            schoolName: bill.institution.name,
            totalAmount: bill.totalAmount,
            submittedAt: new Date().toISOString(),
          },
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'BILL_SUBMITTED',
          entityType: 'BILL',
          entityId: bill.id,
          beforeState: { status: 'DRAFT' },
          afterState: { status: 'PENDING_APPROVAL' },
          metadata: { billNumber: bill.billNumber },
        },
      });

      return updated;
    });
  }

  /**
   * ── LIST BILLS / INVOICES ───────────────────────────────────────
   * Server-side pagination, whitelist sorting, and multi-field filtering.
   * Default sorting: Created At DESC (recent-first).
   */
  async listBills(filter: BillFilterDto, userId: string, userRoles: string[]) {
    const page = Number(filter.page) || 1;
    const limit = Number(filter.limit) || 20;
    const skip = (page - 1) * limit;

    const includeUnbilled = String(filter.includeUnbilled) === 'true' || filter.includeUnbilled === true;

    if (includeUnbilled && filter.month && filter.year) {
      const monthNum = Number(filter.month);
      const yearNum = Number(filter.year);
      const currentPrice = await this.getPricingSetting();
      const taxConfig = await this.getTaxConfiguration();

      const allSchools = await this.prisma.institution.findMany({
        where: { status: { in: ['ACTIVE', 'APPROVED', 'DRAFT'] } },
        select: {
          id: true,
          name: true,
          code: true,
          email: true,
          phone: true,
          city: true,
          state: true,
          address: true,
          stateRef: { select: { id: true, name: true, code: true } },
        },
        orderBy: { name: 'asc' },
      });

      const existingBills = await this.prisma.bill.findMany({
        where: {
          billingMonth: monthNum,
          billingYear: yearNum,
        },
        include: {
          institution: { select: { id: true, name: true, code: true, email: true, phone: true, city: true, address: true } },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
              mobileNumber: true,
              userRoles: { include: { role: true } },
            },
          },
          approvedBy: { select: { id: true, name: true, email: true } },
        },
      });

      const billMap = new Map<string, any>();
      for (const b of existingBills) {
        billMap.set(b.institutionId, b);
      }

      // Pre-fetch active custom pricings across schools for this billing period
      const schoolIds = allSchools.map((s) => s.id);
      const periodDate = new Date(yearNum, monthNum - 1, 28);
      const customPricings = await (this.prisma as any).institutionPricing.findMany({
        where: {
          institutionId: { in: schoolIds },
          isActive: true,
          effectiveFrom: { lte: periodDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodDate } }],
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      });
      const pricingMap = new Map<string, number>();
      for (const p of customPricings) {
        if (!pricingMap.has(p.institutionId) && p.pricePerStudent > 0) {
          pricingMap.set(p.institutionId, p.pricePerStudent);
        }
      }

      let combined: any[] = [];
      for (const school of allSchools) {
        if (filter.institutionId && filter.institutionId !== 'ALL' && filter.institutionId !== school.id) {
          continue;
        }

        const existingBill = billMap.get(school.id);
        if (existingBill) {
          const staffRole = existingBill.createdBy?.userRoles?.[0]?.role?.name || 'STAFF';
          combined.push({
            id: existingBill.id,
            billNumber: existingBill.billNumber,
            billDate: existingBill.billDate,
            billingMonth: existingBill.billingMonth,
            billingYear: existingBill.billingYear,
            billingPeriod: `${MONTH_NAMES[existingBill.billingMonth] || 'Month ' + existingBill.billingMonth} ${existingBill.billingYear}`,
            studentCount: existingBill.studentCount,
            pricePerStudent: existingBill.pricePerStudent,
            description: existingBill.description,
            amount: existingBill.amount,
            tax: existingBill.tax,
            totalAmount: existingBill.totalAmount,
            status: existingBill.status,
            rejectionReason: existingBill.rejectionReason,
            emailStatus: existingBill.emailStatus || 'IDLE',
            emailFailedReason: existingBill.emailFailedReason,
            sentAt: existingBill.sentAt,
            institution: existingBill.institution || school,
            createdBy: existingBill.createdBy
              ? {
                  id: existingBill.createdBy.id,
                  name: existingBill.createdBy.name || 'Staff Member',
                  email: existingBill.createdBy.email,
                  mobileNumber: existingBill.createdBy.mobileNumber,
                  role: staffRole,
                }
              : null,
            approvedBy: existingBill.approvedBy
              ? { id: existingBill.approvedBy.id, name: existingBill.approvedBy.name || existingBill.approvedBy.email }
              : null,
            approvedAt: existingBill.approvedAt,
            createdAt: existingBill.createdAt,
            isUnbilled: false,
          });
        } else {
          const studentCount = await this.countEligibleStudents(school.id);
          const schoolPrice = pricingMap.get(school.id) || currentPrice;
          const taxableAmount = studentCount * schoolPrice;
          const taxDetails = this.calculateTaxForInstitution(taxableAmount, school, taxConfig);

          combined.push({
            id: `unbilled_${school.id}`,
            billNumber: null,
            billDate: null,
            billingMonth: monthNum,
            billingYear: yearNum,
            billingPeriod: `${MONTH_NAMES[monthNum]} ${yearNum}`,
            studentCount,
            pricePerStudent: schoolPrice,
            description: `Student Platform Subscription (${MONTH_NAMES[monthNum]} ${yearNum})`,
            amount: taxableAmount,
            tax: taxDetails.totalTax,
            totalAmount: taxDetails.grandTotal,
            status: 'NOT_GENERATED',
            emailStatus: 'IDLE',
            institution: school,
            createdBy: null,
            approvedBy: null,
            createdAt: new Date().toISOString(),
            isUnbilled: true,
          });
        }
      }

      // Filter by search query
      if (filter.search && filter.search.trim()) {
        const q = filter.search.trim().toLowerCase();
        combined = combined.filter(
          (item) =>
            item.billNumber?.toLowerCase().includes(q) ||
            item.institution?.name?.toLowerCase().includes(q) ||
            item.institution?.code?.toLowerCase().includes(q) ||
            item.institution?.city?.toLowerCase().includes(q) ||
            item.description?.toLowerCase().includes(q),
        );
      }

      // Filter by status
      if (filter.status && filter.status !== 'ALL') {
        const targetStatus = filter.status.toUpperCase();
        combined = combined.filter((item) => item.status === targetStatus);
      }

      const total = combined.length;
      const paginated = combined.slice(skip, skip + limit);

      return {
        data: paginated,
        meta: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit) || 1,
        },
      };
    }

    const where: any = {};

    // Scope enforcement: Platform staff & super admins see all invoices (or filter by institutionId)
    const isPlatformStaff = userRoles.some((r) =>
      ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'MANAGER'].includes(r),
    );

    if (!isPlatformStaff) {
      const adminRecord = await this.prisma.institutionAdmin.findFirst({
        where: { userId, isActive: true },
      });
      if (adminRecord) {
        where.institutionId = adminRecord.institutionId;
      } else {
        where.createdById = userId;
      }
    } else if (filter.institutionId && filter.institutionId !== 'ALL') {
      where.institutionId = filter.institutionId;
    }

    if (filter.status && filter.status !== 'ALL') {
      where.status = filter.status.toUpperCase();
    }

    if (filter.month) {
      where.billingMonth = Number(filter.month);
    }

    if (filter.year) {
      where.billingYear = Number(filter.year);
    }

    if (filter.search && filter.search.trim()) {
      const q = filter.search.trim();
      where.OR = [
        { billNumber: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { institution: { name: { contains: q, mode: 'insensitive' } } },
        { institution: { code: { contains: q, mode: 'insensitive' } } },
        { createdBy: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    if (filter.from || filter.to) {
      where.billDate = {};
      if (filter.from) where.billDate.gte = new Date(filter.from);
      if (filter.to) where.billDate.lte = new Date(filter.to);
    }

    // Whitelist sorting fields
    const allowedSortFields: Record<string, string> = {
      createdAt: 'createdAt',
      billDate: 'billDate',
      totalAmount: 'totalAmount',
      studentCount: 'studentCount',
      billNumber: 'billNumber',
      billingMonth: 'billingMonth',
      billingYear: 'billingYear',
    };

    const sortBy = filter.sortBy && allowedSortFields[filter.sortBy] ? allowedSortFields[filter.sortBy] : 'createdAt';
    const sortOrder = (filter.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

    const [bills, total] = await Promise.all([
      this.prisma.bill.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          institution: { select: { id: true, name: true, code: true, email: true, phone: true, city: true, address: true } },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
              mobileNumber: true,
              userRoles: { include: { role: true } },
            },
          },
          approvedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.bill.count({ where }),
    ]);

    const items = bills.map((b) => {
      const staffRole = b.createdBy?.userRoles?.[0]?.role?.name || 'STAFF';
      return {
        id: b.id,
        billNumber: b.billNumber,
        billDate: b.billDate,
        billingMonth: b.billingMonth,
        billingYear: b.billingYear,
        billingPeriod:
          b.billingMonth && b.billingYear
            ? `${MONTH_NAMES[b.billingMonth] || 'Month ' + b.billingMonth} ${b.billingYear}`
            : null,
        studentCount: b.studentCount,
        pricePerStudent: b.pricePerStudent,
        description: b.description,
        amount: b.amount,
        tax: b.tax,
        totalAmount: b.totalAmount,
        status: b.status,
        rejectionReason: b.rejectionReason,
        emailStatus: b.emailStatus || 'IDLE',
        emailFailedReason: b.emailFailedReason,
        sentAt: b.sentAt,
        institution: b.institution,
        createdBy: {
          id: b.createdBy.id,
          name: b.createdBy.name || 'Staff Member',
          email: b.createdBy.email,
          mobileNumber: b.createdBy.mobileNumber,
          role: staffRole,
        },
        approvedBy: b.approvedBy ? { id: b.approvedBy.id, name: b.approvedBy.name || b.approvedBy.email } : null,
        approvedAt: b.approvedAt,
        createdAt: b.createdAt,
      };
    });

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * ── GET BILL BY ID ──────────────────────────────────────────────
   */
  async getBillById(billId: string, userId: string, userRoles: string[]) {
    const b = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: {
        institution: true,
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
            mobileNumber: true,
            userRoles: { include: { role: true } },
          },
        },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!b) {
      throw new NotFoundException(`Bill/Invoice '${billId}' not found.`);
    }

    if (!userRoles.includes('SUPER_ADMIN')) {
      await this.assertInstitutionScope(userId, userRoles, b.institutionId);
    }

    const staffRole = b.createdBy?.userRoles?.[0]?.role?.name || 'STAFF';

    return {
      id: b.id,
      billNumber: b.billNumber,
      billDate: b.billDate,
      billingMonth: b.billingMonth,
      billingYear: b.billingYear,
      billingPeriod:
        b.billingMonth && b.billingYear
          ? `${MONTH_NAMES[b.billingMonth] || 'Month ' + b.billingMonth} ${b.billingYear}`
          : null,
      studentCount: b.studentCount,
      pricePerStudent: b.pricePerStudent,
      description: b.description,
      amount: b.amount,
      tax: b.tax,
      totalAmount: b.totalAmount,
      status: b.status,
      rejectionReason: b.rejectionReason,
      emailStatus: b.emailStatus || 'IDLE',
      emailFailedReason: b.emailFailedReason,
      sentAt: b.sentAt,
      institution: b.institution,
      createdBy: {
        id: b.createdBy.id,
        name: b.createdBy.name || 'Staff Member',
        email: b.createdBy.email,
        mobileNumber: b.createdBy.mobileNumber,
        role: staffRole,
      },
      approvedBy: b.approvedBy ? { id: b.approvedBy.id, name: b.approvedBy.name || b.approvedBy.email } : null,
      approvedAt: b.approvedAt,
      metadata: b.metadata,
      createdAt: b.createdAt,
    };
  }

  /**
   * ── UPDATE DRAFT BILL ──────────────────────────────────────────
   */
  async updateBill(billId: string, dto: UpdateBillDto, userId: string, userRoles: string[]) {
    const bill = await this.prisma.bill.findUnique({ where: { id: billId } });
    if (!bill) {
      throw new NotFoundException(`Bill '${billId}' not found.`);
    }

    if (!userRoles.includes('SUPER_ADMIN') && bill.createdById !== userId) {
      throw new ForbiddenException('You are not authorized to modify this bill.');
    }

    if (bill.status !== 'DRAFT') {
      throw new BadRequestException(
        `Cannot update bill in '${bill.status}' status. Only DRAFT bills can be edited.`,
      );
    }

    const amount = dto.amount !== undefined ? Number(dto.amount) : bill.amount;
    const tax = dto.tax !== undefined ? Number(dto.tax) : bill.tax;
    const totalAmount = Math.round((amount + tax) * 100) / 100;

    return this.prisma.bill.update({
      where: { id: billId },
      data: {
        description: dto.description !== undefined ? dto.description.trim() : bill.description,
        amount,
        tax,
        totalAmount,
        billDate: dto.billDate ? new Date(dto.billDate) : bill.billDate,
      },
    });
  }

  /**
   * ── APPROVE BILL ───────────────────────────────────────────────
   */
  async approveBill(billId: string, reviewerId: string) {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { institution: true, createdBy: true },
    });

    if (!bill) {
      throw new NotFoundException(`Bill '${billId}' not found.`);
    }

    if (bill.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Cannot approve bill with status '${bill.status}'. Only PENDING_APPROVAL bills can be approved.`,
      );
    }

    if (bill.createdById === reviewerId) {
      throw new ForbiddenException('Staff members cannot approve their own bills.');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.bill.update({
        where: { id: billId },
        data: {
          status: 'APPROVED',
          approvedById: reviewerId,
          approvedAt: new Date(),
          rejectionReason: null,
        },
      });

      await tx.approvalRequest.updateMany({
        where: { resourceType: 'BILL', resourceId: billId, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          reviewedById: reviewerId,
          reviewedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: reviewerId,
          action: 'BILL_APPROVED',
          entityType: 'BILL',
          entityId: bill.id,
          beforeState: { status: 'PENDING_APPROVAL' },
          afterState: { status: 'APPROVED', approvedBy: reviewerId },
          metadata: { billNumber: bill.billNumber },
        },
      });

      return updated;
    });
  }

  /**
   * ── REJECT BILL ────────────────────────────────────────────────
   */
  async rejectBill(billId: string, reviewerId: string, dto: RejectBillDto) {
    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException('Rejection reason is mandatory.');
    }

    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { institution: true },
    });

    if (!bill) {
      throw new NotFoundException(`Bill '${billId}' not found.`);
    }

    if (bill.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Cannot reject bill with status '${bill.status}'. Only PENDING_APPROVAL bills can be rejected.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.bill.update({
        where: { id: billId },
        data: {
          status: 'REJECTED',
          approvedById: reviewerId,
          approvedAt: new Date(),
          rejectionReason: dto.reason.trim(),
        },
      });

      await tx.approvalRequest.updateMany({
        where: { resourceType: 'BILL', resourceId: billId, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          rejectionReason: dto.reason.trim(),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: reviewerId,
          action: 'BILL_REJECTED',
          entityType: 'BILL',
          entityId: bill.id,
          beforeState: { status: 'PENDING_APPROVAL' },
          afterState: { status: 'REJECTED', rejectionReason: dto.reason.trim() },
          reason: dto.reason.trim(),
          metadata: { billNumber: bill.billNumber },
        },
      });

      return updated;
    });
  }

  /**
   * ── UPDATE INVOICE STATUS (PAID / UNPAID) ─────────────────────────
   */
  async updateBillStatus(billId: string, statusInput: string, userId: string) {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { institution: true },
    });

    if (!bill) {
      throw new NotFoundException(`Invoice '${billId}' not found.`);
    }

    const normalizedStatus = statusInput.toUpperCase() === 'UNPAID' ? 'GENERATED' : statusInput.toUpperCase();
    const oldStatus = bill.status;

    const updated = await this.prisma.bill.update({
      where: { id: billId },
      data: {
        status: normalizedStatus as any,
        ...(normalizedStatus === 'PAID' ? { approvedById: userId, approvedAt: new Date() } : {}),
      },
      include: {
        institution: { select: { id: true, name: true, code: true, email: true, phone: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'BILL_STATUS_CHANGED',
        entityType: 'BILL',
        entityId: bill.id,
        beforeState: { status: oldStatus },
        afterState: { status: normalizedStatus },
        metadata: {
          billNumber: bill.billNumber,
          institutionId: bill.institutionId,
          schoolName: bill.institution?.name,
          oldStatus,
          newStatus: normalizedStatus,
          displayStatus: statusInput.toUpperCase(),
          updatedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.log(
      `Invoice ${bill.billNumber} status updated from ${oldStatus} to ${normalizedStatus} by user ${userId}`,
    );

    return {
      bill: updated,
      message: `Invoice ${bill.billNumber} marked as ${statusInput.toUpperCase() === 'PAID' ? 'Paid' : 'Unpaid'}.`,
    };
  }

  /**
   * ── DISPATCH INVOICE VIA EMAIL (BullMQ + Resend) ───────────────
   * Resolves recipient email from school record.
   * Prevents duplicate accidental clicks.
   */
  async sendBill(billId: string, currentUserId: string, explicitRecipientEmail?: string) {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { institution: true },
    });

    if (!bill) {
      throw new NotFoundException(`Invoice '${billId}' not found.`);
    }

    // School email must be resolved server-side from school record
    const recipientEmail = explicitRecipientEmail || bill.institution.email;
    if (!recipientEmail || !recipientEmail.includes('@')) {
      throw new BadRequestException('School email is not configured.');
    }

    // Duplicate email protection
    if (bill.emailStatus === 'QUEUED' || bill.emailStatus === 'PROCESSING') {
      throw new BadRequestException('An email dispatch job is already in progress for this invoice.');
    }

    // Mark as QUEUED in DB
    await this.prisma.bill.update({
      where: { id: bill.id },
      data: { emailStatus: 'QUEUED', emailFailedReason: null },
    });

    let jobId = `bill_email_${bill.id}_${Date.now()}`;
    try {
      const job = await this.billEmailQueue.add(
        'send-bill-email',
        {
          billId: bill.id,
          recipientEmail,
          schoolName: bill.institution.name,
          requestedById: currentUserId,
        },
        {
          jobId,
          removeOnComplete: true,
        },
      );
      if (job?.id) jobId = job.id;
    } catch (queueErr: any) {
      this.logger.warn(
        `[BillingService] BullMQ queue unavailable (${queueErr.message || queueErr}). Falling back to asynchronous direct dispatch.`,
      );

      setImmediate(async () => {
        try {
          const processor = this.moduleRef?.get(BillEmailProcessor, { strict: false });
          if (processor) {
            await processor.process({
              id: jobId,
              name: 'send-bill-email',
              data: {
                billId: bill.id,
                recipientEmail,
                schoolName: bill.institution.name,
                requestedById: currentUserId,
              },
            } as any);
          }
        } catch (err: any) {
          this.logger.error(`[BillingService] Direct bill email dispatch failed: ${err.message || err}`);
        }
      });
    }

    // Audit Log for email dispatch request
    await this.prisma.auditLog.create({
      data: {
        actorUserId: currentUserId,
        action: 'BILL_EMAIL_QUEUED',
        entityType: 'BILL',
        entityId: bill.id,
        metadata: {
          billNumber: bill.billNumber,
          recipientEmail,
          jobId,
        },
      },
    });

    return {
      message: `Invoice email queued for delivery to ${bill.institution.name} (${recipientEmail}).`,
      jobId,
      emailStatus: 'QUEUED',
    };
  }

  /**
   * ── RETRY FAILED INVOICE EMAIL ──────────────────────────────────
   */
  async retryBillEmail(billId: string, currentUserId: string) {
    const bill = await this.prisma.bill.findUnique({
      where: { id: billId },
      include: { institution: true },
    });

    if (!bill) {
      throw new NotFoundException(`Invoice '${billId}' not found.`);
    }

    // Reset failed state and re-dispatch
    await this.prisma.bill.update({
      where: { id: bill.id },
      data: { emailStatus: 'IDLE', emailFailedReason: null },
    });

    return this.sendBill(bill.id, currentUserId);
  }

  /**
   * ── BULK INVOICE EMAIL DISPATCH (BullMQ + Resend + WebSockets) ──
   * Dispatches invoices for all eligible schools for a specific billing month/year.
   * Protects against duplicate sends (skips already SENT unless forceRetryFailed).
   * Validates recipient emails and reports live WebSocket progress.
   */
  async sendBulkInvoices(dto: SendBulkInvoicesDto, userId: string) {
    const { billingMonth, billingYear, forceRetryFailed } = dto;
    const periodLabel = `${MONTH_NAMES[billingMonth]} ${billingYear}`;

    // Find all generated/approved bills for this period
    const bills = await this.prisma.bill.findMany({
      where: {
        billingMonth,
        billingYear,
        status: { in: ['GENERATED', 'APPROVED', 'SUBMITTED', 'PAID'] },
      },
      include: {
        institution: { select: { id: true, name: true, code: true, email: true } },
      },
      orderBy: { billNumber: 'asc' },
    });

    const total = bills.length;
    if (total === 0) {
      throw new BadRequestException(
        `No generated invoices found for ${periodLabel}. Please generate invoices first.`,
      );
    }

    const jobId = `bulk_bill_email_${billingYear}_${billingMonth}_${Date.now()}`;

    await this.jobProgressService.publishStarted(
      'bulk-bill-email',
      jobId,
      'BULK_EMAIL_DISPATCH',
      `Queueing invoice emails for ${total} schools (${periodLabel})...`,
      { total, billingMonth, billingYear },
    );

    let queuedCount = 0;
    let skippedCount = 0;
    let missingEmailCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < total; i++) {
      const bill = bills[i];
      const schoolName = bill.institution?.name || 'School';
      const email = bill.institution?.email;

      try {
        // Idempotency: skip if already sent and not force retry
        if (bill.emailStatus === 'SENT' && !forceRetryFailed) {
          skippedCount++;
        } else if (!email || !email.includes('@')) {
          missingEmailCount++;
          failedCount++;
          await this.prisma.bill.update({
            where: { id: bill.id },
            data: { emailStatus: 'FAILED', emailFailedReason: 'EMAIL_NOT_CONFIGURED' },
          });
          errors.push(`${schoolName} (${bill.billNumber}): School email is not configured.`);
        } else {
          // Mark QUEUED in DB
          await this.prisma.bill.update({
            where: { id: bill.id },
            data: { emailStatus: 'QUEUED', emailFailedReason: null },
          });

          const emailJobId = `bill_email_${bill.id}_${Date.now()}`;
          try {
            await this.billEmailQueue.add(
              'send-bill-email',
              {
                billId: bill.id,
                recipientEmail: email,
                schoolName,
                requestedById: userId,
              },
              {
                jobId: emailJobId,
                removeOnComplete: true,
              },
            );
          } catch (queueErr: any) {
            this.logger.warn(`BullMQ queue fallback for bill ${bill.id}: ${queueErr.message}`);
            setImmediate(async () => {
              try {
                const processor = this.moduleRef?.get(BillEmailProcessor, { strict: false });
                if (processor) {
                  await processor.process({
                    id: emailJobId,
                    name: 'send-bill-email',
                    data: {
                      billId: bill.id,
                      recipientEmail: email,
                      schoolName,
                      requestedById: userId,
                    },
                  } as any);
                }
              } catch (err: any) {
                this.logger.error(`Direct email dispatch failed: ${err.message}`);
              }
            });
          }

          queuedCount++;
        }
      } catch (err: any) {
        failedCount++;
        errors.push(`${schoolName}: ${err.message}`);
      }

      await this.jobProgressService.publishProgress(
        'bulk-bill-email',
        jobId,
        i + 1,
        total,
        {
          stage: 'SENDING_INVOICES',
          message: `${i + 1} / ${total} processed | Queued: ${queuedCount} | Skipped (Already Sent): ${skippedCount} | Missing Email: ${missingEmailCount}`,
          currentSchool: schoolName,
          sent: queuedCount,
          failed: failedCount,
          pending: total - (i + 1),
        },
      );
    }

    await this.jobProgressService.publishCompleted(
      'bulk-bill-email',
      jobId,
      `Invoice email dispatch completed: ${queuedCount} queued, ${skippedCount} skipped (already sent), ${missingEmailCount} missing email.`,
      { queuedCount, skippedCount, missingEmailCount, errorsCount: errors.length },
    );

    // Audit Log for Bulk Send
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'BULK_INVOICES_SENT',
        entityType: 'BILL',
        entityId: jobId,
        metadata: {
          billingMonth,
          billingYear,
          periodLabel,
          totalInvoices: total,
          queuedCount,
          skippedCount,
          missingEmailCount,
          jobId,
        },
      },
    });

    return {
      jobId,
      total,
      queuedCount,
      skippedCount,
      missingEmailCount,
      errors,
      message: `Invoice email dispatch initiated for ${periodLabel}: ${queuedCount} queued, ${skippedCount} already sent, ${missingEmailCount} missing email.`,
    };
  }

  /**
   * ── DOWNLOAD / STREAM INVOICE PDF ──────────────────────────────
   */
  async getBillPdfBuffer(
    billId: string,
    userId: string,
    userRoles: string[],
  ): Promise<{ filename: string; buffer: Buffer }> {
    const bill = await this.getBillById(billId, userId, userRoles);
    const taxConfig = await this.getTaxConfiguration();
    const snapshot = (bill.metadata as any)?.taxSnapshot;

    const buffer = await this.pdfService.generateBillPdf({
      billNumber: bill.billNumber,
      billDate: bill.billDate,
      billingMonth: bill.billingMonth,
      billingYear: bill.billingYear,
      schoolName: bill.institution.name,
      schoolCode: bill.institution.code,
      schoolEmail: bill.institution.email,
      schoolPhone: bill.institution.phone,
      schoolAddress: bill.institution.address,
      schoolCity: (bill.institution as any).city,
      schoolState: snapshot?.placeOfSupply || bill.institution.state,
      schoolStateCode: snapshot?.placeOfSupplyCode,
      schoolGstin: (bill.institution as any).settings?.gstin,
      studentCount: bill.studentCount,
      pricePerStudent: bill.pricePerStudent,
      description: bill.description,
      hsnSacCode: snapshot?.hsnSacCode || taxConfig.hsnSacCode,
      amount: bill.amount,
      taxableValue: snapshot?.taxableAmount || bill.amount,
      isInterState: snapshot?.isInterState,
      cgstRate: snapshot?.cgstRate,
      cgstAmount: snapshot?.cgstAmount,
      sgstRate: snapshot?.sgstRate,
      sgstAmount: snapshot?.sgstAmount,
      igstRate: snapshot?.igstRate,
      igstAmount: snapshot?.igstAmount,
      cessRate: snapshot?.cessRate,
      cessAmount: snapshot?.cessAmount,
      tax: bill.tax,
      totalAmount: bill.totalAmount,
      amountInWords: snapshot?.amountInWords,
      reverseCharge: snapshot?.reverseCharge ?? taxConfig.reverseCharge,
      supplierLegalName: taxConfig.supplierLegalName,
      supplierTradeName: taxConfig.supplierTradeName,
      supplierGstin: taxConfig.supplierGstin,
      supplierPan: taxConfig.supplierPan,
      supplierState: taxConfig.supplierState,
      supplierStateCode: taxConfig.supplierStateCode,
      supplierAddress: taxConfig.supplierAddress,
      supplierEmail: taxConfig.supplierEmail,
      supplierPhone: taxConfig.supplierPhone,
      bankName: taxConfig.bankName,
      bankAccountNumber: taxConfig.bankAccountNumber,
      bankIfsc: taxConfig.bankIfsc,
      bankBranch: taxConfig.bankBranch,
      status: bill.status,
      createdByName: bill.createdBy.name,
      approvedByName: bill.approvedBy?.name,
      approvedAt: bill.approvedAt,
    });

    const filename = `Invoice_${bill.billNumber}_${bill.institution.code}.pdf`;
    return { filename, buffer };
  }

  /**
   * ── DYNAMIC FILTER OPTIONS ─────────────────────────────────────
   * Supplies dynamic years, months, schools with their configured prices, and defaults.
   */
  async getFilterOptions() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const distinctBills = await this.prisma.bill.findMany({
      where: { billingYear: { not: null } },
      select: { billingYear: true, billingMonth: true },
      distinct: ['billingYear', 'billingMonth'],
    });

    const yearsSet = new Set<number>([currentYear - 1, currentYear, currentYear + 1]);
    for (const b of distinctBills) {
      if (b.billingYear) yearsSet.add(b.billingYear);
    }
    const availableYears = Array.from(yearsSet).sort((a, b) => b - a);

    const months = [
      { month: 1, name: 'January' },
      { month: 2, name: 'February' },
      { month: 3, name: 'March' },
      { month: 4, name: 'April' },
      { month: 5, name: 'May' },
      { month: 6, name: 'June' },
      { month: 7, name: 'July' },
      { month: 8, name: 'August' },
      { month: 9, name: 'September' },
      { month: 10, name: 'October' },
      { month: 11, name: 'November' },
      { month: 12, name: 'December' },
    ];

    const defaultPrice = await this.getPricingSetting();

    const rawSchools = await this.prisma.institution.findMany({
      where: { status: { in: ['ACTIVE', 'APPROVED', 'DRAFT'] } },
      select: {
        id: true,
        name: true,
        code: true,
        email: true,
        city: true,
        pricings: {
          where: { isActive: true },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          take: 1,
          select: { pricePerStudent: true, currency: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const schools = rawSchools.map((s: any) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      email: s.email,
      city: s.city,
      pricePerStudent: s.pricings?.[0]?.pricePerStudent ?? defaultPrice,
      isCustomPrice: Boolean(s.pricings?.[0]),
    }));

    const lastMonthDate = new Date(currentYear, currentMonth - 2, 1);
    const lastMonth = lastMonthDate.getMonth() + 1;
    const lastMonthYear = lastMonthDate.getFullYear();

    return {
      availableYears,
      months,
      schools,
      currentPrice: defaultPrice,
      currentMonth,
      currentYear,
      lastMonth,
      lastMonthYear,
    };
  }

  /**
   * ── SCHOOLS DROPDOWN ───────────────────────────────────────────
   */
  async getSchoolsDropdown(userId: string, userRoles: string[]) {
    if (userRoles.includes('SUPER_ADMIN')) {
      return this.prisma.institution.findMany({
        where: { status: { in: ['ACTIVE', 'DRAFT', 'APPROVED'] as any } },
        select: { id: true, name: true, code: true, email: true, phone: true, city: true },
        orderBy: { name: 'asc' },
      });
    }

    const adminRecord = await this.prisma.institutionAdmin.findFirst({
      where: { userId, isActive: true },
      include: { institution: { select: { id: true, name: true, code: true, email: true, phone: true, city: true } } },
    });

    if (adminRecord) {
      return [adminRecord.institution];
    }

    return this.prisma.institution.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, code: true, email: true, phone: true, city: true },
      orderBy: { name: 'asc' },
    });
  }
}

