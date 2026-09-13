import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { LanguageService } from './services/language.service';
import { ExamLanguageService } from './services/exam-language.service';
import { LanguageController } from './controllers/language.controller';
import { ExamLanguageController } from './controllers/exam-language.controller';

@Module({
  imports: [RedisModule],
  controllers: [
    LanguageController,
    ExamLanguageController,
  ],
  providers: [
    LanguageService,
    ExamLanguageService,
  ],
  exports: [
    LanguageService,
    ExamLanguageService,
  ],
})
export class RegionalLanguageModule {}
