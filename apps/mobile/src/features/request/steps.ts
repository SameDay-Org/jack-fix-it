import type { Href } from "expo-router";

import type { Category } from "@/features/home/useCategories";

/** The request flow's steps, in order. */
export type StepId = "questions" | "describe" | "where" | "review";

// The flow's first screen is always `/request/new` (where home's category card lands); the
// questions are first unless the category asks none.
const ROUTES = {
  questions: "/request/new",
  describe: "/request/describe",
  where: "/request/where",
  review: "/request/review",
} as const satisfies Record<StepId, Href>;

/** The steps a request in `category` goes through: the questions only when it has some. */
export function stepsFor(category: Pick<Category, "intake_questions">): readonly StepId[] {
  const rest: StepId[] = ["describe", "where", "review"];
  return category.intake_questions.length > 0 ? ["questions", ...rest] : rest;
}

/** Where a step lives: the first one at `/request/new`, the others at their own route. */
export function stepHref(step: StepId, steps: readonly StepId[]): Href {
  return steps[0] === step ? ROUTES.questions : ROUTES[step];
}

/** The step after `step`, or null after the last one. */
export function nextStep(step: StepId, steps: readonly StepId[]): StepId | null {
  return steps[steps.indexOf(step) + 1] ?? null;
}
