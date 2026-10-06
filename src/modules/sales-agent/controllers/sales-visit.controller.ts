import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SalesVisitService } from '../services/sales-visit.service';
import {
  CreateSalesVisitDto,
  CheckInVisitDto,
  CheckOutVisitDto,
  SalesVisitFilterDto,
} from '../dto/sales-visit.dto';

@Controller('sales-agent/visits')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SALES_AGENT', 'SUPER_ADMIN')
export class SalesVisitController {
  constructor(private readonly visitService: SalesVisitService) {}

  /**
   * POST /sales-agent/visits
   * Schedule a new field visit
   */
  @Post()
  async scheduleVisit(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateSalesVisitDto,
  ) {
    const data = await this.visitService.scheduleVisit(dto, userId);
    return {
      statusCode: 201,
      message: 'Field visit scheduled successfully.',
      data,
    };
  }

  /**
   * GET /sales-agent/visits
   * List field visits with filters
   */
  @Get()
  async listVisits(
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
    @Query() filter: SalesVisitFilterDto,
  ) {
    const isSuperAdmin = Array.isArray(roles) && roles.includes('SUPER_ADMIN');
    const res = await this.visitService.listVisits(filter, userId, isSuperAdmin);
    return {
      statusCode: 200,
      message: 'Field visits retrieved successfully.',
      items: res.items,
      pagination: res.pagination,
      data: res,
    };
  }

  /**
   * GET /sales-agent/visits/:id
   * Get single field visit details
   */
  @Get(':id')
  async getVisitById(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('roles') roles: string[],
  ) {
    const isSuperAdmin = Array.isArray(roles) && roles.includes('SUPER_ADMIN');
    const data = await this.visitService.getVisitById(id, userId, isSuperAdmin);
    return {
      statusCode: 200,
      message: 'Visit details retrieved successfully.',
      data,
    };
  }

  /**
   * POST /sales-agent/visits/:id/check-in
   * GPS Check-In at institution location
   */
  @Post(':id/check-in')
  async checkIn(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: CheckInVisitDto,
  ) {
    const data = await this.visitService.checkIn(id, dto, userId);
    return {
      statusCode: 200,
      message: 'Check-in recorded successfully.',
      data,
    };
  }

  /**
   * POST /sales-agent/visits/:id/check-out
   * GPS Check-Out with outcome & notes
   */
  @Post(':id/check-out')
  async checkOut(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: CheckOutVisitDto,
  ) {
    const data = await this.visitService.checkOut(id, dto, userId);
    return {
      statusCode: 200,
      message: 'Check-out recorded successfully.',
      data,
    };
  }

  /**
   * POST /sales-agent/visits/upload-photo
   * Upload photo proof of field visit
   */
  @Post('upload-photo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPhoto(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('userId') userId: string,
  ) {
    const data = await this.visitService.uploadVisitPhoto(file, userId);
    return {
      statusCode: 201,
      message: 'Visit photo uploaded successfully.',
      data,
    };
  }
}
