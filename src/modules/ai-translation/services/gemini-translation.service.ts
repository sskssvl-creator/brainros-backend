import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GeminiRateLimiterService } from './gemini-rate-limiter.service';
import {
  GeminiErrorClassifier,
  GeminiErrorKind,
} from './gemini-error-classifier';
import { AI_TRANSLATION_DEFAULTS } from '../constants/ai-translation.constants';

export interface QuestionBatchItem {
  questionNumber: number;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
}

export interface TranslatedQuestionBatchItem {
  questionNumber: number;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
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
   * Translate a batch of questions to the target language through the Global Rate Limiter
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

    const prompt = this.buildPrompt(questions, targetLanguageName, targetLanguageCode);
    const candidateModels = this.resolveCandidateModels();

    let lastError: Error | null = null;

    for (const modelId of candidateModels) {
      const model = this.genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        // Acquire global rate limit slot (coordinated across all workers & instances)
        const releaseSlot = await this.rateLimiter.acquireSlot();

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          const parsed = this.parseAndValidateResponse(responseText, questions);
          return parsed;
        } catch (err: any) {
          lastError = err;
          const classified = GeminiErrorClassifier.classify(err, {
            defaultRetryDelayMs: 5000,
            retryBufferMs: this.retryBufferMs,
          });

          this.logger.warn(
            `[${modelId}] Translation attempt ${attempt}/${this.maxRetries} failed for ${targetLanguageName}: [${classified.kind}] ${err.message}`,
          );

          // Handle 401 Authentication & 400 Malformed requests -> Immediate fail
          if (
            classified.kind === GeminiErrorKind.AUTHENTICATION_ERROR ||
            classified.kind === GeminiErrorKind.INVALID_REQUEST
          ) {
            throw new Error(classified.userFacingMessage);
          }

          // Handle Model Missing -> Skip to next model
          if (classified.kind === GeminiErrorKind.MODEL_UNAVAILABLE) {
            break;
          }

          // Handle Daily Quota Exhaustion -> Pause globally and throw user-facing error
          if (classified.kind === GeminiErrorKind.DAILY_QUOTA_EXHAUSTED) {
            await this.rateLimiter.pauseGlobally(
              3600000, // 1 hour pause
              'Daily Gemini API Quota Exhausted',
            );
            throw new Error(classified.userFacingMessage);
          }

          // Handle Temporary 429 Rate Limit -> Pause globally across all workers
          if (classified.kind === GeminiErrorKind.TEMPORARY_RATE_LIMIT) {
            await this.rateLimiter.pauseGlobally(
              classified.retryDelayMs,
              `HTTP 429 for ${modelId}: ${err.message}`,
            );
          }

          // If retryable and attempts remain, wait before next loop
          if (classified.isRetryable && attempt < this.maxRetries) {
            const waitMs = Math.max(classified.retryDelayMs, 2000);
            this.logger.log(
              `Waiting ${Math.round(waitMs / 1000)}s before retry attempt ${attempt + 1}...`,
            );
            await new Promise((res) => setTimeout(res, waitMs));
          } else if (!classified.isRetryable) {
            // Non-retryable error on this model -> switch model or throw
            break;
          }
        } finally {
          releaseSlot();
        }
      }
    }

    const sanitizedMessage = GeminiErrorClassifier.sanitize(lastError);
    throw new Error(sanitizedMessage);
  }

  private resolveCandidateModels(): string[] {
    const verified = AI_TRANSLATION_DEFAULTS.VERIFIED_MODELS;
    const candidates = [this.modelName, ...verified];
    return Array.from(new Set(candidates)).filter(
      (m) =>
        Boolean(m) &&
        !m.includes('3.8') &&
        !m.includes('3.6') &&
        !m.includes('preview') &&
        !m.includes('latest'),
    );
  }

  private buildPrompt(
    questions: QuestionBatchItem[],
    targetLanguageName: string,
    targetLanguageCode: string,
  ): string {
    return `You are a certified professional academic translator specializing in educational and competitive examination question papers.
Translate the following exam questions and their multiple choice options from English into ${targetLanguageName} (${targetLanguageCode}).

STRICT TRANSLATION RULES:
1. Translate the 'question', 'optionA', 'optionB', 'optionC', and 'optionD' text accurately into ${targetLanguageName}.
2. ALL output text for 'question', 'optionA', 'optionB', 'optionC', and 'optionD' MUST be written in the native script/alphabet of ${targetLanguageName} (e.g. Gujarati script for Gujarati, Devanagari script for Hindi/Marathi, Tamil script for Tamil, Telugu script for Telugu, Bengali script for Bengali, Malayalam script for Malayalam, Kannada script for Kannada).
3. Do NOT leave sentences, placeholder words, or text in English/Latin characters when translating into a regional language. Even if the input contains test data, dummy words, or placeholder text, translate and render them completely into ${targetLanguageName}'s native script.
4. DO NOT change or reorder 'questionNumber'.
5. Preserve mathematical formulas, chemical equations, numerical values, and standard scientific units (e.g. m/s², kg, °C).
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

    // 3. Try standard JSON.parse first
    try {
      return JSON.parse(cleanText);
    } catch (firstErr: any) {
      // 4. Sanitize trailing commas before } or ]
      let repaired = cleanText.replace(/,\s*([}\]])/g, '$1');

      try {
        return JSON.parse(repaired);
      } catch (secondErr: any) {
        // 5. Try fixing unescaped newlines/tabs inside JSON string literals
        repaired = repaired.replace(/[\u0000-\u001F\u007F-\u009F]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '';
        });

        try {
          return JSON.parse(repaired);
        } catch (_) {
          // Re-throw with clean message for retry classifier
          throw new Error(`Invalid JSON returned from AI model: ${firstErr.message}`);
        }
      }
    }
  }

  private parseAndValidateResponse(
    responseText: string,
    originalQuestions: QuestionBatchItem[],
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

    // Ensure all input questions have translations
    const translatedList: TranslatedQuestionBatchItem[] = [];
    for (const orig of originalQuestions) {
      const trans = resultMap.get(orig.questionNumber);
      if (!trans) {
        throw new Error(
          `Missing translated item for question #${orig.questionNumber} from AI model.`,
        );
      }
      translatedList.push(trans);
    }

    return translatedList;
  }
}
