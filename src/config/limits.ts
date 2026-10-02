/**
 * Absolute caps. These mirror the CHECK constraints in sql/001_init.sql.
 * Environment/settings may LOWER the limits but can never raise them above these.
 */
export const HARD_LIMITS = {
  postsPerDay: 6,
  repliesPerDay: 10,
  totalPerDay: 16,
} as const;
