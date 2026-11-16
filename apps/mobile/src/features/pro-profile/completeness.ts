import type { ProProfile } from "./api";

/** The parts of a profile the pro fills in, in the order the checklist shows them. */
export const PROFILE_STEPS = ["photo", "about", "categories", "areas"] as const;
export type ProfileStep = (typeof PROFILE_STEPS)[number];

const DONE: Record<ProfileStep, (profile: ProProfile) => boolean> = {
  photo: (profile) => profile.photo !== null,
  // "About you" is the bio and the years of experience; zero years is an answer.
  about: (profile) => Boolean(profile.bio?.trim()) && profile.years_of_experience !== null,
  categories: (profile) => profile.categories.length > 0,
  areas: (profile) => profile.service_areas.length > 0,
};

export type ProfileChecklist = {
  steps: readonly { step: ProfileStep; done: boolean }[];
  /** How many steps are done. */
  done: number;
  /** Every step is done: the checklist has nothing left to ask. */
  complete: boolean;
};

/** What the profile already has and what is still missing. */
export function profileChecklist(profile: ProProfile): ProfileChecklist {
  const steps = PROFILE_STEPS.map((step) => ({ step, done: DONE[step](profile) }));
  const done = steps.filter((entry) => entry.done).length;
  return { steps, done, complete: done === steps.length };
}
