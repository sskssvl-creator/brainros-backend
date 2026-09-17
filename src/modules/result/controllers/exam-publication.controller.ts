import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ExamPublicationService } from '../services/exam-publication.service';
import { ResultReadinessService } from '../services/result-readiness.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExamPublicationController {
  constructor(
    private readonly publicationService: ExamPublicationService,
    private readonly readinessService: ResultReadinessService,
  ) {}

  /**
   * 1. Get Live Exams Publication Dashboard (Admin & Super Admin)
   * GET /admin/exams/results/publication-dashboard
   */
  @Get('admin/exams/results/publication-dashboard')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getPublicationDashboard(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const data = await this.publicationService.getLiveExamsPublicationDashboard({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 10,
      search,
      status,
    });
    return {
      statusCode: HttpStatus.OK,
      message: 'Publication dashboard retrieved successfully',
      data,
    };
  }

  /**
   * 2. Get Live Exam Publication Readiness & Preview Summary
   * GET /super-admin/exams/:examId/results/preview
   * GET /admin/exams/:examId/results/preview
   */
  @Get([
    'super-admin/exams/:examId/results/preview',
    'admin/exams/:examId/results/preview',
    'super-admin/exams/:examId/results/readiness',
    'admin/exams/:examId/results/readiness',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getPublicationPreview(@Param('examId') examId: string) {
    const data = await this.publicationService.getPublicationPreview(examId);
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam publication preview retrieved successfully',
      data,
    };
  }

  /**
   * 3. Super Admin Official Result Publication Execution
   * POST /super-admin/exams/:examId/results/publish
   * POST /admin/exams/:examId/results/publish
   */
  @Post([
    'super-admin/exams/:examId/results/publish',
    'admin/exams/:examId/results/publish',
  ])
  @Roles('SUPER_ADMIN', 'GENERAL_MANAGER')
  async publishExamResults(
    @Param('examId') examId: string,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.publicationService.publishExamResults(
      examId,
      userId,
    );
    return {
      statusCode: HttpStatus.OK,
      message: `Official results for exam '${data.examTitle}' published successfully`,
      data,
    };
  }
}
