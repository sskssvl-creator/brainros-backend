import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AiTranslationService } from '../services/ai-translation.service';
import {
  SubmitAiTranslationDto,
  RetryLanguageDto,
} from '../dto/ai-translation.dto';

@Controller('ai-translations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
export class AiTranslationController {
  constructor(private readonly aiTranslationService: AiTranslationService) {}

  /**
   * GET /api/ai-translations/scheduled-exams
   * List eligible scheduled exams
   */
  @Get('scheduled-exams')
  async getScheduledExams() {
    return this.aiTranslationService.getScheduledExams();
  }

  /**
   * POST /api/ai-translations/upload
   * Upload and validate question paper file (multipart/form-data)
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadQuestionPaper(
    @UploadedFile() file: Express.Multer.File,
    @Body('examScheduleId') examScheduleId: string,
  ) {
    return this.aiTranslationService.uploadAndValidate(file, examScheduleId);
  }

  /**
   * POST /api/ai-translations/submit
   * Persist questions and start BullMQ translation job
   */
  @Post('submit')
  async submitQuestionPaper(
    @Body() dto: SubmitAiTranslationDto,
    @CurrentUser() user: any,
  ) {
    const userId = user?.userId || user?.id;
    return this.aiTranslationService.submitAndStartTranslation(dto, userId);
  }

  /**
   * GET /api/ai-translations/jobs/:jobId
   * Get translation job status & per-language breakdown
   */
  @Get('jobs/:jobId')
  async getJobStatus(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.aiTranslationService.getJobStatus(jobId);
  }

  /**
   * GET /api/ai-translations/jobs/:jobId/questions
   * Get question paper details with translations
   */
  @Get('jobs/:jobId/questions')
  async getJobQuestions(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.aiTranslationService.getJobQuestions(jobId);
  }

  /**
   * POST /api/ai-translations/jobs/:jobId/retry
   * Retry whole failed translation job
   */
  @Post('jobs/:jobId/retry')
  async retryJob(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: any,
  ) {
    const userId = user?.userId || user?.id;
    return this.aiTranslationService.retryJob(jobId, userId);
  }

  /**
   * POST /api/ai-translations/jobs/:jobId/languages/:languageId/retry
   * Retry specific language translation
   */
  @Post('jobs/:jobId/languages/:languageId/retry')
  async retryLanguage(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('languageId', ParseUUIDPipe) languageId: string,
    @CurrentUser() user: any,
  ) {
    const userId = user?.userId || user?.id;
    return this.aiTranslationService.retryLanguage(jobId, languageId, userId);
  }

  /**
   * GET /api/ai-translations/sample/csv
   * Download sample CSV template
   */
  @Get('sample/csv')
  async downloadSampleCsv(@Res() res: Response) {
    const fileData = await this.aiTranslationService.getSampleTemplate('csv');
    res.setHeader('Content-Type', fileData.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileData.fileName}"`,
    );
    res.send(fileData.buffer);
  }

  /**
   * GET /api/ai-translations/sample/xlsx
   * Download sample Excel template
   */
  @Get('sample/xlsx')
  async downloadSampleXlsx(@Res() res: Response) {
    const fileData = await this.aiTranslationService.getSampleTemplate('xlsx');
    res.setHeader('Content-Type', fileData.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileData.fileName}"`,
    );
    res.send(fileData.buffer);
  }
}
