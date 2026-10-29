import { useCategories, type Category } from "@/features/home/useCategories";

import { useDraftCategorySlug } from "./requestDraft";
import { stepsFor, type StepId } from "./steps";

/**
 * The flow's category and its steps. `missing`: no request was started (a link straight into the
 * flow) or its category is no longer offered. Started from home, the categories are cached already.
 */
export type RequestFlowState =
  | { status: "ready"; category: Category; steps: readonly StepId[] }
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | { status: "missing" };

export function useRequestFlow(): RequestFlowState {
  const slug = useDraftCategorySlug();
  const categories = useCategories();
  if (slug === null) return { status: "missing" };
  if (categories.data) {
    const category = categories.data.find((candidate) => candidate.slug === slug);
    return category
      ? { status: "ready", category, steps: stepsFor(category) }
      : { status: "missing" };
  }
  if (categories.isError) return { status: "failed", retry: () => void categories.refetch() };
  return { status: "loading" };
}
