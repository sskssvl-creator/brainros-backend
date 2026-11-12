import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GeminiRateLimiterService } from './gemini-rate-limiter.service';
import {
  GeminiErrorClassifier,
  GeminiErrorKind,
} from './gemini-error-classifier';
import { AI_TRANSLATION_DEFAULTS } from '../constants/ai-translation.constants';
import {
  validateTextScript,
  sanitizeTextScript,
  INDIC_SCRIPT_BLOCKS,
} from '../../../common/utils/unicode-script-validator';

export interface QuestionBatchItem {
  questionNumber: number;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  assertion?: string;
  reason?: string;
  passage?: string;
}

export interface TranslatedQuestionBatchItem {
  questionNumber: number;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  assertion?: string;
  reason?: string;
  passage?: string;
}

export interface RichQuestionBatchItem {
  questionNumber: number;
  questionSegments: Record<string, string>;
  optionASegments: Record<string, string>;
  optionBSegments: Record<string, string>;
  optionCSegments: Record<string, string>;
  optionDSegments: Record<string, string>;
  assertionSegments?: Record<string, string>;
  reasonSegments?: Record<string, string>;
  passageSegments?: Record<string, string>;
}

export interface TranslatedRichQuestionBatchItem {
  questionNumber: number;
  questionSegments: Record<string, string>;
  optionASegments: Record<string, string>;
  optionBSegments: Record<string, string>;
  optionCSegments: Record<string, string>;
  optionDSegments: Record<string, string>;
  assertionSegments?: Record<string, string>;
  reasonSegments?: Record<string, string>;
  passageSegments?: Record<string, string>;
}

