import {
  GeminiErrorClassifier,
  GeminiErrorKind,
} from '../services/gemini-error-classifier';

describe('GeminiErrorClassifier', () => {
  describe('classify', () => {
    it('should classify standard HTTP 429 with retryDelay string', () => {
      const error = new Error(
        '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent: [429 Too Many Requests] {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"56s"}',
      );

      const classified = GeminiErrorClassifier.classify(error, { retryBufferMs: 0 });
      expect(classified.kind).toBe(GeminiErrorKind.TEMPORARY_RATE_LIMIT);
      expect(classified.isRetryable).toBe(true);
      expect(classified.retryDelayMs).toBe(56000);
      expect(classified.userFacingMessage).toContain('Translation rate limited');
    });

    it('should classify sub-second or decimal retryDelay', () => {
      const error = new Error(
        '[429 Too Many Requests] Resource has been exhausted. Please retry in 4.35s.',
      );

      const classified = GeminiErrorClassifier.classify(error, { retryBufferMs: 0 });
      expect(classified.kind).toBe(GeminiErrorKind.TEMPORARY_RATE_LIMIT);
      expect(classified.isRetryable).toBe(true);
      expect(classified.retryDelayMs).toBe(4350);
    });

    it('should classify daily/free-tier quota exhaustion as non-immediately-retryable', () => {
      const error = new Error(
        'Quota exceeded for quota metric "generate_content_free_tier_requests" and limit "20" of service "generativelanguage.googleapis.com"',
      );

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.DAILY_QUOTA_EXHAUSTED);
      expect(classified.isRetryable).toBe(false);
      expect(classified.userFacingMessage).toContain('daily quota has been reached');
    });

    it('should classify 401 Unauthorized / ACCESS_TOKEN_TYPE_UNSUPPORTED as non-retryable invalid credentials', () => {
      const error = new Error(
        '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: [401 Unauthorized] Request had invalid authentication credentials. [{"reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED"}]',
      );

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.AUTHENTICATION_ERROR);
      expect(classified.isRetryable).toBe(false);
      expect(classified.userFacingMessage).toContain('authentication failed');
    });

    it('should classify 400 Bad Request / Invalid Argument as non-retryable', () => {
      const error = new Error(
        '[400 Bad Request] Invalid JSON payload received. Unknown name "badField"',
      );

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.INVALID_REQUEST);
      expect(classified.isRetryable).toBe(false);
      expect(classified.userFacingMessage).toContain('could not be processed');
    });

    it('should classify model JSON output parsing failures as retryable MODEL_OUTPUT_ERROR', () => {
      const error = new Error(
        'Invalid JSON returned from AI model: Expected double-quoted property name in JSON at position 247',
      );

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.MODEL_OUTPUT_ERROR);
      expect(classified.isRetryable).toBe(true);
      expect(classified.userFacingMessage).toContain('Retrying translation automatically');
    });

    it('should classify 404 Model Not Found as non-retryable', () => {
      const error = new Error(
        '[404 Not Found] models/unknown-model is not found for API version v1beta',
      );

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.MODEL_UNAVAILABLE);
      expect(classified.isRetryable).toBe(false);
      expect(classified.userFacingMessage).toContain('model is unavailable');
    });

    it('should classify 503 Service Unavailable / 500 as retryable SERVER_ERROR', () => {
      const error = new Error(
        '[503 Service Unavailable] The model is overloaded. Please try again later.',
      );

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.SERVER_ERROR);
      expect(classified.isRetryable).toBe(true);
      expect(classified.userFacingMessage).toContain('temporarily experiencing high load');
    });

    it('should classify network timeout as retryable NETWORK_ERROR', () => {
      const error = new Error('request timed out after 30000ms: ETIMEDOUT');

      const classified = GeminiErrorClassifier.classify(error);
      expect(classified.kind).toBe(GeminiErrorKind.NETWORK_ERROR);
      expect(classified.isRetryable).toBe(true);
      expect(classified.userFacingMessage).toContain('Network connection to the AI service');
    });
  });

  describe('sanitize', () => {
    it('should strip URLs, API keys, and stack internals into a clean user facing string', () => {
      const raw =
        '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyD_SECRET123: [429 Too Many Requests]';

      const sanitized = GeminiErrorClassifier.sanitize(raw);
      expect(sanitized).not.toContain('https://');
      expect(sanitized).not.toContain('generativelanguage.googleapis.com');
      expect(sanitized).not.toContain('AIzaSyD_SECRET123');
      expect(sanitized).toContain('Translation rate limited');
    });
  });
});
