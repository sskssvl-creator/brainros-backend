import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Param,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AdminStudentsService } from '../services/admin-students.service';
import {
  AdminStudentsQueryDto,
  AddStudentParentDto,
  UpdateAdminStudentDto,
  ResetStudentPasswordDto,
} from '../dto/admin-students.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@Controller('admin/students')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminStudentsController {
  constructor(private readonly studentsService: AdminStudentsService) {}

  /**
   * GET /admin/students
   * Production-grade server-side paginated, sorted, filtered student list
   */
  @Get()
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'INSTITUTION_ADMIN')
  async getStudents(@Query() query: AdminStudentsQueryDto, @Req() req: any) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.studentsService.getStudents(query, actorUserId);
  }

  /**
   * GET /admin/students/filter-options
   * Master data filter options for dynamic dropdowns
   */
  @Get('filter-options')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'INSTITUTION_ADMIN')
  async getFilterOptions() {
    return this.studentsService.getFilterOptions();
  }

  /**
   * GET /admin/students/:studentId
   * Fetch single student complete profile for viewing/editing
   */
  @Get(':studentId')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'INSTITUTION_ADMIN')
  async getStudentById(@Param('studentId') studentId: string) {
    return this.studentsService.getStudentById(studentId);
  }

  /**
   * GET /admin/students/:studentId/parents
   * List all linked parents for a given student
   */
  @Get(':studentId/parents')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async getStudentParents(@Param('studentId') studentId: string) {
    return this.studentsService.getStudentParents(studentId);
  }

  /**
   * POST /admin/students/:studentId/parents
   * Add/Link parent to a student (creates or reuses Parent user)
   */
  @Post(':studentId/parents')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  @HttpCode(HttpStatus.CREATED)
  async addParentToStudent(
    @Param('studentId') studentId: string,
    @Body() dto: AddStudentParentDto,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.studentsService.addParentToStudent(studentId, dto, actorUserId);
  }

  /**
   * DELETE /admin/students/:studentId/parents/:linkId
   * Revoke/Unlink parent relationship
   */
  @Delete(':studentId/parents/:linkId')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  @HttpCode(HttpStatus.OK)
  async revokeParentLink(
    @Param('studentId') studentId: string,
    @Param('linkId') linkId: string,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.studentsService.revokeParentLink(studentId, linkId, actorUserId);
  }

  /**
   * PATCH /admin/students/:studentId
   * Update student details (name, studentCode, email, mobile, school, institution, class, target, status, password, etc.)
   */
  @Patch(':studentId')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @HttpCode(HttpStatus.OK)
  async updateStudent(
    @Param('studentId') studentId: string,
    @Body() dto: UpdateAdminStudentDto,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.studentsService.updateStudent(studentId, dto, actorUserId);
  }

  /**
   * POST /admin/students/:studentId/reset-password
   * Reset student password with bcrypt hash and session revocation
   */
  @Post(':studentId/reset-password')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  @HttpCode(HttpStatus.OK)
  async resetStudentPassword(
    @Param('studentId') studentId: string,
    @Body() dto: ResetStudentPasswordDto,
    @Req() req: any,
  ) {
    const actorUserId = req.user?.id || req.user?.userId;
    return this.studentsService.resetStudentPassword(
      studentId,
      dto.password,
      actorUserId,
    );
  }
}