@Injectable()
export class GeminiTranslationService {
  private readonly logger = new Logger(GeminiTranslationService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private modelName: string;
  private maxRetries: number;
  private retryBufferMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly rateLimiter: GeminiRateLimiterService,
  ) {
    const rawKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY ||
      '';
    const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

    this.modelName = (
      this.configService.get<string>('GEMINI_TRANSLATION_MODEL') ||
      this.configService.get<string>('GEMINI_MODEL') ||
      process.env.GEMINI_TRANSLATION_MODEL ||
      process.env.GEMINI_MODEL ||
      AI_TRANSLATION_DEFAULTS.DEFAULT_MODEL
    )
      .trim()
      .replace(/^["']|["']$/g, '');

    this.maxRetries = Number(
      this.configService.get<number>('GEMINI_MAX_RETRIES') ||
        process.env.GEMINI_MAX_RETRIES ||
        AI_TRANSLATION_DEFAULTS.MAX_RETRIES,
    );

    this.retryBufferMs = Number(
      this.configService.get<number>('GEMINI_RETRY_BUFFER_MS') ||
        process.env.GEMINI_RETRY_BUFFER_MS ||
        AI_TRANSLATION_DEFAULTS.RETRY_BUFFER_MS,
    );

    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    } else {
      this.logger.warn(
        'GEMINI_API_KEY is not set. AI translation requests will fail until an API key is provided.',
      );
    }
  }

  /**
   * Translate a batch of rich questions (with isolated text segments) with strict script validation & auto-correction
   */
  async translateRichBatch(
    questions: RichQuestionBatchItem[],
    targetLanguageName: string,
    targetLanguageCode: string,
  ): Promise<TranslatedRichQuestionBatchItem[]> {
    if (!questions || questions.length === 0) {
      return [];
    }

    if (!this.genAI) {
      const rawKey =
        this.configService.get<string>('GEMINI_API_KEY') ||
        process.env.GEMINI_API_KEY ||
        '';
      const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');
      if (!apiKey) {
        throw new Error(
          'GEMINI_API_KEY is missing. Please configure it in environment variables.',
        );
      }
      this.genAI = new GoogleGenerativeAI(apiKey);
    }

    const basePrompt = this.buildRichPrompt(questions, targetLanguageName, targetLanguageCode);
    const candidateModels = this.resolveCandidateModels();

    let lastError: Error | null = null;
    let correctiveFeedback = '';

    for (const modelId of candidateModels) {
      const model = this.genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        const releaseSlot = await this.rateLimiter.acquireSlot();

        try {
          const currentPrompt = correctiveFeedback
            ? `${basePrompt}\n\n🚨 URGENT CORRECTION REQUIRED (Previous attempt failed):\n${correctiveFeedback}\nTranslate ALL questions again ensuring 100% pure ${targetLanguageName} script.`
            : basePrompt;

          const result = await model.generateContent(currentPrompt);
          const responseText = result.response.text();
          const parsed = this.parseAndValidateRichResponse(
            responseText,
            questions,
            targetLanguageCode,
            targetLanguageName,
          );
          return parsed;
        } catch (err: any) {
          lastError = err;

          if (err.isScriptValidationError) {
            correctiveFeedback = `SCRIPT CONTAMINATION DETECTED on attempt ${attempt}: ${err.message}. You MUST use ONLY ${targetLanguageName} characters (no other Indic scripts, no Greek, no Thai).`;
            this.logger.warn(
              `[${modelId}] Script validation failed for ${targetLanguageName} (attempt ${attempt}/${this.maxRetries}): ${err.message}. Retrying with targeted script enforcement prompt...`,
            );
          } else {
            const classified = GeminiErrorClassifier.classify(err, {
              defaultRetryDelayMs: 5000,
              retryBufferMs: this.retryBufferMs,
            });

            this.logger.warn(
              `[${modelId}] Rich Translation attempt ${attempt}/${this.maxRetries} failed for ${targetLanguageName}: [${classified.kind}] ${err.message}`,
            );

            if (
              classified.kind === GeminiErrorKind.AUTHENTICATION_ERROR ||
              classified.kind === GeminiErrorKind.INVALID_REQUEST
            ) {
              throw new Error(classified.userFacingMessage);
            }

            if (
              classified.kind === GeminiErrorKind.MODEL_UNAVAILABLE ||
              classified.kind === GeminiErrorKind.DAILY_QUOTA_EXHAUSTED
            ) {
              this.logger.warn(
                `[${modelId}] Model unavailable or quota exhausted for ${targetLanguageName}. Switching to next candidate model...`,
              );
              break;
            }
          }

          if (attempt < this.maxRetries) {
            const delay = 2000 * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } finally {
          releaseSlot();
        }
      }
    }

    throw lastError || new Error(`Rich translation failed for language ${targetLanguageName}`);
  }

  /**
   * Translate a batch of plain questions to the target language with strict script validation & auto-correction
   */
  async translateBatch(
    questions: QuestionBatchItem[],
    targetLanguageName: string,
    targetLanguageCode: string,
  ): Promise<TranslatedQuestionBatchItem[]> {
    if (!questions || questions.length === 0) {
      return [];
    }

    if (!this.genAI) {
      const rawKey =
        this.configService.get<string>('GEMINI_API_KEY') ||
        process.env.GEMINI_API_KEY ||
        '';
      const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');
      if (!apiKey) {
        throw new Error(
          'GEMINI_API_KEY is missing. Please configure it in environment variables.',
        );
      }
      this.genAI = new GoogleGenerativeAI(apiKey);
    }

    const basePrompt = this.buildPrompt(questions, targetLanguageName, targetLanguageCode);
    const candidateModels = this.resolveCandidateModels();

    let lastError: Error | null = null;
    let correctiveFeedback = '';

    for (const modelId of candidateModels) {
      const model = this.genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        const releaseSlot = await this.rateLimiter.acquireSlot();

        try {
          const currentPrompt = correctiveFeedback
            ? `${basePrompt}\n\n🚨 URGENT CORRECTION REQUIRED (Previous attempt failed):\n${correctiveFeedback}\nTranslate ALL questions again ensuring 100% pure ${targetLanguageName} script.`
            : basePrompt;

          const result = await model.generateContent(currentPrompt);
          const responseText = result.response.text();
          const parsed = this.parseAndValidateResponse(
            responseText,
            questions,
            targetLanguageCode,
            targetLanguageName,
          );
          return parsed;
        } catch (err: any) {
          lastError = err;

          if (err.isScriptValidationError) {
            correctiveFeedback = `SCRIPT CONTAMINATION DETECTED on attempt ${attempt}: ${err.message}. You MUST use ONLY ${targetLanguageName} characters.`;
            this.logger.warn(
              `[${modelId}] Script validation failed for ${targetLanguageName} (attempt ${attempt}/${this.maxRetries}): ${err.message}. Retrying with targeted script enforcement prompt...`,
            );
          } else {
            const classified = GeminiErrorClassifier.classify(err, {
              defaultRetryDelayMs: 5000,
              retryBufferMs: this.retryBufferMs,
            });

            this.logger.warn(
              `[${modelId}] Translation attempt ${attempt}/${this.maxRetries} failed for ${targetLanguageName}: [${classified.kind}] ${err.message}`,
            );

            if (
              classified.kind === GeminiErrorKind.AUTHENTICATION_ERROR ||
              classified.kind === GeminiErrorKind.INVALID_REQUEST
            ) {
              throw new Error(classified.userFacingMessage);
            }

            if (
              classified.kind === GeminiErrorKind.MODEL_UNAVAILABLE ||
              classified.kind === GeminiErrorKind.DAILY_QUOTA_EXHAUSTED
            ) {
              this.logger.warn(
                `[${modelId}] Model unavailable or quota exhausted for ${targetLanguageName}. Switching to next candidate model...`,
              );
              break;
            }
          }

          if (attempt < this.maxRetries) {
            const delay = 2000 * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } finally {
          releaseSlot();
        }
      }
    }

    throw lastError || new Error(`Translation failed for language ${targetLanguageName}`);
  }

  private resolveCandidateModels(): string[] {
    const list = [this.modelName];
    const FALLBACK_MODELS = [
      'gemini-3.1-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-3.5-flash',
      'gemini-3.8-flash',
    ];

    for (const fb of FALLBACK_MODELS) {
      if (!list.includes(fb)) {
        list.push(fb);
      }
    }
    return list;
  }

  private buildRichPrompt(
    questions: RichQuestionBatchItem[],
    targetLanguageName: string,
    targetLanguageCode: string,
  ): string {
    const scriptInfo = INDIC_SCRIPT_BLOCKS[targetLanguageCode.toLowerCase()] || {
      name: targetLanguageName,
    };

    return `You are a certified professional academic translator specializing in Indian competitive examination question papers (NEET / JEE).
Translate the text segments within each question into ${targetLanguageName} (${targetLanguageCode}).
REQUIRED SCRIPT: ${scriptInfo.name} script.

CRITICAL TRANSLATION & SCRIPT PURITY RULES:
1. STRICT SCRIPT ISOLATION (ZERO TOLERANCE FOR CROSS-SCRIPT CONTAMINATION):
   - Every single word must be written 100% in the native ${scriptInfo.name} script of ${targetLanguageName}.
   - NEVER use characters or words from OTHER Indian scripts:
     * NEVER use Gujarati script for Bengali, Tamil, Telugu, Hindi, Kannada, or Malayalam.
     * NEVER mix Tamil characters or suffixes (e.g. -ன், -ம், ாங்கம்) into Telugu, Malayalam, or Kannada.
     * NEVER mix Bengali characters into Telugu, Kannada, or Gujarati.
     * NEVER mix Devanagari characters into Gujarati, Telugu, Tamil, Kannada, or Malayalam.
     * NEVER output Greek characters (e.g. απότομη) or Thai tone marks.
   - Standard Latin letters and ASCII digits/symbols are permitted ONLY for standard scientific notations, chemical formulas, and SI units (e.g. CO2, ATP, DNA, kg, m/s², pH, °C, 400 K, sin, cos).
2. COMPLETE TRANSLATION OF ALL OPTIONS:
   - Translate ALL 4 multiple-choice options (A, B, C, D).
   - Do NOT leave chemical names or choices in English (e.g. translate "Ethane, Ethene, Ethyne, Benzene" into ${targetLanguageName}).
3. NO QUESTION PREFIXES OR LABELS:
   - Do NOT prepend "Q121:", "Question 121:", "પ્રશ્ન ૧૨૧:", "প্রশ্ন ১২১:", "ప్రశ్న", "ಪ್ರಶ್ನೆ" or any number label inside the segment values. The question number is managed externally.
4. DO NOT change, add, or delete segment keys (e.g. seg_0, seg_1). Keep every key EXACTLY as provided.
5. Preserve mathematical formulas, chemical equations, numerical values, and standard scientific units.
6. Output strictly a valid JSON array of objects matching the input structure:
[
  {
    "questionNumber": number,
    "questionSegments": { "seg_0": "translated text strictly in ${targetLanguageName}", ... },
    "optionASegments": { "seg_1": "translated text strictly in ${targetLanguageName}", ... },
    "optionBSegments": { "seg_2": "translated text strictly in ${targetLanguageName}", ... },
    "optionCSegments": { "seg_3": "translated text strictly in ${targetLanguageName}", ... },
    "optionDSegments": { "seg_4": "translated text strictly in ${targetLanguageName}", ... },
    "assertionSegments": { ... },
    "reasonSegments": { ... },
    "passageSegments": { ... }
  }
]

INPUT QUESTIONS AND SEGMENTS:
${JSON.stringify(questions, null, 2)}
`;
  }

  private buildPrompt(
    questions: QuestionBatchItem[],
    targetLanguageName: string,
    targetLanguageCode: string,
  ): string {
    const scriptInfo = INDIC_SCRIPT_BLOCKS[targetLanguageCode.toLowerCase()] || {
      name: targetLanguageName,
    };

    return `You are a certified professional academic translator specializing in Indian competitive examination question papers (NEET / JEE).
Translate the following exam questions and their multiple choice options from English into ${targetLanguageName} (${targetLanguageCode}).
REQUIRED SCRIPT: ${scriptInfo.name} script.

CRITICAL TRANSLATION & SCRIPT PURITY RULES:
1. STRICT SCRIPT ISOLATION:
   - Translate 'question', 'optionA', 'optionB', 'optionC', and 'optionD' accurately and strictly in the native script of ${targetLanguageName} (${scriptInfo.name}).
   - NEVER use characters or words from OTHER Indian scripts:
     * NEVER use Gujarati script for Bengali, Tamil, Telugu, Hindi, Kannada, or Malayalam.
     * NEVER mix Tamil characters or suffixes into Telugu, Malayalam, or Kannada.
     * NEVER mix Bengali characters into Telugu, Kannada, or Gujarati.
     * NEVER mix Devanagari characters into Gujarati, Telugu, Tamil, Kannada, or Malayalam.
     * NEVER output Greek characters or Thai tone marks.
2. COMPLETE TRANSLATION:
   - Do NOT leave options in English characters. Translate all options into ${targetLanguageName}.
3. NO QUESTION PREFIXES:
   - Do NOT prepend "Q1:", "Question 1:", or any numbering inside the translated text.
4. DO NOT change or reorder 'questionNumber'.
5. Preserve mathematical formulas, chemical equations, numerical values, and standard scientific units (e.g. m/s², kg, °C, 400 K).
6. If the translated text contains double quotes ("), properly escape them as \\" inside JSON strings.
7. Output strictly a valid JSON array of objects without markdown fences, comments, or trailing commas:
[
  {
    "questionNumber": number,
    "question": "translated question text in ${targetLanguageName}",
    "optionA": "translated option A in ${targetLanguageName}",
    "optionB": "translated option B in ${targetLanguageName}",
    "optionC": "translated option C in ${targetLanguageName}",
    "optionD": "translated option D in ${targetLanguageName}"
  }
]

INPUT QUESTIONS:
${JSON.stringify(questions, null, 2)}
`;
  }

  private extractAndCleanJson(responseText: string): any {
    let cleanText = responseText.trim();

    // 1. Remove markdown code fences anywhere in the string
    const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      cleanText = codeBlockMatch[1].trim();
    } else {
      cleanText = cleanText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
    }

    // 2. Locate outermost JSON array [ ... ]
    const firstBracket = cleanText.indexOf('[');
    const lastBracket = cleanText.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      cleanText = cleanText.substring(firstBracket, lastBracket + 1);
    }

