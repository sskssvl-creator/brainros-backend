/**
 * Canonical 7 Student Target Exam Constants and Eligibility Resolution Logic.
 *
 * Student Target Exam Choices (Strictly 7 options):
 * 1. JEE
 * 2. CET
 * 3. NEET
 * 4. NEET + JEE
 * 5. NEET + State CET
 * 6. JEE + State CET
 * 7. JEE + NEET + State CET
 *
 * Global Subjects remain strictly:
 * - Physics
 * - Chemistry
 * - Mathematics
 * - Biology
 *
 * Target combinations resolve to actual exam types:
 * - JEE -> ['JEE']
 * - CET -> ['CET']
 * - NEET -> ['NEET']
 * - NEET + JEE -> ['NEET', 'JEE']
 * - NEET + State CET -> ['NEET', 'CET']
 * - JEE + State CET -> ['JEE', 'CET']
 * - JEE + NEET + State CET -> ['JEE', 'NEET', 'CET']
 */

export const CANONICAL_TARGET_EXAMS = [
  'JEE',
  'CET',
  'NEET',
  'NEET + JEE',
  'NEET + State CET',
  'JEE + State CET',
  'JEE + NEET + State CET',
] as const;

export type CanonicalTargetExam = (typeof CANONICAL_TARGET_EXAMS)[number];

export const TARGET_EXAM_RESOLVER_MAP: Record<string, string[]> = {
  JEE: ['JEE'],
  CET: ['CET'],
  NEET: ['NEET'],
  'NEET + JEE': ['NEET', 'JEE'],
  'NEET + State CET': ['NEET', 'CET'],
  'JEE + State CET': ['JEE', 'CET'],
  'JEE + NEET + State CET': ['JEE', 'NEET', 'CET'],
  // Legacy alias compatibility
  'NEET and JEE': ['NEET', 'JEE'],
  'NEET and State CET': ['NEET', 'CET'],
  'JEE and State CET': ['JEE', 'CET'],
  'JEE, NEET and State CET': ['JEE', 'NEET', 'CET'],
};

/**
 * Resolves a student target name into an array of eligible actual exam types (e.g. ['JEE', 'NEET']).
 */
