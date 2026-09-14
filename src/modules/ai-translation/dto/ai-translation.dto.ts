import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsArray,
  ValidateNested,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ParsedQuestionItemDto {
  @IsNumber()
  @Min(1)
  questionNumber: number;

  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsNotEmpty()
  optionA: string;

  @IsString()
  @IsNotEmpty()
  optionB: string;

  @IsString()
  @IsNotEmpty()
  optionC: string;

  @IsString()
  @IsNotEmpty()
  optionD: string;

  @IsString()
  @IsOptional()
  correctAnswer?: string;
}

export class UploadQuestionPaperDto {
  @IsUUID()
  @IsNotEmpty()
  examScheduleId: string;
}

export class SubmitAiTranslationDto {
  @IsUUID()
  @IsNotEmpty()
  examScheduleId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParsedQuestionItemDto)
  questions: ParsedQuestionItemDto[];
}

export class RetryLanguageDto {
  @IsUUID()
  @IsNotEmpty()
  languageId: string;
}