    return JSON.parse(cleanText);
  }

  private parseAndValidateRichResponse(
    responseText: string,
    originalQuestions: RichQuestionBatchItem[],
    targetLanguageCode: string,
    targetLanguageName: string,
  ): TranslatedRichQuestionBatchItem[] {
    const rawJson = this.extractAndCleanJson(responseText);

    if (!Array.isArray(rawJson)) {
      throw new Error('AI response is not a valid JSON array.');
    }

    const resultMap = new Map<number, TranslatedRichQuestionBatchItem>();

    for (const item of rawJson) {
      if (typeof item.questionNumber !== 'number') continue;
      resultMap.set(item.questionNumber, {
        questionNumber: item.questionNumber,
        questionSegments: item.questionSegments || {},
        optionASegments: item.optionASegments || {},
        optionBSegments: item.optionBSegments || {},
        optionCSegments: item.optionCSegments || {},
        optionDSegments: item.optionDSegments || {},
        assertionSegments: item.assertionSegments,
        reasonSegments: item.reasonSegments,
        passageSegments: item.passageSegments,
      });
    }

    const translatedList: TranslatedRichQuestionBatchItem[] = [];
    for (const orig of originalQuestions) {
      const trans = resultMap.get(orig.questionNumber);
      if (!trans) {
        throw new Error(
          `Missing translated item for rich question #${orig.questionNumber} from AI model.`,
        );
      }

      // Script integrity verification on all segments of this question
      this.validateAndCleanRichSegments(trans, targetLanguageCode, targetLanguageName);

      translatedList.push(trans);
    }

    return translatedList;
  }

  private validateAndCleanRichSegments(
    item: TranslatedRichQuestionBatchItem,
    targetLanguageCode: string,
    targetLanguageName: string,
  ): void {
    const segmentContainers = [
      item.questionSegments,
      item.optionASegments,
      item.optionBSegments,
      item.optionCSegments,
      item.optionDSegments,
      item.assertionSegments,
      item.reasonSegments,
      item.passageSegments,
    ];

    for (const container of segmentContainers) {
      if (!container) continue;
      for (const [key, text] of Object.entries(container)) {
        if (!text || typeof text !== 'string') continue;

        // 1. Strip accidental LLM prefix labels like "Q121:", "Question 121:", "પ્રશ્ન ૧૨૧:", "প্রশ্ন ১২১:"
        let cleaned = text.replace(
          /^(?:Q\d+[:.]?|Question\s*\d+[:.]?|પ્રશ્ન\s*[\d૧૨૩૪૫૬૭૮૯૦]+[:.]?|প্রশ্ন\s*[\d১২৩৪৫৬৭৮৯০]+[:.]?|ప్రశ్న\s*[\d౧౨౩౪౫౬౭౮౯౦]+[:.]?|ಪ್ರಶ್ನೆ\s*[\d೧೨೩೪೫೬೭೮೯೦]+[:.]?|प्रश्न\s*[\d१२३४५६७८९०]+[:.]?|கேள்வி\s*[\d௧௨௩௪௫௬௭௮௯௦]+[:.]?)\s*/i,
          '',
        );

        // 2. Validate script integrity
        const res = validateTextScript(cleaned, targetLanguageCode);
        if (!res.isValid) {
          const isSevere =
            res.violations.length > 2 ||
            res.violations.some((v) => v.detectedScript?.includes('Cross-Script Contamination'));

          if (isSevere) {
            const err = new Error(
              `Question #${item.questionNumber} segment "${key}" has cross-script contamination: ${res.summary}`,
            );
            (err as any).isScriptValidationError = true;
            throw err;
          }

          // Minor isolated stray glyph: sanitize
          const sanitized = sanitizeTextScript(cleaned, targetLanguageCode);
          cleaned = sanitized.cleaned;
        }

        container[key] = cleaned;
      }
    }
  }

  private parseAndValidateResponse(
    responseText: string,
    originalQuestions: QuestionBatchItem[],
    targetLanguageCode: string,
    targetLanguageName: string,
  ): TranslatedQuestionBatchItem[] {
    const rawJson = this.extractAndCleanJson(responseText);

    if (!Array.isArray(rawJson)) {
      throw new Error('AI response is not a valid JSON array.');
    }

    const resultMap = new Map<number, TranslatedQuestionBatchItem>();

    for (const item of rawJson) {
      if (
        typeof item.questionNumber !== 'number' ||
        !item.question ||
        item.optionA === undefined ||
        item.optionB === undefined
      ) {
        continue;
      }

      resultMap.set(item.questionNumber, {
        questionNumber: item.questionNumber,
        question: String(item.question).trim(),
        optionA: String(item.optionA).trim(),
        optionB: String(item.optionB).trim(),
        optionC: String(item.optionC).trim(),
        optionD: String(item.optionD).trim(),
      });
    }

    const translatedList: TranslatedQuestionBatchItem[] = [];
    for (const orig of originalQuestions) {
      const trans = resultMap.get(orig.questionNumber);
      if (!trans) {
        throw new Error(
          `Missing translated item for question #${orig.questionNumber} from AI model.`,
        );
      }

      // Validate & clean plain question items
      this.validateAndCleanPlainItem(trans, targetLanguageCode, targetLanguageName);

      translatedList.push(trans);
    }

    return translatedList;
  }

  private validateAndCleanPlainItem(
    item: TranslatedQuestionBatchItem,
    targetLanguageCode: string,
    targetLanguageName: string,
  ): void {
    const fields: (keyof TranslatedQuestionBatchItem)[] = [
      'question',
      'optionA',
      'optionB',
      'optionC',
      'optionD',
    ];

    for (const field of fields) {
      const val = item[field];
      if (typeof val !== 'string' || !val) continue;

      let cleaned = val.replace(
        /^(?:Q\d+[:.]?|Question\s*\d+[:.]?|પ્રશ્ન\s*[\d૧૨૩૪૫૬૭૮૯૦]+[:.]?|প্রশ্ন\s*[\d১২৩৪৫৬৭৮৯০]+[:.]?|ప్రశ్న\s*[\d౧౨౩౪౫౬౭౮౯౦]+[:.]?|ಪ್ರಶ್ನೆ\s*[\d೧೨೩೪೫೬೭೮೯೦]+[:.]?|प्रश्न\s*[\d१२३४५६७८९०]+[:.]?)\s*/i,
        '',
      );

      const res = validateTextScript(cleaned, targetLanguageCode);
      if (!res.isValid) {
        const isSevere =
          res.violations.length > 2 ||
          res.violations.some((v) => v.detectedScript?.includes('Cross-Script Contamination'));

        if (isSevere) {
          const err = new Error(
            `Question #${item.questionNumber} field "${field}" has cross-script contamination: ${res.summary}`,
          );
          (err as any).isScriptValidationError = true;
          throw err;
        }

        const sanitized = sanitizeTextScript(cleaned, targetLanguageCode);
        cleaned = sanitized.cleaned;
      }

      (item as any)[field] = cleaned;
    }
  }
}
