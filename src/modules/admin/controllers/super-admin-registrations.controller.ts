import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminStudentsService } from '../services/admin-students.service';
import { SuperAdminRegistrationsQueryDto } from '../dto/admin-students.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@Controller('super-admin/registrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
export class SuperAdminRegistrationsController {
  constructor(private readonly studentsService: AdminStudentsService) {}

  /**
   * GET /super-admin/registrations
   * Server-side paginated, sorted, filtered student registrations table
   */
  @Get()
  async getRegistrations(@Query() query: SuperAdminRegistrationsQueryDto) {
    return this.studentsService.getSuperAdminRegistrations(query);
  }

  /**
   * GET /super-admin/registrations/stats
   * Real-time registration metrics (Total, Today in Asia/Kolkata, NEET, JEE, CET, Active)
   */
  @Get('stats')
  async getRegistrationStats(@Query() query: SuperAdminRegistrationsQueryDto) {
    return this.studentsService.getSuperAdminRegistrationStats(query);
  }

  /**
   * GET /super-admin/registrations/filter-options
   * Dynamic filter dropdown options (States, Districts dependent on state, Institutions, Exam Targets)
   */
  @Get('filter-options')
  async getFilterOptions(@Query('stateId') stateId?: string) {
    return this.studentsService.getSuperAdminFilterOptions(stateId);
  }
}
