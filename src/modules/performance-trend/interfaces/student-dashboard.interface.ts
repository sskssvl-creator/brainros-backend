export interface StudentInfo {
  studentId: string;
  studentCode?: string | null;
  name: string;
  class: string;
  examTarget: string;
  preferredLanguage: string;
  email?: string;
  avatar?: string | null;
}

export interface NextExamWidget {
  examId: string;
  title: string;
  examTarget: string;
  durationMinutes: number;
  totalQuestions: number;
  totalMarks: number;
  startTime: string | null;
  endTime: string | null;
  status: string;
  canStart: boolean;
  waitSeconds: number;
  accessStatus: string;
  message: string;
}

export interface ActiveAttemptWidget {
  attemptId: string;
  examId: string;
  examTitle: string;
  startedAt: string;
  serverEndTime: string | null;
  timeRemainingSeconds: number;
  currentQuestionNumber: number;
  totalQuestions: number;
  answeredCount: number;
}

export interface PerformanceSummaryWidget {
  latestScore: number;
  maxScore: number;
  percentage: number;
  accuracy: number;
  totalAttempts: number;
  timeSpentSeconds: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
}

export interface RankSummaryWidget {
  rank: number | null;
  totalCandidates: number | null;
  percentile: number | null;
  stateRank?: number | null;
  categoryRank?: number | null;
}

export interface PredictedRankWidget {
  available: boolean;
  reason?: string | null;
  targetExam?: string | null;
  targetExamName?: string | null;
  predictedRank?: number | null;
  predictedRankMin: number | null;
  predictedRankMax: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  confidenceScore?: number | null;
  scoreUsed?: number | null;
  normalizedPercentage?: number | null;
  attemptsUsed?: number | null;
  trend?: 'IMPROVING' | 'STABLE' | 'DECLINING' | null;
  modelVersion?: string | null;
  explanation?: string | null;
  isEstimated: boolean;
}

export interface SubjectSummaryItem {
  subjectId: string;
  subjectName: string;
  score: number;
  maxScore: number;
  accuracy: number;
  status: 'EXCELLENT' | 'GOOD' | 'WEAK';
  trendDelta?: number | null; // e.g. +5% from previous mock
}

export interface WeakAreaItem {
  subjectName: string;
  chapterName: string;
  accuracy: number;
  totalQuestions: number;
  status: 'WEAK' | 'NEEDS_FOCUS';
}

export interface DashboardRecommendationItem {
  id: string;
  type: 'WARNING' | 'OPPORTUNITY' | 'STRENGTH' | 'TIP';
  title?: string;
  message: string;
  reason?: string;
  priority?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'STRENGTH';
  priorityScore?: number;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  actionLabel?: string | null;
  actionType?: 'PRACTICE' | 'PRACTICE_MOCK' | 'VIEW_STRATEGY' | 'VIEW_ANALYSIS' | 'VIEW_EXAMS' | 'REVIEW_CONCEPTS';
  targetUrl?: string | null;
  subjectId?: string | null;
  subjectName?: string | null;
  chapterId?: string | null;
  chapterName?: string | null;
  mockTestId?: string | null;
  mockTestName?: string | null;
  fallbackMessage?: string | null;
  metrics?: {
    accuracy?: number;
    sampleSize?: number;
    wrongCount?: number;
    unattemptedCount?: number;
    avgTimeSeconds?: number;
    negativeMarksLost?: number;
    trendDelta?: number;
    potentialScoreGain?: number;
  };
}

export interface TimeManagementWidget {
  averageTimePerQuestionSeconds: number;
  timeUtilizationPercentage: number;
  totalTimeUsedSeconds: number;
  status: 'OPTIMAL' | 'NEEDS_IMPROVEMENT' | 'SLOW';
}

export interface AttemptStrategyWidget {
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH';
  highRiskAttemptsCount: number;
  avoidableNegativeMarks: number;
  scoreGainOpportunity: number;
}

export interface RecentResultItem {
  attemptId: string;
  examId: string;
  examTitle: string;
  examType: string;
  date: string;
  score: number;
  maxScore: number;
  percentage: number;
  accuracy: number;
  rank: number | null;
  totalCandidates: number | null;
  percentile: number | null;
}

export interface StudentDashboardResponse {
  student: StudentInfo;
  nextExam: NextExamWidget | null;
  upcomingExams: NextExamWidget[];
  activeAttempt: ActiveAttemptWidget | null;
  latestPerformance: PerformanceSummaryWidget | null;
  rank: RankSummaryWidget | null;
  predictedRank: PredictedRankWidget | null;
  subjects: SubjectSummaryItem[];
  trendSummary: {
    scoreTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA';
    accuracyTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA';
    rankTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA';
    percentileTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA';
    recentScores: Array<{ mockLabel: string; score: number; accuracy: number; rank: number | null; percentile: number | null }>;
  };
  weakAreas: WeakAreaItem[];
  recommendations: DashboardRecommendationItem[];
  timeManagement: TimeManagementWidget | null;
  attemptStrategy: AttemptStrategyWidget | null;
  recentResults: {
    data: RecentResultItem[];
    meta: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  };
  unreadNotificationCount: number;
}
