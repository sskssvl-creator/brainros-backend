export const FEATURE_KEYS = {
  GOOGLE_LOGIN: 'GOOGLE_LOGIN',
  PUBLIC_REGISTRATION: 'PUBLIC_REGISTRATION',
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

export const FEATURE_ENV_MAP: Record<FeatureKey, string> = {
  [FEATURE_KEYS.GOOGLE_LOGIN]: 'FEATURE_GOOGLE_LOGIN',
  [FEATURE_KEYS.PUBLIC_REGISTRATION]: 'FEATURE_PUBLIC_REGISTRATION',
};

/**
 * Feature dependency graph
 */
export const FEATURE_DEPENDENCIES: Partial<Record<FeatureKey, FeatureKey[]>> = {};

/**
 * Safe boolean parser for environment variables.
 * Treats 'false', '0', 'no', 'off' as false.
 * Treats 'true', '1', 'yes', 'on' as true.
 * Missing / undefined values default to defaultValue (true).
 */
export function parseBooleanFlag(val?: string | boolean | null, defaultValue = true): boolean {
  if (typeof val === 'boolean') return val;
  if (val === undefined || val === null || val === '') return defaultValue;
  const normalized = String(val).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  return defaultValue;
}
