import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminSchoolsService } from '../services/admin-schools.service';
import { SchoolBulkUploadService } from '../services/school-bulk-upload.service';
import {
  CreateSchoolDto,
  UpdateSchoolDto,
  UpdateSchoolStatusDto,
  SchoolQueryDto,
} from '../dto/admin-schools.dto';

@Controller('admin/schools')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminSchoolsController {
  constructor(
    private readonly schoolsService: AdminSchoolsService,
    private readonly bulkUploadService: SchoolBulkUploadService,
  ) {}

  /**
   * GET /admin/schools
   * Paginated, searchable, filterable list of schools
   */
  @Get()
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getSchools(@Query() query: SchoolQueryDto) {
    return this.schoolsService.getSchools(query);
  }

  /**
   * GET /admin/schools/filter-options
   * Dynamic dropdown options (states, districts)
   */
  @Get('filter-options')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getFilterOptions() {
    return this.schoolsService.getFilterOptions();
  }

  /**
   * GET /admin/schools/bulk-template
   * Download sample template (CSV or XLSX)
   */
  @Get('bulk-template')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async downloadTemplate(
    @Query('format') format: 'csv' | 'xlsx' = 'xlsx',
    @Res() res: Response,
  ) {
    const { buffer, fileName, mimeType } =
      await this.bulkUploadService.generateTemplate(format);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }

  /**
   * POST /admin/schools/bulk-upload
   * Upload and validate schools spreadsheet
   */
  @Post('bulk-upload')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSchools(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('Please select a CSV or Excel file to upload.');
    }

    const actor = {
      userId: req.user?.userId || req.user?.id,
      email: req.user?.email,
    };

    return this.bulkUploadService.uploadAndValidate(file, actor);
  }

  /**
   * GET /admin/schools/bulk-history
   * Get paginated school bulk upload history
   */
  @Get('bulk-history')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getUploadHistory(
    @Query('page') page = 1,
    @Query('limit') limit = 10,
    @Query('status') status?: string,
  ) {
    return this.bulkUploadService.getUploadHistory(
      Number(page) || 1,
      Number(limit) || 10,
      status,
    );
  }

  /**
   * GET /admin/schools/bulk-upload/:id/preview
   * Get preview and validation errors for uploaded batch
   */
  @Get('bulk-upload/:id/preview')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getUploadPreview(
    @Param('id') uploadId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('filterStatus') filterStatus?: 'ALL' | 'VALID' | 'INVALID',
  ) {
    return this.bulkUploadService.getUploadPreview(
      uploadId,
      Number(page) || 1,
      Number(limit) || 20,
      filterStatus,
    );
  }

  /**
   * POST /admin/schools/bulk-upload/:id/confirm
   * Confirm batch and register valid schools
   */
  @Post('bulk-upload/:id/confirm')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async confirmBatch(
    @Param('id') uploadId: string,
    @Req() req: any,
  ) {
    const actor = {
      userId: req.user?.userId || req.user?.id,
      email: req.user?.email,
      roles: req.user?.roles || [],
    };

    return this.bulkUploadService.confirmAndCreateSchools(uploadId, actor);
  }

  /**
   * POST /admin/schools
   * Create a single school
   */
  @Post()
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async createSchool(@Body() dto: CreateSchoolDto, @Req() req: any) {
    const actorUserId = req.user?.userId || req.user?.id;
    return this.schoolsService.createSchool(dto, actorUserId);
  }

  /**
   * GET /admin/schools/:id
   * Get school details by ID
   */
  @Get(':id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async getSchoolById(@Param('id') id: string) {
    return this.schoolsService.getSchoolById(id);
  }

  /**
   * PATCH /admin/schools/:id
   * Update school details
   */
  @Patch(':id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async updateSchool(
    @Param('id') id: string,
    @Body() dto: UpdateSchoolDto,
  ) {
    return this.schoolsService.updateSchool(id, dto);
  }

  /**
   * PATCH /admin/schools/:id/status
   * Update school status
   */
  @Patch(':id/status')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async updateSchoolStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSchoolStatusDto,
  ) {
    return this.schoolsService.updateSchoolStatus(id, dto);
  }
}
