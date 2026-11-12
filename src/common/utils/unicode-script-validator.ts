/**
 * Unicode Script Validator for Multilingual Academic Question Papers
 * Ensures 100% script integrity and detects cross-script contamination
 * (e.g., Gujarati in Bengali, Tamil suffixes in Telugu, Thai or Greek characters in Indic scripts).
 */

export interface ScriptRange {
  start: number;
  end: number;
  description: string;
}

export interface ScriptViolation {
  char: string;
  codePoint: string;
  index: number;
  detectedScript?: string;
  contextSnippet: string;
}

export interface ScriptValidationResult {
  isValid: boolean;
  languageCode: string;
  violations: ScriptViolation[];
  cleanedText?: string;
  summary?: string;
}

// ── Canonical Indic Unicode Script Blocks ────────────────────────
export const INDIC_SCRIPT_BLOCKS: Record<string, { name: string; ranges: [number, number][] }> = {
  bn: {
    name: 'Bengali',
    ranges: [[0x0980, 0x09ff]], // Bengali & Assamese
  },
  gu: {
    name: 'Gujarati',
    ranges: [[0x0a80, 0x0aff]], // Gujarati
  },
  hi: {
    name: 'Hindi (Devanagari)',
    ranges: [
      [0x0900, 0x097f], // Devanagari
      [0xa8e0, 0xa8ff], // Devanagari Extended
    ],
  },
  mr: {
    name: 'Marathi (Devanagari)',
    ranges: [
      [0x0900, 0x097f], // Devanagari
      [0xa8e0, 0xa8ff], // Devanagari Extended
    ],
  },
  kn: {
    name: 'Kannada',
    ranges: [[0x0c80, 0x0cff]], // Kannada
  },
  ml: {
    name: 'Malayalam',
    ranges: [[0x0d00, 0x0d7f]], // Malayalam
  },
  ta: {
    name: 'Tamil',
    ranges: [[0x0b80, 0x0bff]], // Tamil
  },
  te: {
    name: 'Telugu',
    ranges: [[0x0c00, 0x0c7f]], // Telugu
  },
};

// All known Indic script ranges for detecting foreign Indic contamination
const ALL_INDIC_RANGES: { lang: string; name: string; start: number; end: number }[] = [
  { lang: 'bn', name: 'Bengali', start: 0x0980, end: 0x09ff },
  { lang: 'gu', name: 'Gujarati', start: 0x0a80, end: 0x0aff },
  { lang: 'hi/mr', name: 'Devanagari', start: 0x0900, end: 0x097f },
  { lang: 'ta', name: 'Tamil', start: 0x0b80, end: 0x0bff },
  { lang: 'te', name: 'Telugu', start: 0x0c00, end: 0x0c7f },
  { lang: 'kn', name: 'Kannada', start: 0x0c80, end: 0x0cff },
  { lang: 'ml', name: 'Malayalam', start: 0x0d00, end: 0x0d7f },
  { lang: 'or', name: 'Odia', start: 0x0b00, end: 0x0b7f },
  { lang: 'pa', name: 'Gurmukhi', start: 0x0a00, end: 0x0a7f },
];

// Foreign non-Indic scripts that must NEVER appear in Indian regional exam questions
const FORBIDDEN_FOREIGN_RANGES = [
  { name: 'Greek', start: 0x0370, end: 0x03ff },
  { name: 'Greek Extended', start: 0x1f00, end: 0x1fff },
  { name: 'Thai', start: 0x0e00, end: 0x0e7f },
  { name: 'Cyrillic', start: 0x0400, end: 0x04ff },
  { name: 'Arabic', start: 0x0600, end: 0x06ff },
  { name: 'Hebrew', start: 0x0590, end: 0x05ff },
];

/**
 * Checks whether a single code point is permitted for a target language:
 * 1. Belongs to the target language's native script block(s).
 * 2. OR belongs to the universally allowed shared ranges (ASCII, Latin scientific, Math, Punctuation).
 */
