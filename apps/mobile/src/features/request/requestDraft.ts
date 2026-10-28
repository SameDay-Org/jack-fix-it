import { router } from "expo-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type RequestDraftState = {
  /** The category the customer picked on home, or null when they started from "Tell Jack". */
  categorySlug: string | null;
};

export const requestDraftStore = createStore<RequestDraftState>()(() => ({
  categorySlug: null,
}));

/**
 * Starts a new request: with a category picked on home, or none (the customer describes the
 * problem first). Replaces whatever an earlier start left, and opens the request's first step.
 * The choice travels in this store, never in the route.
 */
export function startRequest(categorySlug: string | null): void {
  requestDraftStore.setState({ categorySlug });
  router.push("/request/new");
}

export const useDraftCategorySlug = (): string | null =>
  useStore(requestDraftStore, (state) => state.categorySlug);
