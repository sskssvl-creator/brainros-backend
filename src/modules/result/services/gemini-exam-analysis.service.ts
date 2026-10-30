import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  ErrorAnalysisCategory,
  ErrorAnalysisSection,
  FourteenDayImprovementPlanSection,
  PersonalizedActionChecklistSection,
  ParentSummarySection,
  BrainrosPerformanceIndexSection,
  ExpectedPerformanceSection,
  StrengthWeaknessSection,
  TimeManagementStrategyRound,
  AiAnalysisMetadata,
} from '../interfaces/analysis.interface';

export interface StudentExamAiContext {
  student: {
    id: string;
    name: string;
    studentCode?: string;
    className?: string;
    targetExam?: string;
  };
  exam: {
    id: string;
    title: string;
    durationMinutes: number;
    totalQuestions: number;
    maxScore: number;
    defaultMarksPerQuestion: number;
    negativeMarksPerQuestion?: number;
  };
  overall: {
    score: number;
    maxScore: number;
    percentage: number;
    accuracy: number;
    correctCount: number;
    wrongCount: number;
    unattemptedCount: number;
    negativeMarksLost: number;
    totalTimeUsedSeconds: number;
    averageTimePerQuestionSeconds: number;
  };
  subjects: Array<{
    subjectName: string;
    score: number;
    maxScore: number;
    accuracy: number;
    percentage: number;
    correct: number;
    wrong: number;
    unattempted: number;
    timeSpentSeconds: number;
  }>;
  chapters: Array<{
    chapterName: string;
    subjectName: string;
    totalQuestions: number;
    correct: number;
    wrong: number;
    unattempted: number;
    accuracy: number;
    status: string;
  }>;
  sampleWrongQuestions?: Array<{
    questionNumber: number;
    subjectName: string;
    chapterName?: string;
    questionText?: string;
    studentAnswer?: string;
    correctAnswer?: string;
    timeSpentSeconds?: number;
  }>;
  previousAttempts?: Array<{
    testTitle: string;
    date: string;
    score: number;
    maxScore: number;
    percentile?: number | null;
  }>;
}

export interface GeminiExamPredictionResult {
  errorAnalysis: ErrorAnalysisSection;
  speedAccuracyQuadrant:
    | 'FAST_AND_ACCURATE'
    | 'SLOW_AND_ACCURATE'
    | 'RUSHED_AND_INACCURATE'
    | 'SLOW_AND_STRUGGLING';
  pacingRounds: TimeManagementStrategyRound[];
  strategicTakeaways: string[];
  overAttemptingWarning: string | null;
  underAttemptingWarning: string | null;
  potentialScoreGainMessage: string;
  fourteenDayPlan: FourteenDayImprovementPlanSection;
  actionChecklist: PersonalizedActionChecklistSection;
  parentSummary: ParentSummarySection;
  performanceIndex: BrainrosPerformanceIndexSection;
  expectedPerformance: ExpectedPerformanceSection;
  strengthWeakness: StrengthWeaknessSection;
  metadata: AiAnalysisMetadata;
}

@Injectable()
export class GeminiExamAnalysisService {
  private readonly logger = new Logger(GeminiExamAnalysisService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private readonly modelName: string;

  constructor(private readonly configService: ConfigService) {
    const rawKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY ||
      '';
    const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

    this.modelName = (
      this.configService.get<string>('GEMINI_ANALYSIS_MODEL') ||
      this.configService.get<string>('GEMINI_MODEL') ||
      process.env.GEMINI_ANALYSIS_MODEL ||
      process.env.GEMINI_MODEL ||
      'gemini-1.5-flash'
    )
      .trim()
      .replace(/^["']|["']$/g, '');

    if (apiKey) {
      try {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.logger.log(
          `GeminiExamAnalysisService initialized with model: ${this.modelName}`,
        );
      } catch (err: any) {
        this.logger.warn(`Failed to initialize GoogleGenerativeAI: ${err.message}`);
      }
    } else {
      this.logger.warn(
        'GEMINI_API_KEY is not configured. Heuristic fallback will be used for exam predictions.',
      );
    }
  }

  /**
   * Main prediction entrypoint.
   * Sends comprehensive student context to Gemini for personalized predictions.
   * Falls back gracefully to heuristic rules if Gemini is unavailable.
   */
  async predictExamInsights(
    context: StudentExamAiContext,
  ): Promise<GeminiExamPredictionResult> {
    if (!this.genAI) {
      this.logger.warn('Gemini client not initialized, using heuristic fallback');
      return this.generateHeuristicFallback(context);
    }

    try {
      const prompt = this.buildPrompt(context);
      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          temperature: 0.2,
          topP: 0.8,
          responseMimeType: 'application/json',
        },
      });

      const response = await model.generateContent(prompt);
      const responseText = response.response.text();

      if (!responseText) {
        throw new Error('Empty response received from Gemini API');
      }

      const parsed = this.parseGeminiJson(responseText);
      const validated = this.validateAndNormalizeResponse(parsed, context);

      this.logger.log(
        `Gemini exam prediction successfully generated for attempt of student: ${context.student.name}`,
      );

      return {
        ...validated,
        metadata: {
          isAiGenerated: true,
          provider: 'gemini',
          model: this.modelName,
          generatedAt: new Date().toISOString(),
          confidenceScore: 0.94,
        },
      };
    } catch (err: any) {
      this.logger.error(
        `Gemini exam prediction failed: ${err.message}. Engaging heuristic fallback.`,
        err.stack,
      );
      return this.generateHeuristicFallback(context);
    }
  }

