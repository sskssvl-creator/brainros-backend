export interface PerformanceThresholds {
  excellent: number; // default: 90
  strong: number; // default: 75
  good: number; // default: 60
  weak: number; // default: 40
}

export const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceThresholds = {
  excellent: 90,
  strong: 75,
  good: 60,
  weak: 40,
};

export type PerformanceStatus =
  | 'EXCELLENT'
  | 'STRONG'
  | 'GOOD'
  | 'WEAK'
  | 'CRITICAL'
  | 'NOT_ATTEMPTED';

export interface OverallPerformanceMetrics {
  totalMarks: number;
  obtainedMarks: number;
  percentage: number;
  accuracy: number;
  correctCount: number;
  wrongCount: number;
  unattemptedCount: number;
  totalQuestions: number;
  timeUsedSeconds: number;
  formattedTimeUsed: string;
  averageTimePerQuestionSeconds: number;
  negativeMarksLost: number;
  potentialMarks: number; // score if wrong answers were not attempted
  overallStatus: PerformanceStatus;
  speedAccuracyQuadrant:
    | 'FAST_AND_ACCURATE'
    | 'SLOW_AND_ACCURATE'
    | 'RUSHED_AND_INACCURATE'
    | 'SLOW_AND_STRUGGLING';
}

export interface SubjectAnalyticsItem {
  subjectId: string;
  subjectName: string;
  totalQuestions: number;
  correct: number;
  wrong: number;
  unattempted: number;
  score: number;
  maxScore: number;
  accuracy: number;
  percentage: number;
  timeSpentSeconds: number;
  avgTimePerQuestionSeconds: number;
  status: PerformanceStatus;
  isStrongest: boolean;
  isWeakest: boolean;
}

export interface ChapterAnalyticsItem {
  chapterId: string;
  chapterName: string;
  subjectId: string;
  subjectName: string;
  totalQuestions: number;
  correct: number;
  wrong: number;
  unattempted: number;
  score: number;
  maxScore: number;
  accuracy: number;
  percentage: number;
  timeSpentSeconds: number;
  avgTimePerQuestionSeconds: number;
  status: PerformanceStatus;
}

export interface QuestionTimeExtreme {
  questionId: string;
  examQuestionId: string;
  displayOrder: number;
  timeSeconds: number;
  sectionName: string;
  isCorrect: boolean;
}

export interface SubjectBenchmarkComparison {
  subjectName: string;
  actualSeconds: number;
  recommendedSeconds: number;
  deltaPercent: number;
  observation: string;
}

export interface TimeAnalyticsReport {
  totalExamDurationMinutes: number;
  totalTimeUsedSeconds: number;
  timeRemainingSeconds: number;
  averageTimePerQuestionSeconds: number;
  timeOnCorrectQuestionsSeconds: number;
  avgTimeOnCorrectSeconds: number;
  timeOnWrongQuestionsSeconds: number;
  avgTimeOnWrongSeconds: number;
  timeOnUnattemptedQuestionsSeconds: number;
  avgTimeOnUnattemptedSeconds: number;
  timeWastedSeconds: number;
  fastestQuestion: QuestionTimeExtreme | null;
  slowestQuestion: QuestionTimeExtreme | null;
  pacingMetrics: {
    rushedCount: number; // < 20s
    optimalPaceCount: number;
    overthoughtCount: number; // > 2.5x avg
  };
  subjectTimeDistribution: {
    subjectName: string;
    timeSpentSeconds: number;
    percentageOfTotalTime: number;
  }[];
  subjectBenchmarkComparisons: SubjectBenchmarkComparison[];
}

export interface AttemptStrategyReport {
  negativeMarkingPenalty: number;
  marksLostToGuessing: number;
  scoreWithoutNegativeMarking: number;
  reviewBehavior: {
    markedForReviewCount: number;
    markedAndAnsweredCount: number;
    markedAndCorrectCount: number;
    markedAndWrongCount: number;
  };
  attemptRatio: number; // percentage of exam attempted
  accuracyVsSpeedProfile: string;
  strategicTakeaways: string[];
  overAttemptingWarning: string | null;
  underAttemptingWarning: string | null;
  potentialScoreGainMessage: string;
}

