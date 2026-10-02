export const EXAM_CACHE_PREPARATION_QUEUE_NAME = 'exam-cache-preparation';

export interface ExamOptionSnapshotItem {
  id: string; // matches Option ID / examQuestionOptionId
  sourceOptionId?: string;
  optionKey: string;
  optionLabel: string;
  optionText: string;
  optionContent?: any;
  displayOrder: number;
  isCorrect?: boolean; // Kept in snapshot for evaluation/audit; omitted before sending to students
  translations?: Record<string, { optionText: string; optionContent?: any }>;
}

export interface ExamQuestionSnapshotItem {
  examQuestionId: string; // ID used in AttemptQuestion.examQuestionId
  sourceQuestionId: string; // Underlying Question ID
  sequenceNumber: number;
  displayOrder: number;
  sectionId?: string | null;
  section?: { id: string; name: string; subjectId?: string | null } | null;
  marks: number;
  negativeMarks: number;
  questionType: string;
  difficultyLevel?: string;
  questionText: string;
  questionContent?: any;
  passage?: string | null;
  passageContent?: any;
  assertion?: string | null;
  assertionContent?: any;
  reason?: string | null;
  reasonContent?: any;
  explanation?: string | null; // Kept in snapshot for evaluation/audit; omitted before sending to students
  correctAnswer?: any; // Kept in snapshot for evaluation/audit; omitted before sending to students
  options: ExamOptionSnapshotItem[];
  optionsById: Record<string, ExamOptionSnapshotItem>;
  translations: Record<
    string,
    {
      questionText: string;
      questionContent?: any;
      passageText?: string | null;
      passageContent?: any;
      assertionText?: string | null;
      assertionContent?: any;
      reasonText?: string | null;
      reasonContent?: any;
    }
  >;
}

export interface ExamQuestionPaperSnapshot {
  examId: string;
  examVersionId: string;
  versionNumber: number;
  totalQuestions: number;
  durationMinutes: number;
  totalMarks: number;
  sections: Array<{
    id: string;
    name: string;
    subjectId?: string | null;
    displayOrder?: number;
  }>;
  languages: Array<{
    id: string;
    code: string;
    name: string;
    nativeName?: string | null;
    isDefault?: boolean;
  }>;
  questions: ExamQuestionSnapshotItem[];
  questionsById: Record<string, ExamQuestionSnapshotItem>;
  cachedAt: string;
  officialExamEndTime: string;
  ttlSeconds: number;
  ttlExpiresAt: string;
}

export interface ExamCacheMeta {
  examId: string;
  examVersionId: string;
  questionCount: number;
  languageCount: number;
  preparedAt: string;
  verifiedAt: string;
  officialExamEndTime: string;
  ttlSeconds: number;
  status: 'PREPARING' | 'CACHE_READY' | 'FAILED';
  error?: string;
}

export interface ExamCacheVerificationResult {
  isValid: boolean;
  questionCount: number;
  expectedCount: number;
  languagesCount: number;
  optionsCount: number;
  errors: string[];
}

export interface PrepareExamCacheParams {
  examId: string;
  examVersionId?: string;
  scheduleId?: string;
  officialEndTime?: Date;
  userId?: string;
}

export interface PrepareExamCacheJobData {
  examId: string;
  examVersionId: string;
  scheduleId?: string;
  officialExamEndTime?: string;
  userId?: string;
}