  /**
   * Build structured prompt for Gemini with exact JSON response schema
   */
  private buildPrompt(context: StudentExamAiContext): string {
    const { student, exam, overall, subjects, chapters, sampleWrongQuestions, previousAttempts } =
      context;

    const subjectsSummary = subjects
      .map(
        (s) =>
          `- ${s.subjectName}: Score ${s.score}/${s.maxScore} (${s.percentage}%), Accuracy ${s.accuracy}%, Correct: ${s.correct}, Wrong: ${s.wrong}, Unattempted: ${s.unattempted}, Time: ${Math.round(s.timeSpentSeconds / 60)} min`,
      )
      .join('\n');

    const topCriticalChapters = chapters
      .filter((c) => c.status === 'CRITICAL' || c.accuracy < 50)
      .slice(0, 5)
      .map((c) => `${c.chapterName} (${c.subjectName}, Acc: ${c.accuracy}%)`)
      .join(', ');

    const topMasteredChapters = chapters
      .filter((c) => c.status === 'EXCELLENT' || c.accuracy >= 80)
      .slice(0, 5)
      .map((c) => `${c.chapterName} (${c.subjectName}, Acc: ${c.accuracy}%)`)
      .join(', ');

    const errorSamplesText =
      sampleWrongQuestions && sampleWrongQuestions.length > 0
        ? sampleWrongQuestions
            .slice(0, 8)
            .map(
              (q, idx) =>
                `Q${idx + 1} [${q.subjectName} | ${q.chapterName || 'General'}]: Student selected '${q.studentAnswer || 'N/A'}' (Correct: '${q.correctAnswer || 'N/A'}'), Time spent: ${q.timeSpentSeconds || 0}s`,
            )
            .join('\n')
        : 'Detailed question logs not available';

    const previousHistoryText =
      previousAttempts && previousAttempts.length > 0
        ? previousAttempts
            .map(
              (p, idx) =>
                `Mock ${idx + 1}: ${p.testTitle} (${p.date}) -> Score: ${p.score}/${p.maxScore}${p.percentile ? `, Percentile: ${p.percentile}%` : ''}`,
            )
            .join('\n')
        : 'First baseline test recorded';

    return `
You are the Chief AI Psychometrician and Academic Diagnostic Director for BRAINROS Exam Intelligence.
Analyze the following student test attempt and provide deep, hyper-personalized academic and behavioral insights.

### STUDENT & EXAM CONTEXT:
- Student Name: ${student.name}
- Class/Grade: ${student.className || 'Senior Secondary'}
- Target Examination: ${student.targetExam || exam.title}
- Exam Title: ${exam.title}
- Total Marks: ${exam.maxScore} (Duration: ${exam.durationMinutes} mins, Questions: ${exam.totalQuestions})
- Student Score: ${overall.score}/${overall.maxScore} (${overall.percentage}%)
- Accuracy: ${overall.accuracy}% (Correct: ${overall.correctCount}, Wrong: ${overall.wrongCount}, Unattempted: ${overall.unattemptedCount})
- Negative Marks Lost: ${overall.negativeMarksLost} marks
- Total Time Used: ${Math.round(overall.totalTimeUsedSeconds / 60)} mins (Avg ${Math.round(overall.averageTimePerQuestionSeconds)}s per question)

### SUBJECT PERFORMANCE:
${subjectsSummary}

### CHAPTER BREAKDOWN:
- Critical Focus Needed: ${topCriticalChapters || 'None detected'}
- Mastered Chapters: ${topMasteredChapters || 'Solid foundational spread'}

### SAMPLE INCORRECT QUESTIONS AUDIT:
${errorSamplesText}

### HISTORICAL PERFORMANCE:
${previousHistoryText}

### SUBJECT RESTRICTIONS (CRITICAL & STRICT):
The exam contains ONLY the following subject(s): ${subjects.map(s => s.subjectName).join(', ')}.
You MUST NOT mention or generate plan blocks for any subjects outside this list (e.g. do not invent Physics, Chemistry, Biology, etc. if not listed above).
Every block in "fourteenDayPlan" MUST assign "subject" strictly to one of the listed subjects or "All Subjects".

### OUTPUT REQUIREMENTS:
Respond ONLY with a valid, parseable JSON object matching this exact schema:
{
  "errorAnalysis": {
    "conceptual": <number of wrong questions due to fundamental concept gap>,
    "calculation": <number of wrong questions due to algebraic/math/unit slips>,
    "silly": <number of wrong questions due to hasty reading or wrong bubbling>,
    "misreading": <number of wrong questions due to missing keywords like NOT/INCORRECT>,
    "guessing": <number of wrong questions due to blind/low-confidence guessing>,
    "potentialRecoverableMarks": <number of marks student could gain back if avoidable errors were avoided>,
    "narrative": "<2-3 sentences explaining the primary error pattern and concrete remedy>"
  },
  "speedAccuracyQuadrant": "<FAST_AND_ACCURATE | SLOW_AND_ACCURATE | RUSHED_AND_INACCURATE | SLOW_AND_STRUGGLING>",
  "strategicTakeaways": [
    "<3 to 4 sharp, actionable, student-specific takeaways about time vs negative marking>"
  ],
  "overAttemptingWarning": "<string warning if student guessed excessively or null if disciplined>",
  "underAttemptingWarning": "<string warning if student left too many easy/medium questions or null>",
  "potentialScoreGainMessage": "<clear message stating exact potential score with disciplined attempt>",
  "pacingRounds": [
    { "round": "Round 1 (First 50–60 mins)", "title": "Direct & Easy Questions", "description": "<guidance>" },
    { "round": "Round 2 (Next 60–70 mins)", "title": "Moderate & Standard Problems", "description": "<guidance>" },
    { "round": "Round 3 (Next 25–30 mins)", "title": "Difficult / Lengthy Numericals", "description": "<guidance>" },
    { "round": "Final 15–20 minutes", "title": "Verification & Review", "description": "<guidance>" }
  ],
  "fourteenDayPlan": {
    "blocks": [
      {
        "period": "Days 1–3",
        "title": "<Title focused on weakest subject>",
        "subject": "<Subject Name>",
        "focusChapters": ["<Chapter 1>", "<Chapter 2>"],
        "activities": ["<Activity 1>", "<Activity 2>", "<Activity 3>"],
        "practiceVolume": "<e.g. 50-75 questions/day>"
      },
      {
        "period": "Days 4–6",
        "title": "<Title focused on second priority subject>",
        "subject": "<Subject Name>",
        "focusChapters": ["<Chapter 1>", "<Chapter 2>"],
        "activities": ["<Activity 1>", "<Activity 2>", "<Activity 3>"],
        "practiceVolume": "<e.g. 60-80 questions/day>"
      },
      {
        "period": "Days 7–9",
        "title": "<Title focused on third subject / high-yield theory>",
        "subject": "<Subject Name>",
        "focusChapters": ["<Chapter 1>", "<Chapter 2>"],
        "activities": ["<Activity 1>", "<Activity 2>", "<Activity 3>"],
        "practiceVolume": "<e.g. 70-90 questions/day>"
      },
      {
        "period": "Days 10–11",
        "title": "Mixed Revision & Error Remediation",
        "focusChapters": ["All Priority Weak Areas", "Error Notebook Log"],
        "activities": ["Re-solve all wrong questions", "Speed drilling", "Option elimination drill"],
        "practiceVolume": "100 questions/day"
      },
      {
        "period": "Day 12",
        "title": "Full-Length Mock Test Under Real Exam Conditions",
        "focusChapters": ["Full Syllabus"],
        "activities": ["Strict 3-round execution", "Zero guessing on 50/50 dilemmas"],
        "practiceVolume": "Full Test"
      },
      {
        "period": "Day 13",
        "title": "Deep Error Audit & Root-Cause Classification",
        "focusChapters": ["Mock Errors"],
        "activities": ["Classify every error", "Update formula sheet", "Derivation reinforcement"],
        "practiceVolume": "Comprehensive Audit"
      },
      {
        "period": "Day 14",
        "title": "Final Formula Refresh & Mindset Optimization",
        "focusChapters": ["High-Frequency Formulas", "Summary Tables"],
        "activities": ["Rapid formula recall", "Time pacing rehearsal", "Relaxation & confidence"],
        "practiceVolume": "Rapid Recall"
      }
    ]
  },
  "actionChecklist": {
    "items": [
      { "id": "act-1", "text": "<action text>", "category": "Revision", "isKeyAction": true },
      { "id": "act-2", "text": "<action text>", "category": "Error Reduction", "isKeyAction": true },
      { "id": "act-3", "text": "<action text>", "category": "Practice", "isKeyAction": true },
      { "id": "act-4", "text": "<action text>", "category": "Theory", "isKeyAction": false },
      { "id": "act-5", "text": "<action text>", "category": "Error Reduction", "isKeyAction": true },
      { "id": "act-6", "text": "<action text>", "category": "Strategy", "isKeyAction": true },
      { "id": "act-7", "text": "<action text>", "category": "Speed", "isKeyAction": false },
      { "id": "act-8", "text": "<action text>", "category": "Discipline", "isKeyAction": true }
    ]
  },
  "parentSummary": {
    "summaryParagraph": "<Empathetic, clear diagnostic paragraph addressed to parents explaining ward's current standing, exact score growth opportunity, and encouraging next steps>",
    "keyHighlights": [
      "<Highlight 1: score and accuracy summary>",
      "<Highlight 2: subject strength>",
      "<Highlight 3: score gain opportunity with mistake reduction>"
    ],
    "potentialScoreRange": "<e.g. 520–580+ or target range>"
  },
  "performanceIndex": {
    "metrics": [
      { "dimension": "Academic Strength", "ratingStars": <1.0 to 5.0>, "ratingLabel": "<rating>/5.0" },
      { "dimension": "Conceptual Understanding", "ratingStars": <1.0 to 5.0>, "ratingLabel": "<rating>/5.0" },
      { "dimension": "Accuracy", "ratingStars": <1.0 to 5.0>, "ratingLabel": "<rating>/5.0" },
      { "dimension": "Time Management", "ratingStars": <1.0 to 5.0>, "ratingLabel": "<rating>/5.0" },
      { "dimension": "Revision Level", "ratingStars": <1.0 to 5.0>, "ratingLabel": "<rating>/5.0" },
      { "dimension": "Exam Readiness", "ratingStars": <1.0 to 5.0>, "ratingLabel": "<rating>/5.0" }
    ],
    "overallRating": "<EXCELLENT | VERY GOOD | GOOD | NEEDS ATTENTION>"
  },
  "expectedPerformance": {
    "currentScore": ${overall.score},
    "maxScore": ${overall.maxScore},
    "shortTermTarget": <realistic short term target score>,
    "strongTarget": <strong target score>,
    "excellentTarget": <milestone target score>,
    "actionableMessage": "<encouraging next step instruction>"
  },
  "strengthWeakness": {
    "topStrengths": [
      "<Strength 1>",
      "<Strength 2>",
      "<Strength 3>"
    ],
    "priorityWeaknesses": [
      "<Weakness 1>",
      "<Weakness 2>",
      "<Weakness 3>"
    ]
  }
}
`.trim();
  }

