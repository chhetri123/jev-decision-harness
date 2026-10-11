export const FAILURE_CATEGORIES = {
  implementation_bug: "The code under test behaves incorrectly; the test expectation is right.",
  test_bug: "The test itself is wrong: bad expectation, bad fixture, or wrong setup.",
  environment: "Infrastructure problem: service not reachable, port in use, permissions, wrong runtime version.",
  flaky: "Nondeterministic failure: timing, ordering, randomness; likely passes on retry.",
  unrelated_failure: "Failure in code that the current change did not touch and does not depend on.",
  missing_dependency: "A package or module cannot be found or is not installed.",
  type_error: "TypeScript compile/type-check error, not a runtime assertion.",
  regression: "A previously passing test of existing behaviour broke because of the current change.",
} as const;

export type FailureCategory = keyof typeof FAILURE_CATEGORIES;

/**
 * Signatures that are unambiguous from the log text alone. Returns null when no rule fires,
 * which is the only case where a semantic judgment is needed.
 */
export function triageByRules(log: string): FailureCategory | null {
  if (/error TS\d{4}:/.test(log)) return "type_error";
  if (/Cannot find (module|package) ['"][^.'"/][^'"]*['"]|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(log) && !/Cannot find module ['"]\.{1,2}\//.test(log))
    return "missing_dependency";
  if (/ECONNREFUSED|EADDRINUSE|EACCES|ENOTFOUND|getaddrinfo|connect ETIMEDOUT/.test(log)) return "environment";
  return null;
}
