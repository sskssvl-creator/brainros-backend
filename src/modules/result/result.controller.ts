import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ResultService } from './result.service';
import { ResultAccessService } from './services/result-access.service';
import { ResultReadinessService } from './services/result-readiness.service';
import {
  ResultProcessingMonitorService,
  ExamProcessingJobsQueryDto,
} from './services/result-processing-monitor.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ResultController {
  constructor(
    private readonly resultService: ResultService,
    private readonly resultAccessService: ResultAccessService,
    private readonly readinessService: ResultReadinessService,
    private readonly monitorService: ResultProcessingMonitorService,
  ) {}

  @Post('results/:attemptId/calculate')
  @Roles('ADMIN', 'SUPER_ADMIN', 'STUDENT')
  calculateResult(@Param('attemptId') attemptId: string) {
    return this.resultService.calculateResult(attemptId);
  }

  @Post('results/:attemptId/recalculate')
  @Roles('ADMIN', 'SUPER_ADMIN')
  recalculateResult(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
    @Body('evaluationVersion') evaluationVersion?: number,
  ) {
    return this.resultService.recalculateResult(
      attemptId,
      user,
      evaluationVersion || 2,
    );
  }

  /**
   * Result Status & Availability Endpoint.
   * Supports:
   *  GET /results/:attemptId/status
   *  GET /students/me/results/:attemptId/status
   */
  @Get(['results/:attemptId/status', 'students/me/results/:attemptId/status'])
  getAttemptResultStatus(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultAccessService.getResultStatus(user, attemptId);
  }

  /**
   * Deep Result Verification Endpoint for Reconciliation & Observability.
   * Checks durable artifacts (Result, SubjectResult, ChapterResult, Time/Strategy, Rank).
   */
  @Get(['results/:attemptId/verify', 'students/me/results/:attemptId/verify'])
  verifyResult(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.verifyResult(attemptId);
  }

  /**
   * Result Report Endpoint.
   * Pure Read-Only. Never triggers recalculation.
   * Supports:
   *  GET /results/:attemptId
   *  GET /students/me/results/:attemptId
   */
  @Get(['results/:attemptId', 'students/me/results/:attemptId'])
  getResult(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getResult(attemptId, user);
  }

  /**
   * Complete Brainros Analysis Engine Report
   * Includes Overall, Subject, Chapter, Time, Strategy, and Recommendations.
   * Pure Read-Only. Never triggers recalculation.
   * Supports:
   *  GET /results/:attemptId/analysis
   *  GET /students/me/results/:attemptId/analysis
   */
  @Get(['results/:attemptId/analysis', 'students/me/results/:attemptId/analysis'])
  getFullAnalysis(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getFullAnalysis(attemptId, user);
  }

  @Get('results/:attemptId/subjects')
  getSubjectResults(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getSubjectResults(attemptId, user);
  }

  @Get('results/:attemptId/chapters')
  getChapterResults(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getChapterResults(attemptId, user);
  }

  @Get('results/:attemptId/time-analysis')
  getTimeAnalysis(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getTimeAnalysis(attemptId, user);
  }

  @Get('results/:attemptId/strategy')
  getAttemptStrategy(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getAttemptStrategy(attemptId, user);
  }

  @Get('results/:attemptId/recommendations')
  getRecommendations(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getRecommendations(attemptId, user);
  }

  @Get('results/:attemptId/review')
  getAnswerReview(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.getAnswerReview(attemptId, user);
  }

  /**
   * Exam Analysis Report PDF Download Endpoint
   * Returns full 3-page PDF with KPIs, subject, chapter, time, strategy & question audit.
   * Supports:
   *  GET /results/:attemptId/pdf
   *  GET /students/me/results/:attemptId/pdf
   */
  @Get(['results/:attemptId/pdf', 'students/me/results/:attemptId/pdf'])
  async getResultPdf(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
    @Res() res: any,
  ) {
    const pdfBuffer = await this.resultService.generateResultPdf(attemptId, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="Exam_Analysis_Report_${attemptId}.pdf"`,
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }

  /**
   * Exam Analysis Report Email Dispatch Endpoint
   * Sends comprehensive PDF report with all details directly to the student's registered email.
   * Supports:
   *  POST /results/:attemptId/send-email
   *  POST /students/me/results/:attemptId/send-email
   *  POST /admin/attempts/:attemptId/send-report
   */
  @Post([
    'results/:attemptId/send-email',
    'students/me/results/:attemptId/send-email',
    'admin/attempts/:attemptId/send-report',
  ])
  async sendResultEmail(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: any,
  ) {
    return this.resultService.sendReportEmail(attemptId, user);
  }

  /**
   * Admin / Super Admin Exam Result Processing View & Stuck Attempt Detection.
   * GET /admin/exams/:examId/results/processing-status
   * GET /super-admin/exams/:examId/results/processing-status
   */
  @Get([
    'admin/exams/:examId/results/processing-status',
    'super-admin/exams/:examId/results/processing-status',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async getExamProcessingStatus(@Param('examId') examId: string) {
    const data = await this.readinessService.getExamProcessingDetails(examId);
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam processing status retrieved successfully',
      data,
    };
  }

  /**
   * 1. Super Admin Real-Time Exam Processing Summary
   * GET /super-admin/exams/:examId/results/processing-summary
   */
  @Get([
    'super-admin/exams/:examId/results/processing-summary',
    'admin/exams/:examId/results/processing-summary',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async getExamProcessingSummary(@Param('examId') examId: string) {
    const data = await this.monitorService.getExamProcessingSummary(examId);
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam processing summary retrieved successfully',
      data,
    };
  }

  /**
   * 2. Super Admin Real-Time Job-by-Job Paginated Table
   * GET /super-admin/exams/:examId/results/processing-jobs
   */
  @Get([
    'super-admin/exams/:examId/results/processing-jobs',
    'admin/exams/:examId/results/processing-jobs',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async getExamProcessingJobs(
    @Param('examId') examId: string,
    @Query() query: ExamProcessingJobsQueryDto,
  ) {
    const data = await this.monitorService.getExamProcessingJobs(examId, query);
    return {
      statusCode: HttpStatus.OK,
      message: 'Exam processing jobs retrieved successfully',
      data,
    };
  }

  /**
   * 3. Super Admin Inspection Details for a Single Job
   * GET /super-admin/exams/:examId/results/processing-jobs/:jobId
   */
  @Get([
    'super-admin/exams/:examId/results/processing-jobs/:jobId',
    'admin/exams/:examId/results/processing-jobs/:jobId',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async getJobDetail(
    @Param('examId') examId: string,
    @Param('jobId') jobId: string,
  ) {
    const data = await this.monitorService.getJobDetail(examId, jobId);
    return {
      statusCode: HttpStatus.OK,
      message: 'Job details retrieved successfully',
      data,
    };
  }

  /**
   * 4. Super Admin Batch Retry for all Failed Jobs
   * POST /super-admin/exams/:examId/results/processing-jobs/retry-failed
   */
  @Post([
    'super-admin/exams/:examId/results/processing-jobs/retry-failed',
    'admin/exams/:examId/results/processing-jobs/retry-failed',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async retryFailedJobs(
    @Param('examId') examId: string,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.monitorService.retryFailedJobs(examId, userId);
    return {
      statusCode: HttpStatus.OK,
      message: data.message,
      data,
    };
  }

  /**
   * 5. Super Admin Retry for a Single Job
   * POST /super-admin/exams/:examId/results/processing-jobs/:jobId/retry
   */
  @Post([
    'super-admin/exams/:examId/results/processing-jobs/:jobId/retry',
    'admin/exams/:examId/results/processing-jobs/:jobId/retry',
  ])
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER')
  async retrySingleJob(
    @Param('examId') examId: string,
    @Param('jobId') jobId: string,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.monitorService.retrySingleJob(examId, jobId, userId);
    return {
      statusCode: HttpStatus.OK,
      message: data.message,
      data,
    };
  }
}
