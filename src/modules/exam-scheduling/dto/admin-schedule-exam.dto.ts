import {
  IsNotEmpty,
  IsUUID,
  IsISO8601,
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  Min,
  IsIn,
  IsArray,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum NewExamTypeEnum {
  SPECIFIC_SUBJECT = 'SPECIFIC_SUBJECT',
  SPECIFIC_CHAPTER = 'SPECIFIC_CHAPTER',
  FULL_EXAM = 'FULL_EXAM',
}

export enum FullExamTargetEnum {
  JEE = 'JEE',
  NEET = 'NEET',
  CET = 'CET',
}

export class SubjectScheduleItemDto {
  @IsNotEmpty()
  @IsUUID()
  subjectId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  questionCount?: number;
}

export class SubjectGroupScheduleItemDto {
  @IsNotEmpty()
  @IsUUID()
  subjectId: string;

  @IsNotEmpty()
  @IsArray()
  chapterIds: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  questionCount?: number;
}

export class CheckQuestionAvailabilityDto {
  @IsOptional()
  @IsString()
  examType?: string;

  @IsOptional()
  @ValidateIf((o, v) => !!v)
  @IsUUID()
  examTargetId?: string;

  @IsOptional()
  @IsString()
  examTargetName?: string;

  @IsOptional()
  @ValidateIf((o, v) => !!v)
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  subjectIds?: string[] | string;

  @IsOptional()
  @ValidateIf((o, v) => !!v)
  @IsUUID()
  chapterId?: string;

  @IsOptional()
  chapterIds?: string[] | string;

  @IsOptional()
  subjectGroups?: any;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  questionCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requestedCount?: number;
}

export class AdminScheduleExamDto {
  @IsNotEmpty()
  @IsString()
  examType: string; // SPECIFIC_SUBJECT | SPECIFIC_CHAPTER | FULL_EXAM | JEE | NEET | CET

  @IsOptional()
  @IsUUID()
  examId?: string; // If provided, update/edit existing exam schedule

  @IsOptional()
  @IsString()
  examName?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  examTargetName?: string; // 'JEE' | 'NEET' | 'CET'

  @IsOptional()
  @IsUUID()
  examTargetId?: string;

  // Single or multiple subjects for SPECIFIC_SUBJECT
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  @IsArray()
  subjectIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubjectScheduleItemDto)
  subjects?: SubjectScheduleItemDto[];

  // Single or multiple subject/chapter groups for SPECIFIC_CHAPTER
  @IsOptional()
  @IsUUID()
  chapterId?: string;

  @IsOptional()
  @IsArray()
  chapterIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubjectGroupScheduleItemDto)
  subjectGroups?: SubjectGroupScheduleItemDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  questionCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  totalQuestions?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  duration?: number; // in minutes

  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  marksPerQuestion?: number = 4;

  @IsOptional()
  @IsNumber()
  @Min(0)
  negativeMarks?: number = 1;

  @IsOptional()
  @IsUUID()
  languageId?: string;

  @IsOptional()
  @IsArray()
  languageIds?: string[];

  @IsNotEmpty()
  @IsISO8601()
  startTime: string; // ISO 8601 timestamp

  @IsOptional()
  @IsString()
  timezone?: string = 'Asia/Kolkata';
}
