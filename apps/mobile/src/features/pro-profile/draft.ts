import type { ProProfile, ProProfileUpdate, ServiceRegion } from "./api";
import { YEARS_MAX } from "./config";

/** The profile as the form edits it. The photo travels apart: it is an upload, not a field. */
export type ProfileDraft = {
  bio: string;
  /** As typed: digits, or empty for "not said". */
  years: string;
  categoryIds: readonly string[];
  areaIds: readonly string[];
};

export type DraftErrors = { years?: "invalid"; areas?: "required" };

/** Every ZIP code's id among the regions, in the API's order. */
export const areaIdsOf = (regions: readonly ServiceRegion[]): string[] =>
  regions.flatMap((region) => region.cities.flatMap((city) => city.zips.map((zip) => zip.id)));

/**
 * The form's starting point. Only what is still offered is selected: a category or a ZIP code
 * that staff retired cannot be sent again (the API refuses an inactive id), so it leaves the
 * profile with the next change to its set and stays until then.
 */
export function draftOf(
  profile: ProProfile,
  offered: { categoryIds: readonly string[]; areaIds: readonly string[] },
): ProfileDraft {
  const categories = new Set(offered.categoryIds);
  const areas = new Set(offered.areaIds);
  return {
    bio: profile.bio ?? "",
    years: profile.years_of_experience === null ? "" : String(profile.years_of_experience),
    categoryIds: profile.categories.map(({ id }) => id).filter((id) => categories.has(id)),
    areaIds: profile.service_areas.map(({ id }) => id).filter((id) => areas.has(id)),
  };
}

/** The typed years as the API takes them: a whole number, or null for an empty field. */
const yearsOf = (years: string): number | null => (years.trim() ? Number(years.trim()) : null);

const validYears = (years: string): boolean => {
  const text = years.trim();
  return text === "" || (/^\d+$/.test(text) && Number(text) <= YEARS_MAX);
};

/** What Save cannot send as it is: years that are not 0 to `YEARS_MAX`, or no ZIP code at all. */
export function draftErrors(draft: ProfileDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!validYears(draft.years)) errors.years = "invalid";
  if (draft.areaIds.length === 0) errors.areas = "required";
  return errors;
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

/**
 * The PATCH body: only the fields that differ from where the form started, the two id lists
 * whole (the API replaces the set), and the photo's key when a new one was uploaded. Empty when
 * nothing changed.
 */
export function profilePatch(
  initial: ProfileDraft,
  draft: ProfileDraft,
  photoKey: string | null,
): ProProfileUpdate {
  const patch: ProProfileUpdate = {};
  const bio = draft.bio.trim();
  if (bio !== initial.bio.trim()) patch.bio = bio || null;
  const years = yearsOf(draft.years);
  if (years !== yearsOf(initial.years)) patch.years_of_experience = years;
  if (photoKey !== null) patch.photo_key = photoKey;
  if (!sameSet(draft.categoryIds, initial.categoryIds)) patch.category_ids = [...draft.categoryIds];
  if (!sameSet(draft.areaIds, initial.areaIds)) patch.service_area_ids = [...draft.areaIds];
  return patch;
}

/** `ids` with `id` switched: out when it is in, in (at the end) when it is not. */
export const toggled = (ids: readonly string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];

/**
 * `ids` with a whole city switched: without its ZIP codes when every one is in, with all of them
 * otherwise.
 */
export function cityToggled(ids: readonly string[], cityIds: readonly string[]): string[] {
  const rest = ids.filter((id) => !cityIds.includes(id));
  const all = cityIds.every((id) => ids.includes(id));
  return all ? rest : [...rest, ...cityIds];
}