export function resolveEligibleExamTypes(targetName?: string | null): string[] {
  if (!targetName || !targetName.trim()) {
    return [];
  }
  const clean = targetName.trim();
  if (TARGET_EXAM_RESOLVER_MAP[clean]) {
    return TARGET_EXAM_RESOLVER_MAP[clean];
  }

  // Case-insensitive lookup
  const lower = clean.toLowerCase();
  for (const [key, value] of Object.entries(TARGET_EXAM_RESOLVER_MAP)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  // Attempt normalized resolution
  const normalized = normalizeTargetExamInput(clean);
  if (normalized && TARGET_EXAM_RESOLVER_MAP[normalized]) {
    return TARGET_EXAM_RESOLVER_MAP[normalized];
  }

  return [clean];
}

/**
 * Strict validator & normalizer for Target Exam input in bulk uploads, registrations, and forms.
 * Returns the exact CanonicalTargetExam string if valid, or null if invalid.
 *
 * Valid examples:
 * - "JEE" -> "JEE"
 * - "NEET" -> "NEET"
 * - "CET" -> "CET"
 * - "NEET + JEE" -> "NEET + JEE"
 * - "JEE + NEET" -> "NEET + JEE" (normalized)
 * - "NEET + State CET" -> "NEET + State CET"
 * - "State CET + NEET" -> "NEET + State CET" (normalized)
 * - "JEE + State CET" -> "JEE + State CET"
 * - "State CET + JEE" -> "JEE + State CET" (normalized)
 * - "JEE + NEET + State CET" -> "JEE + NEET + State CET"
 * - "NEET + JEE + State CET" -> "JEE + NEET + State CET" (normalized)
 *
 * Invalid examples (returns null):
 * - "JEE + CET" (must be "JEE + State CET")
 * - "State CET" (invalid standalone)
 * - "JEE + State NEET" (invalid)
 * - "Physics" (subject, not target exam)
 * - "" / whitespace / random text
 */
export function normalizeTargetExamInput(rawInput?: string | null): CanonicalTargetExam | null {
  if (!rawInput || typeof rawInput !== 'string') {
    return null;
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Direct match with canonical target options
  const exactMatch = CANONICAL_TARGET_EXAMS.find(
    (target) => target.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exactMatch) {
    return exactMatch;
  }

  // 2. Normalize legacy 'and' forms to canonical '+'
  const lower = trimmed.toLowerCase();
  if (lower === 'neet and jee' || lower === 'jee and neet') {
    return 'NEET + JEE';
  }
  if (lower === 'neet and state cet' || lower === 'state cet and neet') {
    return 'NEET + State CET';
  }
  if (lower === 'jee and state cet' || lower === 'state cet and jee') {
    return 'JEE + State CET';
  }
  if (
    lower === 'jee, neet and state cet' ||
    lower === 'jee, neet and cet' ||
    lower === 'jee and neet and state cet'
  ) {
    return 'JEE + NEET + State CET';
  }

  // 3. Parse segments separated by '+', '&', ',', or '/'
  if (
    trimmed.includes('+') ||
    trimmed.includes('&') ||
    trimmed.includes(',') ||
    trimmed.includes('/')
  ) {
    const rawTokens = trimmed
      .split(/[+&,/]/)
      .map((t) => t.trim())
      .filter(Boolean);

    // If token length is out of range, fail
    if (rawTokens.length < 2 || rawTokens.length > 3) {
      return null;
    }

    let hasJee = false;
    let hasNeet = false;
    let hasStateCet = false;

    for (const token of rawTokens) {
      const tLower = token.toLowerCase();
      if (tLower === 'jee' || tLower === 'jee main' || tLower === 'iit jee' || tLower === 'iit-jee') {
        hasJee = true;
      } else if (tLower === 'neet' || tLower === 'neet ug' || tLower === 'neet-ug') {
        hasNeet = true;
      } else if (
        tLower === 'cet' ||
        tLower === 'state cet' ||
        tLower === 'state-cet' ||
        tLower === 'state_cet' ||
        tLower === 'mht cet' ||
        tLower === 'mht-cet' ||
        tLower === 'kcet' ||
        tLower === 'gujcet'
      ) {
        hasStateCet = true;
      } else {
        return null;
      }
    }

    // Explicit invalid check: "JEE + CET" without "State CET" is rejected in strict legacy normalization
    if (lower === 'jee + cet' || lower === 'cet + jee') {
      return null;
    }

    if (hasJee && hasNeet && hasStateCet) {
      return 'JEE + NEET + State CET';
    }
    if (hasNeet && hasJee && !hasStateCet) {
      return 'NEET + JEE';
    }
    if (hasNeet && hasStateCet && !hasJee) {
      return 'NEET + State CET';
    }
    if (hasJee && hasStateCet && !hasNeet) {
      return 'JEE + State CET';
    }
  }

  return null;
}

/**
 * Maps 3 independent Boolean flags (jee, cet, neet) strictly to one of the 7 canonical target exam strings.
 * Returns null if all 3 flags are false or undefined.
 */
export function mapExamBooleansToCanonical(
  jee: boolean,
  cet: boolean,
  neet: boolean,
): CanonicalTargetExam | null {
  const isJee = Boolean(jee);
  const isCet = Boolean(cet);
  const isNeet = Boolean(neet);

  if (isJee && !isCet && !isNeet) return 'JEE';
  if (!isJee && isCet && !isNeet) return 'CET';
  if (!isJee && !isCet && isNeet) return 'NEET';
  if (isJee && !isCet && isNeet) return 'NEET + JEE';
  if (!isJee && isCet && isNeet) return 'NEET + State CET';
  if (isJee && isCet && !isNeet) return 'JEE + State CET';
  if (isJee && isCet && isNeet) return 'JEE + NEET + State CET';
  return null;
}

/**
 * Maps a canonical target exam or combo string to the 3 separate Boolean flags.
 */
export function mapCanonicalToExamBooleans(
  targetName?: string | null,
): { jee: boolean; cet: boolean; neet: boolean } {
  const eligible = resolveEligibleExamTypes(targetName);
  return {
    jee: eligible.includes('JEE'),
    cet: eligible.includes('CET'),
    neet: eligible.includes('NEET'),
  };
}

/**
 * Safely parses string, number, or boolean spreadsheet cell values to a boolean flag.
 */
export function parseBooleanFlag(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val === 1;
  if (!val) return false;
  const str = String(val).trim().toLowerCase();
  return str === 'true' || str === 'yes' || str === '1' || str === 'y' || str === 't';
}