export interface ActionableRecommendation {
  id: string;
  category:
    | 'CHAPTER_REVISION'
    | 'TIME_MANAGEMENT'
    | 'NEGATIVE_MARKING'
    | 'ATTEMPT_STRATEGY';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  impactScore: number; // estimated marks gain
  actionStep: string;
}

// ═══════════════════════════════════════════════════════════════════
// 14 SPECIFIC REPORT SECTION INTERFACES (MATCHING REFERENCE REPORT)
// ═══════════════════════════════════════════════════════════════════

// 1. Student Details Section
export interface StudentDetailsSection {
  studentName: string;
  studentId: string;
  examination: string;
  className: string;
  testNumber: string;
  testDate: string;
  testMode: string;
  totalQuestions: number;
  maximumMarks: number;
}

// 2. Overall Performance Section
export interface OverallPerformanceSection {
  totalMarks: number;
  maximumMarks: number;
  percentage: number;
  correctAnswers: number;
  incorrectAnswers: number;
  unattempted: number;
  accuracy: number;
  overallPercentile: number | null;
  estimatedRank: number | null;
  performanceLevel: string; // e.g. "Excellent", "Very Good", "Good", "Needs Improvement"
}

// 3. Subject-Wise Analysis Section (Table + Total)
export interface SubjectWiseAnalysisRow {
  subject: string;
  max: number;
  score: number;
  percentage: number;
  correct: number;
  wrong: number;
  unattempted: number;
  accuracy: number;
}

export interface SubjectWiseAnalysisSection {
  rows: SubjectWiseAnalysisRow[];
  total: SubjectWiseAnalysisRow;
}

// 4. Subject Performance (Diagnosis per subject)
export interface SubjectPerformanceItem {
  subjectName: string;
  score: number;
  maxScore: number;
  performanceLevel: string;
  strongAreas: string[];
  areasRequiringImprovement: string[];
  recommendation: string;
}

// 5. Topic-Wise Performance Section
export interface TopicPerformanceRow {
  topic: string;
  subjectName: string;
  accuracy: number;
  status: 'Excellent' | 'Strong' | 'Needs Improvement' | 'Weak';
  totalQuestions: number;
  correct: number;
  wrong: number;
}

// 6. Strength & Weakness Analysis
export interface StrengthWeaknessSection {
  topStrengths: string[];
  priorityWeaknesses: string[];
}

// 7. Error Analysis Section
export interface ErrorAnalysisCategory {
  errorType: 'Conceptual Error' | 'Calculation Error' | 'Silly Mistake' | 'Misreading Question' | 'Guessing';
  questionCount: number;
  impact: 'High' | 'Medium' | 'Low';
  description?: string;
}

export interface ErrorAnalysisSection {
  categories: ErrorAnalysisCategory[];
  totalWrong: number;
  potentialRecoverableMarks: number;
  narrative: string;
}

// 8. Time Management Section
export interface TimeManagementRow {
  section: string;
  recommendedMinutes: number;
  studentMinutes: number;
  status: 'Optimal' | 'Slow' | 'Fast';
}

export interface TimeManagementStrategyRound {
  round: string;
  title: string;
  description: string;
}

export interface TimeManagementSection {
  rows: TimeManagementRow[];
  reviewMinutes: {
    recommended: number;
    actual: number;
  };
  roundsStrategy: TimeManagementStrategyRound[];
}

// 9. Performance Trend Section
export interface PerformanceTrendPoint {
  testNumber: string;
  testTitle: string;
  date: string;
  score: number;
  maxScore: number;
  percentile: number | null;
  rank: number | null;
}

export interface PerformanceTrendSection {
  history: PerformanceTrendPoint[];
  trendSummary: string;
  trajectory: 'UPWARD' | 'STABLE' | 'FLUCTUATING' | 'INSUFFICIENT_DATA';
}

// 10. Expected Performance Targets
export interface ExpectedPerformanceSection {
  currentScore: number;
  maxScore: number;
  shortTermTarget: number;
  strongTarget: number;
  excellentTarget: number;
  actionableMessage: string;
}

// 11. 14-Day Improvement Plan Section
export interface FourteenDayPlanDayBlock {
  period: string; // e.g. "Days 1–3", "Day 12"
  title: string;
  subject?: string;
  focusChapters: string[];
  activities: string[];
  practiceVolume?: string; // e.g. "50–75 questions/day"
}

