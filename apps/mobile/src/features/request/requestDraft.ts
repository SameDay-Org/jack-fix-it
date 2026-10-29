import { router, type Href } from "expo-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { onSignOut } from "@/api";

import { flowRisen, setFlowRisen } from "./rise";
import type { StepId } from "./steps";

/** An answer to one intake question, as its type says: a whole number, an option, options, yes/no or text. */
export type IntakeAnswer = number | string | boolean | readonly string[];

/** A US service address as the customer types it in the Where step. */
export type AddressFields = {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zipCode: string;
};

/**
 * Which address the request goes to: a saved one, or the one typed in the form. `null` until the
 * customer picks, which means the default saved address (or the form when there is none).
 */
export type AddressChoice = { kind: "saved"; id: string } | { kind: "typed" } | null;

/**
 * Why the server sent the customer back to a step after a send. The step shows it until the
 * customer changes something there.
 */
export type RefusalReason =
  "invalidAddress" | "invalidAnswers" | "invalidMedia" | "staleDate" | "zipNotServed";
export type StepRefusal = { step: StepId; reason: RefusalReason };

export type RequestDraft = {
  /** The category picked on home; every request starts from one (#232). */
  categorySlug: string | null;
  /** Answers by question key; a key is absent until the customer answers. */
  answers: Readonly<Record<string, IntakeAnswer>>;
  description: string;
  address: AddressChoice;
  typedAddress: AddressFields;
  /** A day as YYYY-MM-DD, or null for "I'm flexible". */
  preferredDate: string | null;
  refusal: StepRefusal | null;
};

export const EMPTY_ADDRESS: AddressFields = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  zipCode: "",
};

const EMPTY_DRAFT: RequestDraft = {
  categorySlug: null,
  answers: {},
  description: "",
  address: null,
  typedAddress: EMPTY_ADDRESS,
  preferredDate: null,
  refusal: null,
};

/**
 * The request being written, kept in memory for the flow's life: it survives Back between the
 * steps and the app going to the background, and goes when the flow does (sent, discarded, or a
 * sign-out). Media is not here: the flow's upload list holds it (see `RequestFlowLayout`).
 */
export const requestDraftStore = createStore<RequestDraft>()(() => EMPTY_DRAFT);

const FIRST_STEP = "/request/new" satisfies Href;

/**
 * Starts a new request from the category picked on home (every request starts from one, #232).
 * Replaces whatever an earlier start left, and opens the request's first step: a push, or with
 * `rise`, Home's panel rising into it (which says whether it started). The choice travels in this
 * store, never in the route.
 */
export function startRequest(categorySlug: string, rise?: (href: Href) => boolean): void {
  const before = { draft: requestDraftStore.getState(), risen: flowRisen() };
  requestDraftStore.setState({ ...EMPTY_DRAFT, categorySlug });
  setFlowRisen(rise !== undefined);
  if (!rise) {
    router.push(FIRST_STEP);
    return;
  }
  // Not started (the panel is already rising into another start): that start keeps its draft.
  if (rise(FIRST_STEP)) return;
  requestDraftStore.setState(before.draft);
  setFlowRisen(before.risen);
}

/**
 * Forgets a start whose flow never mounted (Home's panel lowered after a push that went nowhere).
 * A flow that did mount has forgotten it already, on its way out.
 */
export function forgetUnopenedRequest(): void {
  if (flowRisen()) resetDraft();
}

/** Forgets the draft: the flow was sent, discarded or left, or the account signed out. */
export function resetDraft(): void {
  requestDraftStore.setState(EMPTY_DRAFT);
  setFlowRisen(false);
}

// The address and the answers are the account's: they never outlive its session, even when no
// flow is on screen to forget them.
onSignOut(resetDraft);

/** A change on `step` answers the server's objection there. */
const clearRefusalOn = (draft: RequestDraft, step: StepId): Pick<RequestDraft, "refusal"> => ({
  refusal: draft.refusal?.step === step ? null : draft.refusal,
});

/** Sets one answer, or clears it with `undefined`. */
export function setAnswer(key: string, answer: IntakeAnswer | undefined): void {
  requestDraftStore.setState((draft) => {
    const answers = { ...draft.answers };
    if (answer === undefined) delete answers[key];
    else answers[key] = answer;
    return { answers, ...clearRefusalOn(draft, "questions") };
  });
}

export function setDescription(description: string): void {
  requestDraftStore.setState((draft) => ({ description, ...clearRefusalOn(draft, "describe") }));
}

export function chooseAddress(address: Exclude<AddressChoice, null>): void {
  requestDraftStore.setState((draft) => ({ address, ...clearRefusalOn(draft, "where") }));
}

/** Typing in the form picks it: saved addresses arriving later never take its place. */
export function setTypedAddress(field: keyof AddressFields, value: string): void {
  requestDraftStore.setState((draft) => ({
    typedAddress: { ...draft.typedAddress, [field]: value },
    address: { kind: "typed" },
    ...clearRefusalOn(draft, "where"),
  }));
}

export function setPreferredDate(preferredDate: string | null): void {
  requestDraftStore.setState((draft) => ({ preferredDate, ...clearRefusalOn(draft, "when") }));
}

/** The server refused the request because of `step`: the flow goes back there and says why. */
export function refuseStep(refusal: StepRefusal): void {
  // A fresh object each time: the step keys its scroll and announcement on it, so a second refusal
  // for the same reason (the same constant) still counts as a new one.
  requestDraftStore.setState({ refusal: { ...refusal } });
}

/** The customer dealt with the server's objection on `step`. */
export function clearRefusal(step: StepId): void {
  requestDraftStore.setState((draft) => clearRefusalOn(draft, step));
}

/** Whether leaving would lose something the customer entered (the flow counts media itself). */
export function hasDraftInput(draft: RequestDraft): boolean {
  const typed = Object.values(draft.typedAddress).some((value) => value.trim() !== "");
  return (
    Object.keys(draft.answers).length > 0 ||
    draft.description.trim() !== "" ||
    draft.address !== null ||
    typed ||
    draft.preferredDate !== null
  );
}

export function useRequestDraft<T>(select: (draft: RequestDraft) => T): T {
  return useStore(requestDraftStore, select);
}

export const useDraftCategorySlug = (): string | null =>
  useRequestDraft((draft) => draft.categorySlug);
