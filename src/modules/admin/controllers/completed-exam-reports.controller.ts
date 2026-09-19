import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { CompletedExamReportsService } from '../services/completed-exam-reports.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  'SUPER_ADMIN',
  'ADMIN',
  'GENERAL_MANAGER',
  'MANAGER',
  'OPERATOR',
  'ACCOUNTANT',
  'SALES_AGENT',
  'STAFF',
  'STUDENT',
  'PARENT',
  'TEACHER',
  'INSTITUTION',
)
export class CompletedExamReportsController {
  constructor(
    private readonly reportsService: CompletedExamReportsService,
  ) {}

  /**
   * List all completed exams with pagination, search and filters.
   * GET /admin/exam-history
   * GET /super-admin/exam-history
   */
  @Get(['admin/exam-history', 'super-admin/exam-history'])
  async getExamHistory(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('examTargetId') examTargetId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    const data = await this.reportsService.getCompletedExamHistoryPaginated({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 10,
      search,
      examTargetId,
      startDate,
      endDate,
      sortBy,
      sortOrder,
    });
    return {
      statusCode: HttpStatus.OK,
      message: 'Completed exam history retrieved successfully',
      data,
    };
  }

  /**
   * Get full granular details of a completed exam.
   * GET /admin/exam-history/:examId/details
   * GET /super-admin/exam-history/:examId/details
   */
  @Get(['admin/exam-history/:examId/details', 'super-admin/exam-history/:examId/details'])
  async getExamHistoryDetails(@Param('examId') examId: string) {
    const data = await this.reportsService.getCompletedExamFullDetails(examId);
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam full details retrieved successfully',
      data,
    };
  }

  /**
   * List all completed Live Exams (latest first, excluding mock tests).
   * GET /admin/completed-exams
   * GET /super-admin/completed-exams
   */
  @Get(['admin/completed-exams', 'super-admin/completed-exams'])
  async getCompletedLiveExams() {
    const data = await this.reportsService.getCompletedLiveExams();
    return {
      statusCode: HttpStatus.OK,
      message: 'Completed live exams retrieved successfully',
      data,
    };
  }

  /**
   * Get latest completed Live Exam.
   * GET /admin/completed-exams/latest
   * GET /super-admin/completed-exams/latest
   */
  @Get(['admin/completed-exams/latest', 'super-admin/completed-exams/latest'])
  async getLatestCompletedLiveExam() {
    const data = await this.reportsService.getLatestCompletedLiveExam();
    return {
      statusCode: HttpStatus.OK,
      message: 'Latest completed live exam retrieved successfully',
      data,
    };
  }

  /**
   * Get KPI Summary for a specific completed Live Exam.
   * GET /admin/completed-exams/:examId/summary
   * GET /super-admin/completed-exams/:examId/summary
   */
  @Get([
    'admin/completed-exams/:examId/summary',
    'super-admin/completed-exams/:examId/summary',
  ])
  async getLiveExamSummary(@Param('examId') examId: string) {
    const data = await this.reportsService.getLiveExamSummary(examId);
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam summary metrics retrieved successfully',
      data,
    };
  }

  /**
   * Get student attendees list for the selected Live Exam.
   * GET /admin/completed-exams/:examId/attendees
   * GET /super-admin/completed-exams/:examId/attendees
   */
  @Get([
    'admin/completed-exams/:examId/attendees',
    'super-admin/completed-exams/:examId/attendees',
  ])
  async getLiveExamAttendees(
    @Param('examId') examId: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.reportsService.getLiveExamAttendees(examId, {
      search,
      status,
      sortBy,
      sortOrder,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam attendees retrieved successfully',
      data,
    };
  }

  /**
   * Pure Read-Only Student Analysis & Question Review for a specific attempt.
   * GET /admin/completed-exams/:examId/attendees/:attemptId/analysis
   * GET /super-admin/completed-exams/:examId/attendees/:attemptId/analysis
   */
  @Get([
    'admin/completed-exams/:examId/attendees/:attemptId/analysis',
    'super-admin/completed-exams/:examId/attendees/:attemptId/analysis',
  ])
  async getStudentAttemptAnalysis(
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.reportsService.getStudentAttemptAnalysis(
      examId,
      attemptId,
      user,
    );
    return {
      statusCode: HttpStatus.OK,
      message: 'Student attempt analysis retrieved successfully',
      data,
    };
  }

  /**
   * Approve Student Analysis Report.
   * POST /admin/completed-exams/:examId/attempts/:attemptId/approve
   * POST /super-admin/completed-exams/:examId/attempts/:attemptId/approve
   */
  @Post([
    'admin/completed-exams/:examId/attempts/:attemptId/approve',
    'super-admin/completed-exams/:examId/attempts/:attemptId/approve',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'STAFF')
  async approveReport(
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.reportsService.approveReport(
      examId,
      attemptId,
      user,
    );
    return {
      statusCode: HttpStatus.OK,
      message: 'Student analysis report approved successfully',
      data,
    };
  }

  /**
   * Queue PDF report generation and email delivery via BullMQ.
   * POST /admin/completed-exams/:examId/attempts/:attemptId/send-report
   * POST /super-admin/completed-exams/:examId/attempts/:attemptId/send-report
   */
  @Post([
    'admin/completed-exams/:examId/attempts/:attemptId/send-report',
    'super-admin/completed-exams/:examId/attempts/:attemptId/send-report',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'STAFF')
  async sendStudentReportEmail(
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.reportsService.queueReportEmail(
      examId,
      attemptId,
      user,
    );
    return {
      statusCode: HttpStatus.ACCEPTED,
      message: 'Student report email job queued successfully',
      data,
    };
  }

  /**
   * Queue PDF report generation and email delivery to student's Institute via BullMQ.
   * POST /admin/completed-exams/:examId/attempts/:attemptId/send-report-to-institute
   * POST /super-admin/completed-exams/:examId/attempts/:attemptId/send-report-to-institute
   */
  @Post([
    'admin/completed-exams/:examId/attempts/:attemptId/send-report-to-institute',
    'super-admin/completed-exams/:examId/attempts/:attemptId/send-report-to-institute',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'STAFF')
  async sendInstituteReportEmail(
    @Param('examId') examId: string,
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.reportsService.queueReportToInstituteEmail(
      examId,
      attemptId,
      user,
    );
    return {
      statusCode: HttpStatus.ACCEPTED,
      message: 'Student analysis report has been queued for sending to the institute.',
      data,
    };
  }

  /**
   * Queue PDF report generation and email delivery for all evaluated student attendees via BullMQ.
   * POST /admin/completed-exams/:examId/send-all-reports
   * POST /super-admin/completed-exams/:examId/send-all-reports
   */
  @Post([
    'admin/completed-exams/:examId/send-all-reports',
    'super-admin/completed-exams/:examId/send-all-reports',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR', 'STAFF')
  async sendAllReportEmails(
    @Param('examId') examId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.reportsService.sendAllReportEmails(
      examId,
      user,
    );
    return {
      statusCode: HttpStatus.ACCEPTED,
      message: 'Bulk student report emails queued successfully',
      data,
    };
  }
}