export interface FourteenDayImprovementPlanSection {
  blocks: FourteenDayPlanDayBlock[];
}

// 12. Personalized Action Checklist
export interface PersonalizedActionChecklistSection {
  items: Array<{
    id: string;
    text: string;
    category: string;
    isKeyAction: boolean;
  }>;
}

// 13. Parent Summary Section
export interface ParentSummarySection {
  summaryParagraph: string;
  keyHighlights: string[];
  potentialScoreRange: string;
}

// 14. Brainros Performance Index Section
export interface PerformanceIndexMetric {
  dimension: string;
  ratingStars: number; // 0 to 5
  ratingLabel: string; // e.g. "4.0/5.0"
}

export interface BrainrosPerformanceIndexSection {
  metrics: PerformanceIndexMetric[];
  overallRating: string; // e.g. "VERY GOOD", "EXCELLENT", "GOOD"
}

// ═══════════════════════════════════════════════════════════════════
// AI ANALYSIS METADATA
// ═══════════════════════════════════════════════════════════════════

export interface AiAnalysisMetadata {
  isAiGenerated: boolean;
  provider: 'gemini' | 'heuristic_fallback';
  model?: string;
  generatedAt: string;
  confidenceScore?: number;
}

// ═══════════════════════════════════════════════════════════════════
// COMPLETE MASTER REPORT INTERFACE
// ═══════════════════════════════════════════════════════════════════

export interface FullAnalysisReport {
  attemptId: string;
  examId: string;
  examTitle: string;
  examTargetName: string;
  calculatedAt: Date;
  thresholdsUsed: PerformanceThresholds;
  
  // Legacy / granular structure for existing components
  overall: OverallPerformanceMetrics;
  subjects: {
    items: SubjectAnalyticsItem[];
    strongestSubject: SubjectAnalyticsItem | null;
    weakestSubject: SubjectAnalyticsItem | null;
  };
  chapters: {
    items: ChapterAnalyticsItem[];
    mastered: ChapterAnalyticsItem[];
    revisionNeeded: ChapterAnalyticsItem[];
    criticalFocus: ChapterAnalyticsItem[];
  };
  timeAnalysis: TimeAnalyticsReport;
  attemptStrategy: AttemptStrategyReport;
  recommendations: ActionableRecommendation[];

  // AI Generation & Diagnostic Metadata
  aiMetadata?: AiAnalysisMetadata;

  // 14 Canonical Sections (Matching Reference Design)
  section1StudentDetails: StudentDetailsSection;
  section2OverallPerformance: OverallPerformanceSection;
  section3SubjectWiseAnalysis: SubjectWiseAnalysisSection;
  section4SubjectPerformance: SubjectPerformanceItem[];
  section5TopicWisePerformance: TopicPerformanceRow[];
  section6StrengthWeakness: StrengthWeaknessSection;
  section7ErrorAnalysis: ErrorAnalysisSection;
  section8TimeManagement: TimeManagementSection;
  section9PerformanceTrend: PerformanceTrendSection;
  section10ExpectedPerformance: ExpectedPerformanceSection;
  section11FourteenDayPlan: FourteenDayImprovementPlanSection;
  section12ActionChecklist: PersonalizedActionChecklistSection;
  section13ParentSummary: ParentSummarySection;
  section14PerformanceIndex: BrainrosPerformanceIndexSection;

  // Canonical Direct Aliases
  studentDetails: StudentDetailsSection;
  overallPerformance: OverallPerformanceSection;
  subjectWiseAnalysis: SubjectWiseAnalysisSection;
  subjectPerformance: SubjectPerformanceItem[];
  topicWisePerformance: TopicPerformanceRow[];
  strengthWeaknessAnalysis: StrengthWeaknessSection;
  errorAnalysis: ErrorAnalysisSection;
  timeManagement: TimeManagementSection;
  performanceTrend: PerformanceTrendSection;
  expectedPerformance: ExpectedPerformanceSection;
  improvementPlan: FourteenDayImprovementPlanSection;
  actionChecklist: PersonalizedActionChecklistSection;
  parentSummary: ParentSummarySection;
  performanceIndex: BrainrosPerformanceIndexSection;
}