  /**
   * Safely parse JSON from Gemini text response
   */
  private parseGeminiJson(rawText: string): any {
    let clean = rawText.trim();
    // Strip markdown code fences if present
    if (clean.startsWith('```json')) {
      clean = clean.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    } else if (clean.startsWith('```')) {
      clean = clean.replace(/^```\s*/, '').replace(/```\s*$/, '');
    }
    return JSON.parse(clean);
  }

  /**
   * Validate and fill missing elements in Gemini response
   */
  private validateAndNormalizeResponse(
    parsed: any,
    context: StudentExamAiContext,
  ): Omit<GeminiExamPredictionResult, 'metadata'> {
    const totalWrong = context.overall.wrongCount;
    const err = parsed.errorAnalysis || {};

    let conceptual = Number(err.conceptual) || 0;
    let calculation = Number(err.calculation) || 0;
    let silly = Number(err.silly) || 0;
    let misreading = Number(err.misreading) || 0;
    let guessing = Number(err.guessing) || 0;

    const sumErrors = conceptual + calculation + silly + misreading + guessing;
    if (totalWrong > 0 && sumErrors === 0) {
      conceptual = Math.ceil(totalWrong * 0.4);
      calculation = Math.ceil(totalWrong * 0.25);
      silly = Math.ceil(totalWrong * 0.15);
      misreading = Math.ceil(totalWrong * 0.1);
      guessing = Math.max(0, totalWrong - conceptual - calculation - silly - misreading);
    } else if (totalWrong > 0 && sumErrors !== totalWrong) {
      // Re-scale proportionally to match total wrong count
      const ratio = totalWrong / sumErrors;
      conceptual = Math.round(conceptual * ratio);
      calculation = Math.round(calculation * ratio);
      silly = Math.round(silly * ratio);
      misreading = Math.round(misreading * ratio);
      guessing = Math.max(0, totalWrong - conceptual - calculation - silly - misreading);
    }

    const categories: ErrorAnalysisCategory[] = [
      {
        errorType: 'Conceptual Error',
        questionCount: conceptual,
        impact: conceptual >= 5 ? 'High' : 'Medium',
        description: 'Gap in underlying theoretical fundamentals or principle application',
      },
      {
        errorType: 'Calculation Error',
        questionCount: calculation,
        impact: calculation >= 4 ? 'High' : 'Medium',
        description: 'Arithmetic slips, unit conversion errors, or formula simplification slips',
      },
      {
        errorType: 'Silly Mistake',
        questionCount: silly,
        impact: silly >= 3 ? 'Medium' : 'Low',
        description: 'Overlooking given values or bubbling wrong option on straightforward questions',
      },
      {
        errorType: 'Misreading Question',
        questionCount: misreading,
        impact: misreading >= 3 ? 'Medium' : 'Low',
        description: 'Missed keywords such as "INCORRECT", "EXCEPT", or "NOT TRUE"',
      },
      {
        errorType: 'Guessing',
        questionCount: guessing,
        impact: guessing >= 3 ? 'Medium' : 'Low',
        description: 'Low-confidence attempts made under rushed time pressure',
      },
    ];

    const defaultRecoverable = Math.round(
      (calculation + silly + misreading + guessing) *
        (context.exam.defaultMarksPerQuestion || 4) +
        context.overall.negativeMarksLost * 0.75,
    );

    const errorAnalysis: ErrorAnalysisSection = {
      categories,
      totalWrong,
      potentialRecoverableMarks:
        typeof err.potentialRecoverableMarks === 'number'
          ? Math.max(0, err.potentialRecoverableMarks)
          : defaultRecoverable,
      narrative:
        err.narrative ||
        `Identified ${calculation + silly + misreading} avoidable mistakes. Consistent error log remediation will unlock significant marks on the next attempt.`,
    };

    const validQuadrants = [
      'FAST_AND_ACCURATE',
      'SLOW_AND_ACCURATE',
      'RUSHED_AND_INACCURATE',
      'SLOW_AND_STRUGGLING',
    ];
    const speedAccuracyQuadrant = validQuadrants.includes(parsed.speedAccuracyQuadrant)
      ? parsed.speedAccuracyQuadrant
      : context.overall.accuracy >= 75
      ? 'FAST_AND_ACCURATE'
      : 'RUSHED_AND_INACCURATE';

    return {
      errorAnalysis,
      speedAccuracyQuadrant,
      pacingRounds:
        Array.isArray(parsed.pacingRounds) && parsed.pacingRounds.length > 0
          ? parsed.pacingRounds
          : this.getDefaultPacingRounds(),
      strategicTakeaways:
        Array.isArray(parsed.strategicTakeaways) && parsed.strategicTakeaways.length > 0
          ? parsed.strategicTakeaways
          : [
              `Controlled attempt pattern observed with ${context.overall.accuracy}% accuracy.`,
              `Lost ${context.overall.negativeMarksLost} marks to negative marking; prioritize 50-50 elimination.`,
            ],
      overAttemptingWarning: parsed.overAttemptingWarning ?? null,
      underAttemptingWarning: parsed.underAttemptingWarning ?? null,
      potentialScoreGainMessage:
        parsed.potentialScoreGainMessage ||
        `Potential score without low-confidence negative marking: ${Math.round(
          context.overall.score + context.overall.negativeMarksLost,
        )}/${context.exam.maxScore}.`,
      fourteenDayPlan: this.validatePlanSubjects(parsed.fourteenDayPlan, context.subjects)
        ? parsed.fourteenDayPlan
        : this.getHeuristic14DayPlan(context),
      actionChecklist: parsed.actionChecklist?.items?.length
        ? parsed.actionChecklist
        : this.getHeuristicActionChecklist(context),
      parentSummary: parsed.parentSummary?.summaryParagraph
        ? parsed.parentSummary
        : this.getHeuristicParentSummary(context, errorAnalysis.potentialRecoverableMarks),
      performanceIndex: parsed.performanceIndex?.metrics?.length
        ? parsed.performanceIndex
        : this.getHeuristicPerformanceIndex(context),
      expectedPerformance: parsed.expectedPerformance?.shortTermTarget
        ? parsed.expectedPerformance
        : this.getHeuristicExpectedPerformance(context),
      strengthWeakness: parsed.strengthWeakness?.topStrengths?.length
        ? parsed.strengthWeakness
        : this.getHeuristicStrengthWeakness(context),
    };
  }

