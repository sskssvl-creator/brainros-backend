import { Module } from '@nestjs/common';
import { ExamController } from './exam.controller';
import { PublicExamController } from './controllers/public-exam.controller';
import { PublicContactController } from './controllers/public-contact.controller';
import { ExamManagerController } from './controllers/exam-manager.controller';
import { ExamService } from './exam.service';
import { ExamPaperParserService } from './services/exam-paper-parser.service';
import { ExamPaperValidatorService } from './services/exam-paper-validator.service';
import { ExamPaperImportService } from './services/exam-paper-import.service';
import { ExamImportProcessor } from './processors/exam-import.processor';
import { BullModule } from '@nestjs/bullmq';
import { JobProgressModule } from '../job-progress/job-progress.module';
import { AiTranslationModule } from '../ai-translation/ai-translation.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'exam-import-queue',
    }),
    JobProgressModule,
    AiTranslationModule,
    AdminModule,
  ],
  controllers: [
    ExamController,
    PublicExamController,
    PublicContactController,
    ExamManagerController,
  ],
  providers: [
    ExamService,
    ExamPaperParserService,
    ExamPaperValidatorService,
    ExamPaperImportService,
    ExamImportProcessor,
  ],
  exports: [
    ExamService,
    ExamPaperParserService,
    ExamPaperValidatorService,
    ExamPaperImportService,
    ExamImportProcessor,
    BullModule,
  ],
})
export class ExamModule {}