export function isAllowedChar(codePoint: number, targetLangCode: string): { allowed: boolean; reason?: string } {
  const normLang = (targetLangCode || '').toLowerCase().trim();

  // If target language is English, allow standard Latin and math
  if (normLang === 'en') {
    if (codePoint >= 0x0000 && codePoint <= 0x007f) return { allowed: true };
    if (codePoint >= 0x00a0 && codePoint <= 0x00ff) return { allowed: true };
    if (codePoint >= 0x2000 && codePoint <= 0x22ff) return { allowed: true };
    return { allowed: false, reason: 'Non-Latin character in English paper' };
  }

  // 1. Check if char belongs to the target language's native script
  const targetScript = INDIC_SCRIPT_BLOCKS[normLang];
  if (targetScript) {
    for (const [start, end] of targetScript.ranges) {
      if (codePoint >= start && codePoint <= end) {
        return { allowed: true };
      }
    }
  }

  // 2. Allow Universal Shared Characters:
  // ASCII Printable: Space, Digits, Punctuation, Math, Latin Letters (for scientific terms like CO2, ATP, kg, m/s)
  if (codePoint >= 0x0020 && codePoint <= 0x007e) {
    return { allowed: true };
  }

  // Whitespace and standard control characters (tab, newline, carriage return)
  if (codePoint === 0x0009 || codePoint === 0x000a || codePoint === 0x000d) {
    return { allowed: true };
  }

  // Latin-1 Supplement Punctuation & Math: °, ±, ², ³, ×, ÷, µ (micro), etc.
  if (
    codePoint === 0x00b0 || // degree °
    codePoint === 0x00b1 || // plus-minus ±
    codePoint === 0x00b2 || // superscript 2 ²
    codePoint === 0x00b3 || // superscript 3 ³
    codePoint === 0x00b5 || // micro µ
    codePoint === 0x00d7 || // multiplication ×
    codePoint === 0x00f7 || // division ÷
    codePoint === 0x00bf || // inverted question mark
    codePoint === 0x00a7    // section sign
  ) {
    return { allowed: true };
  }

  // General Punctuation: curly quotes, en-dash, em-dash, bullet, ellipsis, zero-width joiners
  if (
    (codePoint >= 0x2010 && codePoint <= 0x2027) || // quotes, dashes, bullets
    codePoint === 0x200c || // Zero Width Non-Joiner (ZWNJ - vital for Indic scripts)
    codePoint === 0x200d || // Zero Width Joiner (ZWJ - vital for Indic scripts)
    codePoint === 0x20a8 || // Rupee symbol ₨
    codePoint === 0x20b9    // Indian Rupee sign ₹
  ) {
    return { allowed: true };
  }

  // Superscripts and Subscripts (used in chemical formulas like H₂O, ions like Ca²⁺)
  if (codePoint >= 0x2070 && codePoint <= 0x209f) {
    return { allowed: true };
  }

  // Mathematical Operators & Arrows: √, ∑, ∫, ≈, ≠, ≤, ≥, →, ↔, ∞
  if (
    (codePoint >= 0x2190 && codePoint <= 0x21ff) || // Arrows
    (codePoint >= 0x2200 && codePoint <= 0x22ff)    // Mathematical Operators
  ) {
    return { allowed: true };
  }

  // Common Indic Punctuation: Danda (।) and Double Danda (॥) used in Bengali, Hindi, etc.
  if (codePoint === 0x0964 || codePoint === 0x0965) {
    return { allowed: true };
  }

  // 3. Otherwise, check specifically what forbidden script this character belongs to
  for (const indic of ALL_INDIC_RANGES) {
    if (codePoint >= indic.start && codePoint <= indic.end) {
      if (
        (normLang === 'hi' || normLang === 'mr') &&
        (indic.lang === 'hi/mr')
      ) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Cross-Script Contamination: Found ${indic.name} script character in ${targetScript?.name || normLang} text`,
      };
    }
  }

  for (const foreign of FORBIDDEN_FOREIGN_RANGES) {
    if (codePoint >= foreign.start && codePoint <= foreign.end) {
      return {
        allowed: false,
        reason: `Forbidden Foreign Script: Found ${foreign.name} character in ${targetScript?.name || normLang} text`,
      };
    }
  }

  // Unrecognized foreign or unallocated character
  return {
    allowed: false,
    reason: `Disallowed character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
  };
}

/**
 * Validates a block of text against a target language code.
 * Returns detailed violation reports if any cross-script or forbidden characters are found.
 */
export function validateTextScript(text: string, languageCode: string): ScriptValidationResult {
  if (!text || typeof text !== 'string') {
    return { isValid: true, languageCode, violations: [] };
  }

  const violations: ScriptViolation[] = [];
  const chars = Array.from(text);

  for (let idx = 0; idx < chars.length; idx++) {
    const char = chars[idx];
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;

    const check = isAllowedChar(codePoint, languageCode);
    if (!check.allowed) {
      const start = Math.max(0, idx - 15);
      const end = Math.min(chars.length, idx + 16);
      const contextSnippet = chars.slice(start, end).join('');

      violations.push({
        char,
        codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
        index: idx,
        detectedScript: check.reason,
        contextSnippet,
      });
    }
  }

  const isValid = violations.length === 0;
  const summary = isValid
    ? `Text is 100% pure ${languageCode} script.`
    : `Found ${violations.length} script violation(s) in ${languageCode}: ${violations.slice(0, 3).map((v) => `${v.char} (${v.codePoint}: ${v.detectedScript}) in "${v.contextSnippet}"`).join('; ')}`;

  return {
    isValid,
    languageCode,
    violations,
    summary,
  };
}

/**
 * Strips isolated cross-script contamination from text when possible,
 * or returns null if text is completely in the wrong script.
 */
export function sanitizeTextScript(text: string, languageCode: string): { cleaned: string; wasSanitized: boolean } {
  if (!text) return { cleaned: text, wasSanitized: false };
  const chars = Array.from(text);
  const filtered: string[] = [];
  let wasSanitized = false;

  for (const char of chars) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    const check = isAllowedChar(codePoint, languageCode);
    if (check.allowed) {
      filtered.push(char);
    } else {
      wasSanitized = true;
    }
  }

  return { cleaned: filtered.join(''), wasSanitized };
}