  /**
   * Deterministic heuristic fallback when Gemini API is offline or unconfigured
   */
  public generateHeuristicFallback(
    context: StudentExamAiContext,
  ): GeminiExamPredictionResult {
    const totalWrong = context.overall.wrongCount;
    const conceptual = Math.ceil(totalWrong * 0.4);
    const calculation = Math.ceil(totalWrong * 0.25);
    const silly = Math.ceil(totalWrong * 0.15);
    const misreading = Math.ceil(totalWrong * 0.1);
    const guessing = Math.max(0, totalWrong - conceptual - calculation - silly - misreading);

    const categories: ErrorAnalysisCategory[] = [
      {
        errorType: 'Conceptual Error',
        questionCount: conceptual,
        impact: conceptual >= 5 ? 'High' : 'Medium',
        description: 'Gap in underlying theoretical fundamentals or principle application',
      },
      {
        errorType: 'Calculation Error',
        questionCount: calculation,
        impact: calculation >= 4 ? 'High' : 'Medium',
        description: 'Arithmetic slips, unit conversion errors, or formula simplification slips',
      },
      {
        errorType: 'Silly Mistake',
        questionCount: silly,
        impact: silly >= 3 ? 'Medium' : 'Low',
        description: 'Overlooking given values or bubbling wrong option on straightforward questions',
      },
      {
        errorType: 'Misreading Question',
        questionCount: misreading,
        impact: misreading >= 3 ? 'Medium' : 'Low',
        description: 'Missed keywords such as "INCORRECT", "EXCEPT", or "NOT TRUE"',
      },
      {
        errorType: 'Guessing',
        questionCount: guessing,
        impact: guessing >= 3 ? 'Medium' : 'Low',
        description: 'Low-confidence attempts made under rushed time pressure',
      },
    ];

    const recoverable = Math.round(
      (calculation + silly + misreading + guessing) *
        (context.exam.defaultMarksPerQuestion || 4) +
        context.overall.negativeMarksLost * 0.75,
    );

    const errorAnalysis: ErrorAnalysisSection = {
      categories,
      totalWrong,
      potentialRecoverableMarks: Math.max(0, recoverable),
      narrative: `Approximately ${recoverable} marks could potentially be recovered by reducing avoidable calculation, reading, and silly mistakes. Maintain an Error Notebook after every BRAINROS test.`,
    };

    const speedAccuracyQuadrant =
      context.overall.accuracy >= 75
        ? context.overall.averageTimePerQuestionSeconds < 80
          ? 'FAST_AND_ACCURATE'
          : 'SLOW_AND_ACCURATE'
        : context.overall.averageTimePerQuestionSeconds < 80
        ? 'RUSHED_AND_INACCURATE'
        : 'SLOW_AND_STRUGGLING';

    return {
      errorAnalysis,
      speedAccuracyQuadrant,
      pacingRounds: this.getDefaultPacingRounds(),
      strategicTakeaways: [
        `Achieved ${context.overall.accuracy}% accuracy across attempted questions.`,
        `Negative marking cost: -${context.overall.negativeMarksLost} marks.`,
        `Focus on multi-step numerical precision and avoiding low-confidence guesses.`,
      ],
      overAttemptingWarning:
        context.overall.wrongCount >= 10 && context.overall.accuracy < 60
          ? `Over-attempting detected: ${context.overall.wrongCount} wrong answers. Eliminate low-probability guesses.`
          : null,
      underAttemptingWarning:
        context.overall.unattemptedCount >= 15
          ? `Under-attempting detected: ${context.overall.unattemptedCount} questions left unanswered.`
          : null,
      potentialScoreGainMessage: `Potential score without negative marking penalty: ${Math.round(
        context.overall.score + context.overall.negativeMarksLost,
      )}/${context.exam.maxScore}.`,
      fourteenDayPlan: this.getHeuristic14DayPlan(context),
      actionChecklist: this.getHeuristicActionChecklist(context),
      parentSummary: this.getHeuristicParentSummary(context, recoverable),
      performanceIndex: this.getHeuristicPerformanceIndex(context),
      expectedPerformance: this.getHeuristicExpectedPerformance(context),
      strengthWeakness: this.getHeuristicStrengthWeakness(context),
      metadata: {
        isAiGenerated: false,
        provider: 'heuristic_fallback',
        model: 'heuristic-rule-engine-v1',
        generatedAt: new Date().toISOString(),
        confidenceScore: 0.85,
      },
    };
  }

