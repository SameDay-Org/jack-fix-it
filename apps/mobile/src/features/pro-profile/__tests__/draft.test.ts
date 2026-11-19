import { ApiError, NetworkError } from "@/api";

import { profileFailure } from "../api";
import { profileChecklist } from "../completeness";
import { readProProfileConfig } from "../config";
import {
  areaIdsOf,
  cityToggled,
  draftErrors,
  draftOf,
  profilePatch,
  toggled,
  type ProfileDraft,
} from "../draft";
import { CATEGORIES, ELECTRICAL, EMPTY_PROFILE, FULL_PROFILE, PLUMBING, REGIONS } from "./helpers";

jest.mock("@/api", () => jest.requireActual("../../../api/errors"));

const OFFERED = { categoryIds: CATEGORIES.map(({ id }) => id), areaIds: areaIdsOf(REGIONS) };
const START: ProfileDraft = draftOf(FULL_PROFILE, OFFERED);

describe("draftOf", () => {
  it("starts from the profile, an unset field as an empty one", () => {
    expect(START).toEqual({
      bio: "Licensed plumber.",
      years: "12",
      categoryIds: [PLUMBING.id],
      areaIds: ["zip-33301", "zip-33324"],
    });
    expect(draftOf(EMPTY_PROFILE, OFFERED)).toEqual({
      bio: "",
      years: "",
      categoryIds: [],
      areaIds: [],
    });
  });

  it("selects only what is still offered", () => {
    const offered = { categoryIds: [ELECTRICAL.id], areaIds: ["zip-33324"] };
    expect(draftOf(FULL_PROFILE, offered)).toMatchObject({
      categoryIds: [],
      areaIds: ["zip-33324"],
    });
  });
});

describe("profilePatch", () => {
  it("is empty when nothing changed, whatever the order or the spaces around the bio", () => {
    const same = { ...START, bio: " Licensed plumber. ", areaIds: ["zip-33324", "zip-33301"] };
    expect(profilePatch(START, same, null)).toEqual({});
  });

  it("sends only the field that changed", () => {
    expect(profilePatch(START, { ...START, bio: "Plumber since 2014." }, null)).toEqual({
      bio: "Plumber since 2014.",
    });
    expect(profilePatch(START, { ...START, years: "13" }, null)).toEqual({
      years_of_experience: 13,
    });
  });

  it("clears a field emptied in the form with null, and takes zero years as an answer", () => {
    expect(profilePatch(START, { ...START, bio: "  ", years: "" }, null)).toEqual({
      bio: null,
      years_of_experience: null,
    });
    const blank = draftOf(EMPTY_PROFILE, OFFERED);
    expect(profilePatch(blank, { ...blank, years: "0" }, null)).toEqual({
      years_of_experience: 0,
    });
  });

  it("sends a changed set whole, since the API replaces it", () => {
    const draft = {
      ...START,
      categoryIds: [PLUMBING.id, ELECTRICAL.id],
      areaIds: ["zip-33324"],
    };
    expect(profilePatch(START, draft, null)).toEqual({
      category_ids: [PLUMBING.id, ELECTRICAL.id],
      service_area_ids: ["zip-33324"],
    });
  });

  it("adds the new photo's key, and never a photo field without one", () => {
    expect(profilePatch(START, START, "uploads/pro/photo-2")).toEqual({
      photo_key: "uploads/pro/photo-2",
    });
    expect(profilePatch(START, { ...START, years: "13" }, null)).not.toHaveProperty("photo_key");
  });
});

describe("draftErrors", () => {
  it.each(["", "0", "7", "80"])("takes %p years", (years) => {
    expect(draftErrors({ ...START, years })).toEqual({});
  });

  it.each(["81", "-1", "1.5", "ten"])("refuses %p years", (years) => {
    expect(draftErrors({ ...START, years })).toEqual({ years: "invalid" });
  });

  it("asks for at least one ZIP code", () => {
    expect(draftErrors({ ...START, areaIds: [] })).toEqual({ areas: "required" });
  });
});

