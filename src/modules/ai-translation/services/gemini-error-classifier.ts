export enum GeminiErrorKind {
  TEMPORARY_RATE_LIMIT = 'TEMPORARY_RATE_LIMIT',
  DAILY_QUOTA_EXHAUSTED = 'DAILY_QUOTA_EXHAUSTED',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  INVALID_REQUEST = 'INVALID_REQUEST',
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  MODEL_OUTPUT_ERROR = 'MODEL_OUTPUT_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface ClassifiedGeminiError {
  kind: GeminiErrorKind;
  isRetryable: boolean;
  retryDelayMs: number;
  userFacingMessage: string;
  internalMessage: string;
  statusCode?: number;
}

/**
 * Parses Gemini API error strings or objects and extracts structured classification,
 * delay duration, retryability, and clean user-facing explanations.
 */
export class GeminiErrorClassifier {
  /**
   * Parse retryDelay from Google Gemini / GoogleGenerativeAI error messages.
   * Format examples:
   * - 'retryDelay": "56s"'
   * - 'retry in 8.961218643s'
   * - 'retryDelay: 12s'
   */
  public static parseRetryDelayMs(
    errorMessage: string,
    defaultDelayMs = 5000,
    bufferMs = 3000,
  ): number {
    if (!errorMessage) return defaultDelayMs;

    // 1. Check for JSON style: "retryDelay": "56s" or "retryDelay": "56.4s"
    const jsonMatch =
      errorMessage.match(/"retryDelay"\s*:\s*"([0-9.]+)s?"/i) ||
      errorMessage.match(/retryDelay\s*:\s*"?([0-9.]+)s?"?/i);
    if (jsonMatch && jsonMatch[1]) {
      const sec = parseFloat(jsonMatch[1]);
      if (!isNaN(sec) && sec > 0) {
        return Math.ceil(sec * 1000) + bufferMs;
      }
    }

    // 2. Check for text style: "Please retry in 8.961218643s."
    const textMatch = errorMessage.match(/retry in\s+([0-9.]+)\s*s/i);
    if (textMatch && textMatch[1]) {
      const sec = parseFloat(textMatch[1]);
      if (!isNaN(sec) && sec > 0) {
        return Math.ceil(sec * 1000) + bufferMs;
      }
    }

    return defaultDelayMs + bufferMs;
  }