  private getDefaultPacingRounds(): TimeManagementStrategyRound[] {
    return [
      {
        round: 'Round 1 (First 50–60 mins)',
        title: 'Direct & Easy Questions',
        description: 'Solve all 100% confident, single-step questions instantly across all subjects.',
      },
      {
        round: 'Round 2 (Next 60–70 mins)',
        title: 'Moderate & Standard Problems',
        description: 'Tackle multi-step conceptual problems requiring standard formulas and derivations.',
      },
      {
        round: 'Round 3 (Next 25–30 mins)',
        title: 'Difficult / Lengthy Numericals',
        description: 'Attempt challenging calculations and complex assertion-reason questions.',
      },
      {
        round: 'Final 15–20 minutes',
        title: 'Verification & Review',
        description: 'Review marked questions, check calculations, and confirm no answers were skipped accidentally.',
      },
    ];
  }

  private getHeuristic14DayPlan(
    context: StudentExamAiContext,
  ): FourteenDayImprovementPlanSection {
    const activeSubjects =
      context.subjects && context.subjects.length > 0
        ? context.subjects
        : [{ subjectName: context.exam.title || 'General', accuracy: context.overall.accuracy }];

    const weakChaps = context.chapters
      .filter((c) => c.status === 'CRITICAL' || c.accuracy < 60)
      .map((c) => c.chapterName);

    const initialBlocks: any[] = [];

    if (activeSubjects.length === 1) {
      const s = activeSubjects[0];
      const sChaps = context.chapters.filter((c) => c.subjectName === s.subjectName).map((c) => c.chapterName);
      const chaps1 = sChaps.slice(0, 2).length ? sChaps.slice(0, 2) : ['Core Theoretical Concepts'];
      const chaps2 = sChaps.slice(2, 4).length ? sChaps.slice(2, 4) : ['Standard Application Practice'];
      const chaps3 = sChaps.slice(4, 6).length ? sChaps.slice(4, 6) : ['Advanced Numericals & Speed Drilling'];

      initialBlocks.push(
        {
          period: 'Days 1–3',
          title: `${s.subjectName} — Core Theory & Fundamental Derivations`,
          subject: s.subjectName,
          focusChapters: chaps1,
          activities: [
            'Core formula derivation and concept reinforcement',
            'Solve 40–60 fundamental questions to lock in core principles',
            'Review previous mistakes and note key traps',
          ],
          practiceVolume: '40–60 questions/day',
        },
        {
          period: 'Days 4–6',
          title: `${s.subjectName} — Application Drilling & Moderate Problems`,
          subject: s.subjectName,
          focusChapters: chaps2,
          activities: [
            'Focus on multi-step analytical and standard numerical applications',
            'Time-restricted chapter-level practice (60–90 seconds per question)',
            'Resolve all incorrect answers from this mock test systematically',
          ],
          practiceVolume: '50–70 questions/day',
        },
        {
          period: 'Days 7–9',
          title: `${s.subjectName} — Advanced Problem Solving & Speed Precision`,
          subject: s.subjectName,
          focusChapters: chaps3,
          activities: [
            'High-difficulty previous year questions (PYQs) and challenging formats',
            'Timed sprint drills under strict 45-minute limits',
            'Execution of option elimination technique to avoid negative marking',
          ],
          practiceVolume: '60–80 questions/day',
        },
      );
    } else if (activeSubjects.length === 2) {
      const s1 = activeSubjects[0];
      const s2 = activeSubjects[1];
      const s1Chaps = context.chapters.filter((c) => c.subjectName === s1.subjectName).map((c) => c.chapterName);
      const s2Chaps = context.chapters.filter((c) => c.subjectName === s2.subjectName).map((c) => c.chapterName);

      initialBlocks.push(
        {
          period: 'Days 1–3',
          title: `${s1.subjectName} — Priority Remediation & Core Formulas`,
          subject: s1.subjectName,
          focusChapters: s1Chaps.slice(0, 3).length ? s1Chaps.slice(0, 3) : ['Priority Conceptual Areas'],
          activities: [
            'Core formula derivation and concept reinforcement',
            'Solve 50–70 standard numerical problems daily',
            'Log and audit all mistakes in dedicated Error Notebook',
          ],
          practiceVolume: '50–70 questions/day',
        },
        {
          period: 'Days 4–6',
          title: `${s2.subjectName} — High-Yield Revision & Numerical Precision`,
          subject: s2.subjectName,
          focusChapters: s2Chaps.slice(0, 3).length ? s2Chaps.slice(0, 3) : ['High-Yield Chapters'],
          activities: [
            'High-frequency numerical practice and formula sheet revision',
            'Focused PYQ solving with strict timer enforcement',
            'Option elimination drills to eliminate avoidable guesses',
          ],
          practiceVolume: '50–70 questions/day',
        },
        {
          period: 'Days 7–9',
          title: `${s1.subjectName} & ${s2.subjectName} — Cross-Subject Integrated Drills`,
          subject: `${s1.subjectName} & ${s2.subjectName}`,
          focusChapters: [...s1Chaps.slice(0, 2), ...s2Chaps.slice(0, 2)],
          activities: [
            'Combined two-subject timed drills under 90 minutes',
            'Speed and accuracy balance check across both subjects',
            'Comprehensive review of weak questions from Days 1–6',
          ],
          practiceVolume: '60–80 questions/day',
        },
      );
    } else {
      const s1 = activeSubjects[0].subjectName;
      const s2 = activeSubjects[1].subjectName;
      const s3 = activeSubjects[2].subjectName;

      initialBlocks.push(
        {
          period: 'Days 1–3',
          title: `${s1} Focus & Numerical Drilling`,
          subject: s1,
          focusChapters: weakChaps.slice(0, 2).length ? weakChaps.slice(0, 2) : ['Core Problem Areas'],
          activities: [
            'Core formula derivation and concept reinforcement',
            'Solve 50–75 standard numerical problems daily',
            'Review previous mistakes and note key traps',
          ],
          practiceVolume: '50–75 questions/day',
        },
        {
          period: 'Days 4–6',
          title: `${s2} High-Yield & Application Drilling`,
          subject: s2,
          focusChapters: weakChaps.slice(2, 4).length ? weakChaps.slice(2, 4) : ['High-Yield Applications & Problem Solving'],
          activities: [
            `${s2} high-yield calculation drills & formula sheet revision`,
            `Standard problem-solving patterns and shortcut methods for ${s2}`,
            `Focused PYQ practice on moderate-difficulty chapters in ${s2}`,
          ],
          practiceVolume: '60–80 questions/day',
        },
        {
          period: 'Days 7–9',
          title: `${s3} Intensive Problem Solving`,
          subject: s3,
          focusChapters: weakChaps.slice(4, 6).length ? weakChaps.slice(4, 6) : ['Core Analytical Chapters'],
          activities: [
            `Comprehensive revision of core formulas and key definitions for ${s3}`,
            'High-frequency PYQ (Previous Year Questions) practice',
            'Timed section drills under 45 minutes',
          ],
          practiceVolume: '70–90 questions/day',
        },
      );
    }

    return {
      blocks: [
        ...initialBlocks,
        {
          period: 'Days 10–11',
          title: 'Mixed Practice & Error Notebook Remediation',
          focusChapters: ['All Priority Weak Areas', 'Error Notebook Questions'],
          activities: [
            'Solve 100+ mixed-subject questions from previous mistakes',
            'Re-attempt all incorrect questions from this BRAINROS test',
            'Speed drilling with 60-second time limits per question',
          ],
          practiceVolume: '100 questions/day',
        },
        {
          period: 'Day 12',
          title: 'Full-Length BRAINROS Mock Test',
          focusChapters: ['Full Exam Syllabus'],
          activities: [
            'Take full-length timed exam under strict exam conditions',
            'Execute Round 1, Round 2, Round 3 time management strategy',
            'Strictly adhere to 50-50 elimination rule to minimize guessing',
          ],
          practiceVolume: 'Full Length Test',
        },
        {
          period: 'Day 13',
          title: 'Deep Error Audit & Root-Cause Analysis',
          focusChapters: ['Mock Test Errors', 'Calculation Slips'],
          activities: [
            'Audit every wrong and unattempted question from Day 12 test',
            'Classify errors into Conceptual, Calculation, and Silly mistakes',
            'Update Error Notebook with corrected solutions and derivations',
          ],
          practiceVolume: 'Comprehensive Review',
        },
        {
          period: 'Day 14',
          title: 'Final Rapid Revision & Formula Sheets',
          focusChapters: ['High-Weightage Formulas', 'NCERT Highlights'],
          activities: [
            'Rapid flashcard and formula handbook revision across all subjects',
            'Review summary tables, named reactions, and physical constants',
            'Mental preparation, relaxation, and exam pacing review',
          ],
          practiceVolume: 'Rapid Recall',
        },
      ],
    };
  }

