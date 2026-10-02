import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsNumber,
  IsNotEmpty,
  IsIn,
  IsUUID,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum ExamImportFormatEnum {
  XLSX = 'xlsx',
  CSV = 'csv',
}

export enum ExamImportStatusEnum {
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  READY_TO_IMPORT = 'READY_TO_IMPORT',
  IMPORTING = 'IMPORTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export class ExamImportFilterDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  search?: string;
}

export interface ParsedExamPaperRow {
  rowNumber: number;
  examCode: string;
  examName: string;
  examDescription?: string;
  examTarget?: string;
  durationMinutes: number;
  totalMarks?: number;
  subject: string;
  sectionName?: string;
  chapter?: string;
  topic?: string;
  questionNumber?: number;
  questionType?: string;
  questionText: string;
  passageText?: string;
  assertionText?: string;
  reasonText?: string;
  optionA?: string;
  optionB?: string;
  optionC?: string;
  optionD?: string;
  optionE?: string;
  optionF?: string;
  correctAnswer: string;
  marks?: number;
  negativeMarks?: number;
  difficulty?: string;
  explanation?: string;
  language?: string;
}

export interface ExamPaperValidationError {
  row: number;
  column?: string;
  message: string;
}

export interface ExamPaperValidationResult {
  isValid: boolean;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  examCount: number;
  examCode: string;
  examTitle: string;
  durationMinutes: number;
  totalMarks: number;
  totalQuestions: number;
  sections: Array<{
    name: string;
    subject: string;
    questionCount: number;
  }>;
  errors: ExamPaperValidationError[];
  warnings: string[];
  validatedRows: Array<{
    rowNumber: number;
    isValid: boolean;
    errors: string[];
    warnings: string[];
    data: ParsedExamPaperRow;
  }>;
}

export interface BlueprintSubjectRule {
  subject: string;
  questionCount: number;
  marks?: number;
}

export interface BlueprintItemDto {
  id: string;
  name: string;
  code: string;
  description?: string;
  totalQuestions: number;
  durationMinutes: number;
  status: 'ACTIVE' | 'INACTIVE';
  subjectDistribution: BlueprintSubjectRule[];
  examTargetId?: string;
}

export interface TranslationValidationSummary {
  languageId: string;
  languageCode: string;
  languageName: string;
  fileName: string;
  totalQuestions: number;
  translatedQuestions: number;
  coveragePercentage: number;
  validRows: number;
  invalidRows: number;
  errors: string[];
}

export interface ComprehensiveExamValidationResult {
  isValid: boolean;
  blueprint: {
    id: string;
    name: string;
    totalQuestions: number;
    isMatched: boolean;
    subjectChecks: Array<{
      subject: string;
      expectedCount: number;
      actualCount: number;
      isMatched: boolean;
    }>;
  };
  questionsSummary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    totalQuestions: number;
    totalMarks: number;
    durationMinutes: number;
    subjectCounts: Record<string, number>;
  };
  translationsSummary: TranslationValidationSummary[];
  previewRows: Array<{
    rowNumber: number;
    questionNumber?: number;
    subject: string;
    chapter?: string;
    questionText: string;
    questionType: string;
    options: Array<{ key: string; text: string; isCorrect: boolean }>;
    correctAnswer: string;
    difficulty?: string;
    status: 'VALID' | 'INVALID';
    errors: string[];
  }>;
  errors: Array<{ row: number; column?: string; message: string }>;
  warnings: string[];
}

export class CreateExamFromUploadDto {
  @IsString()
  title: string;

  @IsString()
  blueprintId: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  durationMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  defaultMarksPerQuestion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  defaultNegativeMarks?: number;

  @IsOptional()
  @IsString()
  instructions?: string;
}

export class ExamManagerFilterDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';

  @IsOptional()
  missingQuestionPaperOnly?: boolean | string;

  @IsOptional()
  notConductedOnly?: boolean | string;

  @IsOptional()
  excludeCompleted?: boolean | string;
}

export class ManualQuestionItemDto {
  @IsNotEmpty()
  @IsString()
  questionText: string;

  @IsNotEmpty()
  @IsIn(['EASY', 'MEDIUM', 'HARD', 'VERY_HARD'])
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'VERY_HARD';

  @IsNotEmpty()
  @IsIn([
    'SINGLE_CORRECT',
    'MULTIPLE_CORRECT',
    'NUMERICAL',
    'ASSERTION_REASON',
    'MATCH_FOLLOWING',
  ])
  type:
    | 'SINGLE_CORRECT'
    | 'MULTIPLE_CORRECT'
    | 'NUMERICAL'
    | 'ASSERTION_REASON'
    | 'MATCH_FOLLOWING';

  @IsOptional()
  questionContent?: any;

  @IsOptional()
  @IsString()
  optionA?: string;

  @IsOptional()
  optionAContent?: any;

  @IsOptional()
  @IsString()
  optionB?: string;

  @IsOptional()
  optionBContent?: any;

  @IsOptional()
  @IsString()
  optionC?: string;

  @IsOptional()
  optionCContent?: any;

  @IsOptional()
  @IsString()
  optionD?: string;

  @IsOptional()
  optionDContent?: any;

  @IsOptional()
  @IsString()
  correctAnswer?: string;

  @IsOptional()
  @IsArray()
  correctAnswers?: string[];

  @IsOptional()
  numericalAnswer?: number | string;

  @IsOptional()
  @IsString()
  assertion?: string;

  @IsOptional()
  assertionContent?: any;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  reasonContent?: any;

  @IsOptional()
  @IsArray()
  columnA?: Array<{ key: string; text: string }>;

  @IsOptional()
  @IsArray()
  columnB?: Array<{ key: string; text: string }>;

  @IsOptional()
  @IsArray()
  matchPairs?: Array<{ left: string; right: string }>;

  @IsOptional()
  @IsString()
  explanation?: string;

  @IsOptional()
  explanationContent?: any;

  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  @IsUUID()
  chapterId?: string;

  @IsOptional()
  @IsNumber()
  marks?: number;

  @IsOptional()
  @IsNumber()
  negativeMarks?: number;
}

export class SubmitManualQuestionsDto {
  @IsNotEmpty()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualQuestionItemDto)
  questions: ManualQuestionItemDto[];
}

