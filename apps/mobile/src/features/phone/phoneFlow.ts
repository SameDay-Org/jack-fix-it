import { router } from "expo-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type PhoneFlowState = {
  /**
   * The national digits a code was just sent to, for the code step. Held here, not in the route,
   * so the number never travels in a URL (or anything that records one).
   */
  pendingNumber: string | null;
  /** A sign-up is in flight or just succeeded: the gate lands on the phone step, once. */
  offeredAfterSignUp: boolean;
};

export const phoneFlowStore = createStore<PhoneFlowState>()(() => ({
  pendingNumber: null,
  offeredAfterSignUp: false,
}));

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
 * The flow is over (verified or skipped): go home, popping the phone steps (home is always under
 * them: it is the signed-in group's anchor).
 */
export function leavePhoneFlow(): void {
  withdrawPhoneStepOffer();
  router.dismissTo("/");
}

/**
 * Set before the sign-up request: the session turns signed-in inside it, and the gate reads this
 * flag on that same render to land on the phone step instead of home.
 */
export const offerPhoneStepAfterSignUp = (): void =>
  phoneFlowStore.setState({ offeredAfterSignUp: true });

/** The sign-up failed, or the phone step was shown: later sign-ins land on home. */
export const withdrawPhoneStepOffer = (): void =>
  phoneFlowStore.setState({ offeredAfterSignUp: false });

export const usePendingNumber = (): string | null =>
  useStore(phoneFlowStore, (state) => state.pendingNumber);

export const usePhoneStepOffered = (): boolean =>
  useStore(phoneFlowStore, (state) => state.offeredAfterSignUp);