  private getHeuristicActionChecklist(
    context: StudentExamAiContext,
  ): PersonalizedActionChecklistSection {
    const s1 = context.subjects[0]?.subjectName || 'Core Subjects';
    return {
      items: [
        {
          id: 'act-1',
          text: 'Revise weak chapters every 3 days without fail.',
          category: 'Revision',
          isKeyAction: true,
        },
        {
          id: 'act-2',
          text: 'Maintain an Error Notebook and log every incorrect question immediately.',
          category: 'Error Reduction',
          isKeyAction: true,
        },
        {
          id: 'act-3',
          text: `Practise at least 50 ${s1} numerical problems daily.`,
          category: 'Practice',
          isKeyAction: true,
        },
        {
          id: 'act-4',
          text: 'Revise NCERT textbook line-by-line and review all highlighted summaries.',
          category: 'Theory',
          isKeyAction: false,
        },
        {
          id: 'act-5',
          text: 'Analyse root causes of every incorrect question before moving to next topic.',
          category: 'Error Reduction',
          isKeyAction: true,
        },
        {
          id: 'act-6',
          text: 'Avoid blind guessing and strictly apply the 50-50 elimination rule during tests.',
          category: 'Strategy',
          isKeyAction: true,
        },
        {
          id: 'act-7',
          text: 'Improve calculation speed by doing scratch-pad arithmetic neatly in designated columns.',
          category: 'Speed',
          isKeyAction: false,
        },
        {
          id: 'act-8',
          text: 'Take every BRAINROS mock exam under actual, uninterrupted examination conditions.',
          category: 'Discipline',
          isKeyAction: true,
        },
      ],
    };
  }

