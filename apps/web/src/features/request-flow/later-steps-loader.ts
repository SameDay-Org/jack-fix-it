/** The steps after the description, loaded apart from the page (later-steps.ts). */
export type LaterSteps = typeof import("./later-steps");

/**
 * Asks for the later steps' code. Kept out of request-flow.tsx so a test can make the ask fail
 * or wait, as a slow or dropped connection does.
 */
export function loadLaterSteps(): Promise<LaterSteps> {
  return import("./later-steps");
}