describe("the selection", () => {
  it("switches one id in and out", () => {
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });

  it("switches a city: all of its ZIP codes, or none once all are in", () => {
    const city = ["zip-33301", "zip-33304", "zip-33305"];
    expect(cityToggled(["zip-33324", "zip-33301"], city)).toEqual(["zip-33324", ...city]);
    expect(cityToggled(["zip-33324", ...city], city)).toEqual(["zip-33324"]);
  });
});

describe("profileChecklist", () => {
  it("has nothing done on a new profile", () => {
    expect(profileChecklist(EMPTY_PROFILE)).toEqual({
      steps: [
        { step: "photo", done: false },
        { step: "about", done: false },
        { step: "categories", done: false },
        { step: "areas", done: false },
      ],
      done: 0,
      complete: false,
    });
  });

  it("is complete once every part is filled in", () => {
    expect(profileChecklist(FULL_PROFILE)).toMatchObject({ done: 4, complete: true });
  });

  it("counts About you only with both the bio and the years, zero years included", () => {
    const about = (profile: typeof FULL_PROFILE) =>
      profileChecklist(profile).steps.find(({ step }) => step === "about")?.done;
    expect(about({ ...FULL_PROFILE, bio: "   " })).toBe(false);
    expect(about({ ...FULL_PROFILE, years_of_experience: null })).toBe(false);
    expect(about({ ...FULL_PROFILE, years_of_experience: 0 })).toBe(true);
  });
});

describe("profileFailure", () => {
  it.each([
    [new NetworkError(false), "offline"],
    [new NetworkError(true), "offline"],
    [new ApiError(422, "invalid_media"), "photo"],
    [new ApiError(422, "invalid_category"), "choices"],
    [new ApiError(422, "invalid_service_area"), "choices"],
    [new ApiError(422, "validation_error"), "generic"],
    [new ApiError(403, "forbidden"), "generic"],
    [new ApiError(500, undefined), "generic"],
  ])("%p reads as %s", (error, failure) => {
    expect(profileFailure(error)).toBe(failure);
  });
});

describe("readProProfileConfig", () => {
  const read = (maxCategories?: string, maxServiceAreas?: string, reviewPollSeconds?: string) =>
    readProProfileConfig({ maxCategories, maxServiceAreas, reviewPollSeconds });

  it("allows 5 categories and 50 ZIP codes, and polls a pending review every 30 s, when nothing is set", () => {
    expect(read()).toEqual({ maxCategories: 5, maxServiceAreas: 50, reviewPollMs: 30_000 });
  });

  it("takes the environment's values", () => {
    expect(read("3", "20", "10")).toEqual({
      maxCategories: 3,
      maxServiceAreas: 20,
      reviewPollMs: 10_000,
    });
  });

  it.each(["0", "-2", "1.5", "many"])("refuses %p", (value) => {
    expect(() => read(value)).toThrow(/EXPO_PUBLIC_PRO_MAX_CATEGORIES must be a positive whole/);
    expect(() => read(undefined, value)).toThrow(/EXPO_PUBLIC_PRO_MAX_SERVICE_AREAS/);
  });

  // The review poll is optional tuning: a bad value falls back to 30 s, never stops the app (#481 r1).
  it.each(["0", "-5", "2.5", "abc", "15s", "3601", "Infinity", "NaN", " "])(
    "polls a pending review every 30 s for %j",
    (value) => {
      expect(read(undefined, undefined, value).reviewPollMs).toBe(30_000);
    },
  );

  it("loads with a bad review poll set, on the default", () => {
    const saved = process.env.EXPO_PUBLIC_PRO_REVIEW_POLL_SECONDS;
    process.env.EXPO_PUBLIC_PRO_REVIEW_POLL_SECONDS = "0";
    try {
      jest.isolateModules(() => {
        const { proProfileConfig } = jest.requireActual<typeof import("../config")>("../config");
        expect(proProfileConfig.reviewPollMs).toBe(30_000);
      });
    } finally {
      if (saved === undefined) delete process.env.EXPO_PUBLIC_PRO_REVIEW_POLL_SECONDS;
      else process.env.EXPO_PUBLIC_PRO_REVIEW_POLL_SECONDS = saved;
    }
  });
});
