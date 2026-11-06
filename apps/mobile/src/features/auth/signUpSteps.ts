import type { SessionUser } from "@/api";
import {
  ADDRESS_MAX,
  addressErrors,
  isUsStateCode,
  type AddressErrors,
  type AddressFields,
} from "@/features/addresses/addressFields";

import { isSignUpRole, type SignUpRole } from "./roles";

/**
 * The sign-up flow's steps, in order (#250 §1): the account, the name, where the person lives.
 * The selfie (#294) and the phone (#295) plug in here, each with a `done` test on the account.
 */
export const SIGN_UP_STEPS = ["account", "name", "home"] as const;

export type SignUpStep = (typeof SIGN_UP_STEPS)[number];

/** Whether the account already holds a step's answer: the flow resumes after the last one held. */
const DONE: Record<Exclude<SignUpStep, "account">, (user: SessionUser) => boolean> = {
  name: (user) => Boolean(user.first_name?.trim() && user.last_name?.trim()),
  home: (user) => Boolean(user.home_city && user.home_state),
};

/** The first step the account has not answered; `null` when every one is answered. */
export function firstUnfinishedStep(user: SessionUser): SignUpStep | null {
  return SIGN_UP_STEPS.find((step) => step !== "account" && !DONE[step](user)) ?? null;
}

/** Where the flow opens: a new account's first step, or the step a relaunch left unfinished. */
export type SignUpEntry = { role: SignUpRole; step: SignUpStep | null };

/**
 * Decided once, as the screen mounts. The account this device is signing up resumes at its first
 * unfinished step (`step: null` when nothing is left, so the flow ends at once). Otherwise a new
 * sign-up starts with the role chosen on the previous screen; `null` without a valid one.
 */
export function signUpEntry(
  roleParam: string | undefined,
  user: SessionUser | null,
  onboardingUserId: string | null,
): SignUpEntry | null {
  if (user && user.id === onboardingUserId) {
    if (!isSignUpRole(user.role)) return null;
    return { role: user.role, step: firstUnfinishedStep(user) };
  }
  if (user || !isSignUpRole(roleParam)) return null;
  return { role: roleParam, step: "account" };
}

/** The most characters a name takes (#165), after trimming and collapsing inner spaces. */
export const NAME_MAX = 60;

export type NameFields = { first: string; last: string };
export type NameError = "required" | "tooLong";
export type NameErrors = Partial<Record<keyof NameFields, NameError>>;

/** A name as the API stores it: trimmed, inner runs of spaces collapsed to one. */
export const tidyName = (name: string): string => name.trim().split(/\s+/).join(" ");

/**
 * What the device can tell about the names: present and short enough. The letters themselves are
 * the server's call (#165: letters, spaces, hyphens, apostrophes and periods, no contacts).
 */
export function nameErrors(fields: NameFields): NameErrors {
  const errors: NameErrors = {};
  for (const key of ["first", "last"] as const) {
    const name = tidyName(fields[key]);
    if (!name) errors[key] = "required";
    else if (name.length > NAME_MAX) errors[key] = "tooLong";
  }
  return errors;
}

/** The most characters the card's city takes (`HOME_CITY_MAX_LENGTH`), after trimming. */
export const HOME_CITY_MAX = 80;

/**
 * The home step's fields that cannot go yet. A customer types a whole address (saved as Home); a
 * pro only the city and state. Either way the city must fit the card and the state be a US state
 * or DC code, which the card's `home_state` requires.
 */
export function homeErrors(fields: AddressFields, role: SignUpRole): AddressErrors {
  const errors: AddressErrors = {};
  if (role === "customer") Object.assign(errors, addressErrors(fields));
  const city = fields.city.trim();
  if (!city) errors.city = "required";
  else if (city.length > Math.min(HOME_CITY_MAX, ADDRESS_MAX.city)) errors.city = "tooLong";
  if (!fields.state.trim()) errors.state = "required";
  else if (!isUsStateCode(fields.state)) errors.state = "state";
  return errors;
}