  private getHeuristicParentSummary(
    context: StudentExamAiContext,
    recoverableMarks: number,
  ): ParentSummarySection {
    const s = context.overall;
    const strongSubjects = context.subjects
      .filter((sub) => sub.accuracy >= 75)
      .map((sub) => sub.subjectName)
      .join(' and ') || 'Foundational topics';

    const weakSubjects = context.subjects
      .filter((sub) => sub.accuracy < 70)
      .map((sub) => sub.subjectName)
      .join(' and ') || 'Advanced multi-step problems';

    const targetMin = Math.min(context.exam.maxScore, s.score + 25);
    const targetMax = Math.min(context.exam.maxScore, s.score + 60);

    return {
      summaryParagraph: `Your ward ${context.student.name} has achieved ${s.score}/${s.maxScore} marks (${Math.round(s.percentage)}%), demonstrating steady preparation. Performance in ${strongSubjects} was commendable. The major opportunity for immediate score improvement lies in ${weakSubjects}, along with eliminating avoidable calculation mistakes. With systematic revision and test analysis, your ward has the potential to reach the ${targetMin}–${targetMax}+ range.`,
      keyHighlights: [
        `Scored ${s.score}/${s.maxScore} (${Math.round(s.percentage)}%) with ${Math.round(s.accuracy)}% accuracy.`,
        `Solid performance in ${strongSubjects}.`,
        `Immediate gain opportunity of ~${Math.max(10, recoverableMarks)} marks in ${weakSubjects}.`,
      ],
      potentialScoreRange: `${targetMin}–${targetMax}+`,
    };
  }

