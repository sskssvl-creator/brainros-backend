export interface RowValidationError {
  rowNumber: number;
  field: string;
  message: string;
}

export interface ParsedQuestionRow {
  rowNumber: number;
  questionNumber: number;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  isValid: boolean;
  errors: string[];
}

export interface UploadValidationResponse {
  isValid: boolean;
  totalRows: number;
  validRowsCount: number;
  invalidRowsCount: number;
  expectedQuestionsCount: number;
  examTitle: string;
  examCode: string;
  examScheduleId: string;
  examId: string;
  examVersionId: string;
  targetLanguages: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  rows: ParsedQuestionRow[];
  globalErrors: string[];
}

export interface LanguageTranslationProgress {
  languageId: string;
  languageName: string;
  languageCode: string;
  status: 'QUEUED' | 'WAITING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  completedQuestions: number;
  totalQuestions: number;
  failedBatches: number;
  errorMessage?: string;
}

export interface AiTranslationJobDetails {
  id: string;
  examId: string;
  examVersionId: string;
  examTitle?: string;
  examCode?: string;
  totalQuestions: number;
  totalLanguages: number;
  batchSize: number;
  status: string;
  overallProgress: number;
  dbSaveProgress?: number;
  languageStatuses: LanguageTranslationProgress[];
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