  /**
   * Classify any error thrown by @google/generative-ai or HTTP calls.
   */
  public static classify(
    error: any,
    options?: { defaultRetryDelayMs?: number; retryBufferMs?: number },
  ): ClassifiedGeminiError {
    const rawMessage = error?.message || String(error) || '';
    const defaultDelay = options?.defaultRetryDelayMs ?? 5000;
    const buffer = options?.retryBufferMs ?? 3000;

    // 1. Authentication / Permission errors (401 / 403 / API Key)
    if (
      rawMessage.includes('401') ||
      rawMessage.includes('403') ||
      rawMessage.includes('Unauthorized') ||
      rawMessage.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') ||
      rawMessage.includes('invalid authentication credentials') ||
      rawMessage.includes('API_KEY_INVALID')
    ) {
      return {
        kind: GeminiErrorKind.AUTHENTICATION_ERROR,
        isRetryable: false,
        retryDelayMs: 0,
        statusCode: 401,
        internalMessage: rawMessage,
        userFacingMessage:
          'AI translation authentication failed. Please verify the Gemini API key in configuration.',
      };
    }

    // 2. Daily Quota Exhaustion (Permanent for the day)
    const isDailyQuota =
      rawMessage.includes('GenerateRequestsPerDay') ||
      rawMessage.includes('PerDay') ||
      (rawMessage.includes('free_tier_requests') && (rawMessage.includes('limit') || rawMessage.includes('20'))) ||
      rawMessage.includes('Quota exceeded for metric') ||
      rawMessage.includes('Quota exceeded for quota metric');

    if (isDailyQuota) {
      return {
        kind: GeminiErrorKind.DAILY_QUOTA_EXHAUSTED,
        isRetryable: false, // Must not hammer the API in a tight loop
        retryDelayMs: 0,
        statusCode: 429,
        internalMessage: rawMessage,
        userFacingMessage:
          'AI translation is temporarily paused because the configured Gemini API daily quota has been reached. Please upgrade your Gemini plan or check API quota settings.',
      };
    }

    // 3. Temporary Rate Limit / Concurrency (429 / RESOURCE_EXHAUSTED)
    if (
      rawMessage.includes('429') ||
      rawMessage.includes('RESOURCE_EXHAUSTED') ||
      rawMessage.includes('Too Many Requests') ||
      rawMessage.includes('Rate limit') ||
      rawMessage.includes('Quota')
    ) {
      const delayMs = this.parseRetryDelayMs(rawMessage, defaultDelay, buffer);
      const delaySec = Math.round(delayMs / 1000);
      return {
        kind: GeminiErrorKind.TEMPORARY_RATE_LIMIT,
        isRetryable: true,
        retryDelayMs: delayMs,
        statusCode: 429,
        internalMessage: rawMessage,
        userFacingMessage: `Translation rate limited. Retrying automatically in ${delaySec}s...`,
      };
    }

    // 4. Model Missing / Unsupported (404)
    if (
      rawMessage.includes('404') ||
      rawMessage.includes('not found') ||
      rawMessage.includes('is not supported for generateContent') ||
      rawMessage.includes('is no longer available')
    ) {
      return {
        kind: GeminiErrorKind.MODEL_UNAVAILABLE,
        isRetryable: false,
        retryDelayMs: 0,
        statusCode: 404,
        internalMessage: rawMessage,
        userFacingMessage:
          'The configured AI translation model is unavailable. Switching to a verified model fallback.',
      };
    }

    // 5. Model Output / JSON parsing issues from LLM output (Retryable)
    if (
      rawMessage.includes('Invalid JSON returned from AI model') ||
      rawMessage.includes('AI response is not a valid JSON') ||
      rawMessage.includes('Missing translated item for question') ||
      rawMessage.includes('malformed output')
    ) {
      return {
        kind: GeminiErrorKind.MODEL_OUTPUT_ERROR,
        isRetryable: true,
        retryDelayMs: defaultDelay,
        internalMessage: rawMessage,
        userFacingMessage:
          'AI translation returned incomplete formatting. Retrying translation automatically...',
      };
    }

    // 6. Invalid / Malformed Request (400 from Google API endpoint)
    if (
      rawMessage.includes('400') ||
      rawMessage.includes('INVALID_ARGUMENT') ||
      rawMessage.includes('Bad Request') ||
      rawMessage.includes('Invalid JSON payload')
    ) {
      return {
        kind: GeminiErrorKind.INVALID_REQUEST,
        isRetryable: false,
        retryDelayMs: 0,
        statusCode: 400,
        internalMessage: rawMessage,
        userFacingMessage:
          'The translation request payload could not be processed by the AI model. Please verify question formats.',
      };
    }

    // 6. Network Glitch / Fetch Failed
    if (
      rawMessage.includes('fetch failed') ||
      rawMessage.includes('ECONNRESET') ||
      rawMessage.includes('ETIMEDOUT') ||
      rawMessage.includes('ENOTFOUND')
    ) {
      return {
        kind: GeminiErrorKind.NETWORK_ERROR,
        isRetryable: true,
        retryDelayMs: defaultDelay + buffer,
        internalMessage: rawMessage,
        userFacingMessage:
          'Network connection to the AI service was briefly interrupted. Retrying automatically...',
      };
    }

    // 7. Server Error (500 / 503 / UNAVAILABLE)
    if (
      rawMessage.includes('500') ||
      rawMessage.includes('503') ||
      rawMessage.includes('Internal Server Error') ||
      rawMessage.includes('Service Unavailable') ||
      rawMessage.includes('UNAVAILABLE')
    ) {
      return {
        kind: GeminiErrorKind.SERVER_ERROR,
        isRetryable: true,
        retryDelayMs: defaultDelay * 2 + buffer,
        statusCode: 503,
        internalMessage: rawMessage,
        userFacingMessage:
          'The AI service is temporarily experiencing high load. Retrying automatically...',
      };
    }

    // Default Unknown
    return {
      kind: GeminiErrorKind.UNKNOWN_ERROR,
      isRetryable: false,
      retryDelayMs: 0,
      internalMessage: rawMessage,
      userFacingMessage:
        'An unexpected issue occurred during AI question translation. Please retry or contact support.',
    };
  }

  /**
   * Cleans an error message so sensitive details, stack traces, or internal URLs are not exposed.
   */
  public static sanitize(error: any): string {
    const classified = this.classify(error);
    return classified.userFacingMessage;
  }
}
