import { router } from "expo-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type PhoneFlowState = {
  /**
   * The national digits a code was just sent to, for the code step. Held here, not in the route,
   * so the number never travels in a URL (or anything that records one).
   */
  pendingNumber: string | null;
};

export const phoneFlowStore = createStore<PhoneFlowState>()(() => ({ pendingNumber: null }));

/** A code went out to these digits: the code step verifies them. */
export const startCodeStep = (digits: string): void =>
  phoneFlowStore.setState({ pendingNumber: digits });

/**
 * The code step is gone (verified, or left for the phone step): forget the number. Called when
 * that screen unmounts, never before it is off screen: with no number it redirects to the phone
 * step, which must not race the navigation that removes it.
 */
export const forgetPendingNumber = (): void => phoneFlowStore.setState({ pendingNumber: null });

/**
 * The number is verified: go home, popping the phone steps (home is always under them: it is the
 * signed-in group's anchor).
 */
export function leavePhoneFlow(): void {
  router.dismissTo("/");
}

export const usePendingNumber = (): string | null =>
  useStore(phoneFlowStore, (state) => state.pendingNumber);
