import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Res,
  BadRequestException,
} from '@nestjs/common';
import {
  FileInterceptor,
  AnyFilesInterceptor,
} from '@nestjs/platform-express';
import type { Response } from 'express';
import { ExamPaperImportService } from '../services/exam-paper-import.service';
import { ExamService } from '../exam.service';
import {
  ExamImportFormatEnum,
  ExamImportFilterDto,
  CreateExamFromUploadDto,
  ExamManagerFilterDto,
  SubmitManualQuestionsDto,
} from '../dto/exam-manager.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('admin/exam-manager')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExamManagerController {
  constructor(
    private readonly examPaperImportService: ExamPaperImportService,
    private readonly examService: ExamService,
  ) {}

  /**
   * 1. Get all active predefined & custom blueprints from master data
   * GET /admin/exam-manager/blueprints
   */
  @Get('blueprints')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getBlueprints() {
    const data = await this.examPaperImportService.getActiveBlueprints();
    return {
      statusCode: 200,
      message: 'Active exam blueprints retrieved successfully',
      data,
    };
  }

  /**
   * 2. Validate Question Paper + Multiple Simultaneous Regional Translation Files against Blueprint
   * POST /admin/exam-manager/validate
   */
  @Post('validate')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(AnyFilesInterceptor())
  async validateUpload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { blueprintId: string; languageIds?: string | string[] },
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded for validation.');
    }

    const questionFile = files.find(
      (f) =>
        f.fieldname === 'questionFile' ||
        f.fieldname === 'file' ||
        !f.fieldname.startsWith('translation_'),
    );

    if (!questionFile) {
      throw new BadRequestException('Question paper file is required.');
    }

    // Extract translation files
    const translationFiles: Array<{
      file: Express.Multer.File;
      languageId: string;
    }> = [];

    for (const f of files) {
      if (f.fieldname.startsWith('translation_')) {
        const langId = f.fieldname.replace('translation_', '');
        translationFiles.push({ file: f, languageId: langId });
      }
    }

    const data =
      await this.examPaperImportService.validateQuestionPaperAndTranslations(
        questionFile,
        body.blueprintId,
        translationFiles,
      );

    return {
      statusCode: 200,
      message: data.isValid
        ? 'Question paper and translations validated successfully.'
        : 'Validation completed with errors.',
      data,
    };
  }

  /**
   * 3. Transactionally Create Draft Exam + Sections + Questions + Immutable Version + Translations
   * POST /admin/exam-manager/create-from-upload
   */
  @Post('create-from-upload')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(AnyFilesInterceptor())
  async createExamFromUpload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: CreateExamFromUploadDto,
    @CurrentUser() user: { userId: string },
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded for exam creation.');
    }

    const questionFile = files.find(
      (f) =>
        f.fieldname === 'questionFile' ||
        f.fieldname === 'file' ||
        !f.fieldname.startsWith('translation_'),
    );

    if (!questionFile) {
      throw new BadRequestException('Question paper file is required.');
    }

    const translationFiles: Array<{
      file: Express.Multer.File;
      languageId: string;
    }> = [];

    for (const f of files) {
      if (f.fieldname.startsWith('translation_')) {
        const langId = f.fieldname.replace('translation_', '');
        translationFiles.push({ file: f, languageId: langId });
      }
    }

    const data =
      await this.examPaperImportService.createExamFromValidatedUpload(
        body,
        questionFile,
        translationFiles,
        user.userId,
      );

    return {
      statusCode: 201,
      message: 'Exam created successfully in DRAFT status.',
      data,
    };
  }

  /**
   * Download CSV or Excel Question Paper Template
   * GET /admin/exam-manager/template
   */
  @Get('template')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async downloadTemplate(
    @Query('format') format: ExamImportFormatEnum = ExamImportFormatEnum.XLSX,
    @Res() res: Response,
  ) {
    const { buffer, fileName, contentType } =
      await this.examPaperImportService.generateTemplate(format);

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );
    res.send(buffer);
  }

  /**
   * Upload Question Paper CSV/Excel and Transactionally Auto-Create Exam + Sections + Questions
   * POST /admin/exam-manager/import
   */
  @Post('import')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(FileInterceptor('file'))
  async uploadQuestionPaper(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { userId: string },
  ) {
    return this.examPaperImportService.processQuestionPaperUpload(
      file,
      user.userId,
    );
  }

  /**
   * Get single import session status & metrics
   * GET /admin/exam-manager/import/:importId
   */
  @Get('import/:importId')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  getImportSession(@Param('importId') importId: string) {
    return this.examPaperImportService.getImportSession(importId);
  }

  /**
   * Get paginated staging rows for error diagnostics
   * GET /admin/exam-manager/import/:importId/rows
   */
  @Get('import/:importId/rows')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  getImportRows(
    @Param('importId') importId: string,
    @Query() query: ExamImportFilterDto,
  ) {
    return this.examPaperImportService.getImportRows(importId, query);
  }

  /**
   * Get list of historical question paper imports
   * GET /admin/exam-manager/import-history
   */
  @Get('import-history')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  getImportHistory(@Query() query: ExamImportFilterDto) {
    return this.examPaperImportService.getImportHistory(query);
  }

  /**
   * Download Error Report (.xlsx or .csv) for failed question paper upload
   * GET /admin/exam-manager/import/:importId/errors/export
   */
  @Get('import/:importId/errors/export')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async exportImportErrors(
    @Param('importId') importId: string,
    @Query('format') format: ExamImportFormatEnum = ExamImportFormatEnum.XLSX,
    @Res() res: Response,
  ) {
    const { buffer, fileName, contentType } =
      await this.examPaperImportService.generateErrorReport(importId, format);

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );
    res.send(buffer);
  }

  /**
   * Get all exams list with search, status, type filter & pagination
   * GET /admin/exam-manager/exams
   */
  @Get('exams')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getAllExams(@Query() filter: ExamManagerFilterDto) {
    return this.examPaperImportService.getAllExamsList(filter);
  }

  /**
   * Get exam details by ID
   * GET /admin/exam-manager/exams/:id
   */
  @Get('exams/:id')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  getExamById(@Param('id') id: string) {
    return this.examService.findExamById(id);
  }

  /**
   * Preview Question Paper upload (validates CSV/Excel & compatibility without persisting)
   * POST /admin/exam-manager/exams/:examId/preview-upload
   */
  @Post('exams/:examId/preview-upload')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(FileInterceptor('file'))
  async previewQuestionPaperUpload(
    @Param('examId') examId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Question paper file is required.');
    }
    const data = await this.examPaperImportService.previewQuestionPaperUpload(
      file,
      examId,
    );
    return {
      statusCode: 200,
      message: data.isValid
        ? 'Question paper validated successfully.'
        : 'Validation completed with errors.',
      data,
    };
  }

  /**
   * Submit Question Paper for background BullMQ processing with inline WebSocket progress
   * POST /admin/exam-manager/exams/:examId/submit-upload
   */
  @Post('exams/:examId/submit-upload')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(FileInterceptor('file'))
  async submitQuestionPaperUpload(
    @Param('examId') examId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { userId: string },
  ) {
    if (!file) {
      throw new BadRequestException('Question paper file is required.');
    }
    const result = await this.examPaperImportService.submitQuestionPaperUpload(
      file,
      examId,
      user.userId,
    );
    return {
      statusCode: 202,
      message: result.message,
      data: result,
    };
  }

  /**
   * Submit Manually Entered Questions for an Exam
   * POST /admin/exam-manager/exams/:examId/manual-questions
   */
  @Post('exams/:examId/manual-questions')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async submitManualQuestions(
    @Param('examId') examId: string,
    @Body() dto: SubmitManualQuestionsDto,
    @CurrentUser() user: { userId: string },
  ) {
    const result = await this.examPaperImportService.submitManualQuestions(
      examId,
      dto,
      user.userId,
    );
    return {
      statusCode: 200,
      message: result.message,
      data: result.data,
    };
  }

  /**
   * Dedicated Read-Only View of Question Paper with all questions, options & answers
   * GET /admin/exam-manager/exams/:examId/question-paper
   */
  @Get('exams/:examId/question-paper')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getExamQuestionPaper(@Param('examId') examId: string) {
    const data = await this.examPaperImportService.getExamQuestionPaper(examId);
    return {
      statusCode: 200,
      message: 'Question paper retrieved successfully.',
      data,
    };
  }

  /**
   * Alias for Question Paper View
   * GET /admin/exam-manager/question-papers/:examId
   */
  @Get('question-papers/:examId')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async getQuestionPaperDetail(@Param('examId') examId: string) {
    const data = await this.examPaperImportService.getExamQuestionPaper(examId);
    return {
      statusCode: 200,
      message: 'Question paper retrieved successfully.',
      data,
    };
  }

  /**
   * Retry failed question paper upload
   * POST /admin/exam-manager/exams/:examId/retry-upload
   */
  @Post('exams/:examId/retry-upload')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  async retryQuestionPaperUpload(
    @Param('examId') examId: string,
    @CurrentUser() user: { userId: string },
  ) {
    const result = await this.examPaperImportService.retryQuestionPaperUpload(
      examId,
      user.userId,
    );
    return {
      statusCode: 200,
      message: result.message,
      data: result,
    };
  }
}

