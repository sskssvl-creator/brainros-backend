import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Res,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { BillingService } from '../services/billing.service';
import {
  CreateBillDto,
  UpdateBillDto,
  RejectBillDto,
  BillFilterDto,
  GenerateInvoiceDto,
  UpdatePricingDto,
  UpdateSchoolPricingDto,
  SendBulkInvoicesDto,
  UpdateBillStatusDto,
} from '../dto/billing.dto';

@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /**
   * GET /billing/pricing
   * Retrieve current global price per student per month fallback setting
   */
  @Get('pricing')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT')
  async getPricing() {
    const pricePerStudent = await this.billingService.getPricingSetting();
    return {
      statusCode: 200,
      message: 'Pricing setting retrieved successfully.',
      data: { pricePerStudent },
    };
  }

  /**
   * PUT /billing/pricing
   * Update global price per student per month fallback setting
   */
  @Put('pricing')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updatePricing(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdatePricingDto,
  ) {
    const data = await this.billingService.updatePricingSetting(dto.pricePerStudent, userId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  /**
   * GET /billing/schools/pricing
   * Retrieve configured school-wise pricing list
   */
  @Get('schools/pricing')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT')
  async getSchoolPricings() {
    const data = await this.billingService.getSchoolPricings();
    return {
      statusCode: 200,
      message: 'School pricings retrieved successfully.',
      data,
    };
  }

  /**
   * GET /billing/schools/:id/pricing
   * Retrieve specific school pricing configuration & history
   */
  @Get('schools/:id/pricing')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT')
  async getSchoolPricing(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.billingService.getSchoolPricing(id);
    return {
      statusCode: 200,
      message: 'School pricing details retrieved successfully.',
      data,
    };
  }

  /**
  /**
   * PATCH /billing/schools/:id/price
   * PATCH /billing/schools/:id/pricing
   * Update school-specific price per student per month
   */
  @Patch('schools/:id/price')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updateSchoolPrice(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateSchoolPricingDto,
  ) {
    const data = await this.billingService.updateSchoolPricing(id, dto, userId);
    return {
      statusCode: 200,
      message: data.message,
      data: data.pricing,
    };
  }

  @Patch('schools/:id/pricing')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updateSchoolPricingPatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateSchoolPricingDto,
  ) {
    const data = await this.billingService.updateSchoolPricing(id, dto, userId);
    return {
      statusCode: 200,
      message: data.message,
      data: data.pricing,
    };
  }

  /**
   * PUT /billing/schools/:id/price
   * PUT /billing/schools/:id/pricing
   */
  @Put('schools/:id/price')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updateSchoolPricePut(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateSchoolPricingDto,
  ) {
    const data = await this.billingService.updateSchoolPricing(id, dto, userId);
    return {
      statusCode: 200,
      message: data.message,
      data: data.pricing,
    };
  }

  @Put('schools/:id/pricing')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updateSchoolPricingPut(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateSchoolPricingDto,
  ) {
    const data = await this.billingService.updateSchoolPricing(id, dto, userId);
    return {
      statusCode: 200,
      message: data.message,
      data: data.pricing,
    };
  }

  /**
   * GET /billing/tax-configuration
   * Retrieve dynamic Indian GST & supplier tax compliance configuration
   */
  @Get('tax-configuration')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'MANAGER')
  async getTaxConfiguration() {
    const data = await this.billingService.getTaxConfiguration();
    return {
      statusCode: 200,
      message: 'Tax configuration retrieved successfully.',
      data,
    };
  }

  /**
   * PUT /billing/tax-configuration
   * Update Indian GST & tax compliance configuration
   */
  @Put('tax-configuration')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updateTaxConfiguration(
    @CurrentUser('userId') userId: string,
    @Body() dto: any,
  ) {
    const data = await this.billingService.updateTaxConfiguration(dto, userId);
    return {
      statusCode: 200,
      message: data.message,
      data: data.taxConfiguration,
    };
  }

  /**
   * GET /billing/filter-options
   * Supplies dynamic years, months, schools, and current price
   */
  @Get('filter-options')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'MANAGER')
  async getFilterOptions() {
    const data = await this.billingService.getFilterOptions();
    return {
      statusCode: 200,
      message: 'Filter options retrieved successfully.',
      data,
    };
  }

  /**
   * GET /billing/invoices/preview
   * Live preview of calculated student count and total amount before generation
   */
  @Get('invoices/preview')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT')
  async getInvoicePreview(
    @Query('institutionId') institutionId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('pricePerStudent') pricePerStudent?: string,
  ) {
    const customPrice = pricePerStudent !== undefined && pricePerStudent !== '' ? Number(pricePerStudent) : undefined;
    const data = await this.billingService.getInvoicePreview(
      institutionId,
      Number(month),
      Number(year),
      customPrice,
    );
    return {
      statusCode: 200,
      message: 'Invoice preview generated successfully.',
      data,
    };
  }

  /**
   * POST /billing/invoices/generate
   * Super Admin generates monthly invoice for a single school or all schools
   */
  @Post('invoices/generate')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async generateInvoice(
    @CurrentUser('userId') userId: string,
    @Body() dto: GenerateInvoiceDto,
  ) {
    if (dto.generateAll) {
      const data = await this.billingService.generateBulkInvoices(dto, userId);
      return {
        statusCode: 201,
        message: `Bulk invoice generation initiated for ${data.totalSchools} schools.`,
        data,
      };
    }

    const data = await this.billingService.generateInvoice(dto, userId);
    return {
      statusCode: 201,
      message: `Invoice ${data.billNumber} generated successfully.`,
      data,
    };
  }

  /**
   * POST /billing/invoices/send-all
   * Send all generated invoices for the selected billing period via BullMQ + Resend
   */
  @Post('invoices/send-all')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async sendBulkInvoices(
    @CurrentUser('userId') userId: string,
    @Body() dto: SendBulkInvoicesDto,
  ) {
    const data = await this.billingService.sendBulkInvoices(dto, userId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  /**
   * GET /billing/schools
   * Dynamic dropdown of authorized institutions
   */
  @Get('schools')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'MANAGER')
  async getSchools(
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
  ) {
    const data = await this.billingService.getSchoolsDropdown(userId, roles || []);
    return {
      statusCode: 200,
      message: 'Schools retrieved successfully.',
      data,
    };
  }

  /**
   * POST /billing/bills
   * Create a new draft bill or submit directly
   */
  @Post('bills')
  @Roles('ACCOUNTANT', 'SUPER_ADMIN')
  async createBill(
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
    @Body() dto: CreateBillDto,
  ) {
    const data = await this.billingService.createBill(dto, userId, roles || []);
    return {
      statusCode: 201,
      message: dto.submitImmediately
        ? 'Bill created and submitted to Super Admin for approval.'
        : 'Draft bill saved successfully.',
      data,
    };
  }

  /**
   * GET /billing/bills
   * List bills with role-based scope filtering, status tabs, and server-side search
   */
  @Get('bills')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'MANAGER')
  async listBills(
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
    @Query() filter: BillFilterDto,
  ) {
    const data = await this.billingService.listBills(filter, userId, roles || []);
    return {
      statusCode: 200,
      message: 'Bills retrieved successfully.',
      ...data,
    };
  }

  /**
   * GET /billing/bills/:id
   * Get complete bill details
   */
  @Get('bills/:id')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'MANAGER')
  async getBillById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
  ) {
    const data = await this.billingService.getBillById(id, userId, roles || []);
    return {
      statusCode: 200,
      message: 'Bill details retrieved successfully.',
      data,
    };
  }

  /**
   * PATCH /billing/bills/:id
   * Update draft bill details
   */
  @Patch('bills/:id')
  @Roles('ACCOUNTANT', 'SUPER_ADMIN')
  async updateBill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
    @Body() dto: UpdateBillDto,
  ) {
    const data = await this.billingService.updateBill(id, dto, userId, roles || []);
    return {
      statusCode: 200,
      message: 'Bill updated successfully.',
      data,
    };
  }

  /**
   * POST /billing/bills/:id/submit
   * Submit draft bill to Super Admin (transitions status to PENDING_APPROVAL)
   */
  @Post('bills/:id/submit')
  @Roles('ACCOUNTANT', 'SUPER_ADMIN')
  async submitBill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
  ) {
    const data = await this.billingService.submitBill(id, userId, roles || []);
    return {
      statusCode: 200,
      message: 'Bill submitted for Super Admin approval.',
      data,
    };
  }

  /**
   * POST /billing/bills/:id/approve
   * Super Admin approves pending bill
   */
  @Post('bills/:id/approve')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async approveBill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') reviewerId: string,
  ) {
    const data = await this.billingService.approveBill(id, reviewerId);
    return {
      statusCode: 200,
      message: 'Bill approved successfully. It is now ready to be sent to the school.',
      data,
    };
  }

  /**
   * POST /billing/bills/:id/reject
   * Super Admin rejects pending bill with reason
   */
  @Post('bills/:id/reject')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async rejectBill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') reviewerId: string,
    @Body() dto: RejectBillDto,
  ) {
    const data = await this.billingService.rejectBill(id, reviewerId, dto);
    return {
      statusCode: 200,
      message: 'Bill has been rejected.',
      data,
    };
  }

  /**
   * PATCH /billing/bills/:id/status
   * Super Admin & Accountant updates payment status (Paid / Unpaid)
   */
  @Patch('bills/:id/status')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async updateBillStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateBillStatusDto,
  ) {
    const data = await this.billingService.updateBillStatus(id, dto.status, userId);
    return {
      statusCode: 200,
      message: data.message,
      data: data.bill,
    };
  }

  /**
   * POST /billing/bills/:id/send
   * Super Admin dispatches approved/generated bill via BullMQ + Resend with PDF
   */
  @Post('bills/:id/send')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async sendBill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @Body('recipientEmail') explicitRecipientEmail?: string,
  ) {
    const data = await this.billingService.sendBill(id, userId, explicitRecipientEmail);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  /**
   * POST /billing/bills/:id/retry-email
   * Retries sending a failed invoice email
   */
  @Post('bills/:id/retry-email')
  @Roles('SUPER_ADMIN', 'ACCOUNTANT')
  async retryEmail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
  ) {
    const data = await this.billingService.retryBillEmail(id, userId);
    return {
      statusCode: 200,
      message: data.message,
      data,
    };
  }

  /**
   * GET /billing/bills/:id/pdf
   * Download / preview invoice PDF
   */
  @Get('bills/:id/pdf')
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER', 'ACCOUNTANT', 'MANAGER')
  async downloadPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
    @Res() res: Response,
  ) {
    const { filename, buffer } = await this.billingService.getBillPdfBuffer(
      id,
      userId,
      roles || [],
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(buffer);
  }
}

