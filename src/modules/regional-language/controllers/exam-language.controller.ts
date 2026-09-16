import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ExamLanguageService } from '../services/exam-language.service';
import { SetExamLanguagesDto } from '../dto/exam-language.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@Controller('exams/:examId/languages')
export class ExamLanguageController {
  constructor(private readonly examLanguageService: ExamLanguageService) {}

  /**
   * Get enabled languages for an exam
   * GET /exams/:examId/languages
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT', 'ADMIN', 'SUPER_ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  getExamLanguages(@Param('examId') examId: string) {
    return this.examLanguageService.getExamLanguages(examId);
  }

  /**
   * Configure enabled languages for an exam (Admin/SuperAdmin)
   * PUT /exams/:examId/languages
   */
  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @HttpCode(HttpStatus.OK)
  setExamLanguages(
    @Param('examId') examId: string,
    @Body() dto: SetExamLanguagesDto,
  ) {
    return this.examLanguageService.setExamLanguages(examId, dto);
  }
}
