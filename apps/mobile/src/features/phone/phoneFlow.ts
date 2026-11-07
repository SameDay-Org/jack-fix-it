import { router } from "expo-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { onSignOut } from "@/api";

type PhoneFlowState = {
  /**
   * The national digits a code was just sent to, for the code step. Held here, not in the route,
   * so the number never travels in a URL (or anything that records one).
   */
  pendingNumber: string | null;
  /**
   * The session generation the code was sent in. The code step checks and resends only in that
   * session: another account signing in while the step is open never verifies this number
   * (#295 Vault B2).
   */
  pendingGeneration: number | null;
};

export const phoneFlowStore = createStore<PhoneFlowState>()(() => ({
  pendingNumber: null,
  pendingGeneration: null,
}));

/** A code went out to these digits in the session of `generation`: the code step verifies them. */
export const startCodeStep = (digits: string, generation: number): void =>
  phoneFlowStore.setState({ pendingNumber: digits, pendingGeneration: generation });

/**
 * The code step is gone (verified, or left for the phone step): forget the number. Called when
 * that screen unmounts, never before it is off screen: with no number it redirects to the phone
 * step, which must not race the navigation that removes it.
 */
export const forgetPendingNumber = (): void =>
  phoneFlowStore.setState({ pendingNumber: null, pendingGeneration: null });

// The number belongs to the session it was sent in: a sign-out, an expired session or another
// account signing in forgets it at once.
onSignOut(forgetPendingNumber);

/**
 * The number is verified: go home, popping the phone steps (home is always under them: it is the
 * signed-in group's anchor).
 */
export function leavePhoneFlow(): void {
  router.dismissTo("/");
}

export const usePendingNumber = (): string | null =>
  useStore(phoneFlowStore, (state) => state.pendingNumber);

/** The session generation the pending number's code was sent in; null with no number. */
export const usePendingGeneration = (): number | null =>
  useStore(phoneFlowStore, (state) => state.pendingGeneration);
