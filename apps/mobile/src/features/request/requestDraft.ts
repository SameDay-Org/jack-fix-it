import { router } from "expo-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type RequestDraftState = {
  /** The category picked on home for the request being started; null until the first start. */
  categorySlug: string | null;
};

export const requestDraftStore = createStore<RequestDraftState>()(() => ({
  categorySlug: null,
}));

/**
 * Starts a new request from the category picked on home (every request starts from one, #232).
 * Replaces whatever an earlier start left, and opens the request's first step. The choice
 * travels in this store, never in the route.
 */
export function startRequest(categorySlug: string): void {
  requestDraftStore.setState({ categorySlug });
  router.push("/request/new");
}

export const useDraftCategorySlug = (): string | null =>
  useStore(requestDraftStore, (state) => state.categorySlug);
