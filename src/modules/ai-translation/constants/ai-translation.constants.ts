// ═══════════════════════════════════════════════════════════════════
// AI Translation Constants
// ═══════════════════════════════════════════════════════════════════

export const AI_TRANSLATION_QUEUE = 'ai-translation';
export const AI_TRANSLATION_LANGUAGE_QUEUE = 'ai-translation-language';

export const AI_TRANSLATION_DEFAULTS = {
  BATCH_SIZE: 20,
  CONCURRENCY: 1,
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 5000,
  RETRY_BACKOFF_MULTIPLIER: 2,
  RATE_LIMIT_ENABLED: true,
  REQUESTS_PER_INTERVAL: 10,
  INTERVAL_MS: 60000,
  MIN_REQUEST_INTERVAL_MS: 2000,
  RETRY_BUFFER_MS: 3000,
  DEFAULT_MODEL: 'gemini-3.5-flash-lite',
  VERIFIED_MODELS: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'],
};

export const AI_TRANSLATION_REQUIRED_HEADERS = [
  'question_number',
  'question',
  'option_a',
  'option_b',
  'option_c',
  'option_d',
] as const;

export const AI_TRANSLATION_SUPPORTED_FILE_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const AI_TRANSLATION_SUPPORTED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];

export const SAMPLE_CSV_CONTENT = `question_number,question,option_a,option_b,option_c,option_d
1,"What is 2 + 2?","2","3","4","5"
2,"Capital of India?","Mumbai","Delhi","Chennai","Kolkata"
3,"Which planet is closest to the Sun?","Venus","Mercury","Earth","Mars"`;