  private getHeuristicPerformanceIndex(
    context: StudentExamAiContext,
  ): BrainrosPerformanceIndexSection {
    const s = context.overall;
    const academicStars = Math.min(5, Math.max(1, Math.round((s.percentage / 20) * 10) / 10));
    const conceptualStars = Math.min(5, Math.max(1, Math.round((s.accuracy / 20) * 10) / 10));
    const accuracyStars = Math.min(5, Math.max(1, Math.round((s.accuracy / 20) * 10) / 10));
    const timeMgmtStars = 4.0;
    const revisionStars = Math.min(5, Math.max(1, Math.round((academicStars + accuracyStars) / 2)));
    const readinessStars = Math.min(5, Math.max(1, Math.round(((academicStars + accuracyStars + timeMgmtStars) / 3) * 10) / 10));

    const overallRating =
      s.percentage >= 85 || s.accuracy >= 85
        ? 'EXCELLENT'
        : s.percentage >= 70 || s.accuracy >= 75
        ? 'VERY GOOD'
        : s.percentage >= 50
        ? 'GOOD'
        : 'NEEDS ATTENTION';

    return {
      metrics: [
        { dimension: 'Academic Strength', ratingStars: academicStars, ratingLabel: `${academicStars.toFixed(1)}/5.0` },
        { dimension: 'Conceptual Understanding', ratingStars: conceptualStars, ratingLabel: `${conceptualStars.toFixed(1)}/5.0` },
        { dimension: 'Accuracy', ratingStars: accuracyStars, ratingLabel: `${accuracyStars.toFixed(1)}/5.0` },
        { dimension: 'Time Management', ratingStars: timeMgmtStars, ratingLabel: `${timeMgmtStars.toFixed(1)}/5.0` },
        { dimension: 'Revision Level', ratingStars: revisionStars, ratingLabel: `${revisionStars.toFixed(1)}/5.0` },
        { dimension: 'Exam Readiness', ratingStars: readinessStars, ratingLabel: `${readinessStars.toFixed(1)}/5.0` },
      ],
      overallRating,
    };
  }

  private getHeuristicExpectedPerformance(
    context: StudentExamAiContext,
  ): ExpectedPerformanceSection {
    const currScore = context.overall.score;
    const maxScore = context.exam.maxScore;
    const shortTerm = Math.min(maxScore, currScore + Math.max(20, Math.round((maxScore - currScore) * 0.25)));
    const strongTarget = Math.min(maxScore, currScore + Math.max(45, Math.round((maxScore - currScore) * 0.5)));
    const excellentTarget = Math.min(maxScore, Math.max(strongTarget + 20, Math.round(maxScore * 0.92)));

    return {
      currentScore: currScore,
      maxScore,
      shortTermTarget: shortTerm,
      strongTarget,
      excellentTarget,
      actionableMessage: 'Focus on accuracy, revision of priority weak chapters, and elimination of avoidable calculation mistakes to move to the next competitive bracket.',
    };
  }

  private getHeuristicStrengthWeakness(
    context: StudentExamAiContext,
  ): StrengthWeaknessSection {
    const strongSubjects = context.subjects
      .filter((s) => s.accuracy >= 75)
      .map((s) => `${s.subjectName} conceptual accuracy (${s.accuracy}%)`);

    const weakSubjects = context.subjects
      .filter((s) => s.accuracy < 70)
      .map((s) => `${s.subjectName} problem-solving depth (${s.accuracy}% accuracy)`);

    return {
      topStrengths: strongSubjects.length ? strongSubjects.slice(0, 3) : ['Solid foundational attempt commitment across test duration'],
      priorityWeaknesses: weakSubjects.length ? weakSubjects.slice(0, 3) : ['Time allocation & question scanning speed for complex numericals'],
    };
  }

  public validatePlanSubjects(plan: any, examSubjects: { subjectName: string }[]): boolean {
    if (!plan?.blocks || !Array.isArray(plan.blocks) || plan.blocks.length === 0) return false;
    if (!examSubjects || examSubjects.length === 0) return true;
    const allowed = new Set(examSubjects.map((s) => (s.subjectName || '').toLowerCase().trim()));
    allowed.add('all subjects');
    allowed.add('all');
    allowed.add('general');
    return !plan.blocks.some((b: any) => {
      if (!b.subject) return false;
      const sub = b.subject.toLowerCase().trim();
      return ![...allowed].some((a) => a && (sub.includes(a) || a.includes(sub)));
    });
  }
}
