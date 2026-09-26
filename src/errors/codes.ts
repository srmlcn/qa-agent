/**
 * Machine-readable failure codes from spec section 11.
 * Later leaves must not add codes; map a missing case to the closest one.
 */
export const QA_ERROR_CODES = [
  "DISCOVERY_FAILED",
  "FLOW_COMPILE_FAILED",
  "FLOW_VALIDATION_FAILED",
  "LOCATOR_STALE",
  "ASSERTION_FAILED",
  "AUTH_EXPIRED",
  "AUTH_MISSING",
  "NETWORK_FAILURE",
  "PAGE_ERROR",
  "NAVIGATION_FAILED",
  "TIMEOUT",
  "BROWSER_CRASHED",
  "LLM_PROVIDER_UNAVAILABLE",
  "LLM_RATE_LIMITED",
  "POLICY_BLOCKED",
  "RUN_CANCELLED",
] as const;

export type QaErrorCode = (typeof QA_ERROR_CODES)[number];
