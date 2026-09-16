import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AdminStudentsService } from '../services/admin-students.service';
import { SuperAdminRegistrationsQueryDto } from '../dto/admin-students.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@Controller('super-admin/public-registrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
export class SuperAdminPublicRegistrationsController {
  constructor(private readonly studentsService: AdminStudentsService) {}

  /**
   * GET /super-admin/public-registrations
   * Server-side paginated, sorted, filtered public student registrations
   */
  @Get()
  async getPublicRegistrations(@Query() query: SuperAdminRegistrationsQueryDto) {
    return this.studentsService.getPublicRegistrations(query);
  }

  /**
   * GET /super-admin/public-registrations/stats
   * Real-time metrics for public registration students
   */
  @Get('stats')
  async getPublicRegistrationStats() {
    return this.studentsService.getPublicRegistrationStats();
  }

  /**
   * GET /super-admin/public-registrations/filter-options
   * Dynamic filter dropdown options
   */
  @Get('filter-options')
  async getFilterOptions(@Query('stateId') stateId?: string) {
    return this.studentsService.getSuperAdminFilterOptions(stateId);
  }

  /**
   * GET /super-admin/public-registrations/:id
   * Complete public registration student profile
   */
  @Get(':id')
  async getPublicStudentById(@Param('id') id: string) {
    return this.studentsService.getPublicStudentById(id);
  }

  /**
   * PATCH /super-admin/public-registrations/:id/deactivate
   * Deactivate public student account safely with Audit Log
   */
  @Patch(':id/deactivate')
  async deactivatePublicStudent(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.sub || 'system';
    return this.studentsService.deactivatePublicStudent(id, actorUserId, reason);
  }

  /**
   * PATCH /super-admin/public-registrations/:id/activate
   * Reactivate public student account
   */
  @Patch(':id/activate')
  async activatePublicStudent(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.sub || 'system';
    return this.studentsService.activatePublicStudent(id, actorUserId);
  }
}
