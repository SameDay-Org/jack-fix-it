import type { Category } from "@/features/home/useCategories";

import type { ProProfile, ServiceRegion } from "../api";

export {
  navigation,
  newQueryClient,
  renderWithQuery,
  routerMock,
  signedIn,
} from "../../pro-jobs/__tests__/helpers";

/** `@/api` for the profile's suites: the pro-jobs mock (a session with a generation) plus PATCH. */
export function apiMock() {
  const { apiMock: base } = jest.requireActual<typeof import("../../pro-jobs/__tests__/helpers")>(
    "../../pro-jobs/__tests__/helpers",
  );
  return { ...base(), apiPatch: jest.fn() };
}

const category = (n: number, slug: string, en: string): Category => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  slug,
  names: { en, es: en },
  icon: null,
  requires_license: false,
  intake_questions: [],
});

export const PLUMBING = category(1, "plumbing", "Plumbing");
export const ELECTRICAL = category(2, "electrical", "Electrical");
export const PAINTING = category(3, "painting", "Painting");
export const CATEGORIES = [PLUMBING, ELECTRICAL, PAINTING];

const zip = (code: string) => ({ id: `zip-${code}`, zip_code: code });

/** Two cities of one region: Fort Lauderdale with three ZIP codes, Plantation with one. */
export const REGIONS: ServiceRegion[] = [
  {
    region: "South Florida",
    cities: [
      { city: "Fort Lauderdale", state: "FL", zips: [zip("33301"), zip("33304"), zip("33305")] },
      { city: "Plantation", state: "FL", zips: [zip("33324")] },
    ],
  },
];

const area = (code: string, city: string) => ({
  ...zip(code),
  city,
  state: "FL",
  region: "South Florida",
});

/** The profile the API creates on the first read: nothing filled in, pending verification. */
export const EMPTY_PROFILE: ProProfile = {
  bio: null,
  years_of_experience: null,
  photo: null,
  verification_status: "pending",
  rejection_reason: null,
  payouts_enabled: false,
  categories: [],
  service_areas: [],
};

/** A profile with every part filled in. The photo's URL is a placeholder, never a real one. */
export const FULL_PROFILE: ProProfile = {
  ...EMPTY_PROFILE,
  bio: "Licensed plumber.",
  years_of_experience: 12,
  photo: { url: "https://storage.test/photo-1", expires_at: "2999-01-01T00:00:00Z" },
  categories: [{ id: PLUMBING.id, slug: PLUMBING.slug, names: PLUMBING.names }],
  service_areas: [area("33301", "Fort Lauderdale"), area("33324", "Plantation")],
};
