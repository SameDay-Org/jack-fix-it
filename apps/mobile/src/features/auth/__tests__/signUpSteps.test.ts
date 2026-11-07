import { EMPTY_ADDRESS_FIELDS } from "@/features/addresses/addressFields";

import { user } from "../../../api/__tests__/helpers";
import {
  firstUnfinishedStep,
  homeErrors,
  nameErrors,
  SIGN_UP_STEPS,
  signUpEntry,
  tidyName,
} from "../signUpSteps";

const named = { ...user, first_name: "Ana", last_name: "Cruz" };
const placed = { ...named, home_city: "Miami", home_state: "FL" };

describe("sign-up steps", () => {
  it("runs account, name, home, in that order", () => {
    expect(SIGN_UP_STEPS).toEqual(["account", "name", "home"]);
  });

  it("resumes after the last step the account already answered", () => {
    expect(firstUnfinishedStep(user)).toBe("name");
    expect(firstUnfinishedStep({ ...user, first_name: "Ana" })).toBe("name");
    expect(firstUnfinishedStep({ ...named, last_name: "  " })).toBe("name");
    expect(firstUnfinishedStep(named)).toBe("home");
    expect(firstUnfinishedStep(placed)).toBeNull();
  });
});

describe("signUpEntry", () => {
  it("starts a new account with the role chosen before", () => {
    expect(signUpEntry("customer", null, null)).toEqual({ role: "customer", step: "account" });
    expect(signUpEntry("pro", null, null)).toEqual({ role: "pro", step: "account" });
  });

  it("without a valid role there is no flow to open", () => {
    expect(signUpEntry(undefined, null, null)).toBeNull();
    expect(signUpEntry("admin", null, null)).toBeNull();
  });

  it("the account on this device's flow resumes in its own role, whatever the route says", () => {
    expect(signUpEntry(undefined, { ...named, role: "pro" }, user.id)).toEqual({
      role: "pro",
      step: "home",
    });
    expect(signUpEntry("pro", user, user.id)).toEqual({ role: "customer", step: "name" });
    expect(signUpEntry(undefined, placed, user.id)).toEqual({ role: "customer", step: null });
  });

  it("an account that is not on a flow never gets one", () => {
    expect(signUpEntry("customer", user, null)).toBeNull();
    expect(signUpEntry("customer", user, "another-account")).toBeNull();
    expect(signUpEntry(undefined, { ...user, role: "admin" }, user.id)).toBeNull();
  });
});

describe("names", () => {
  it("tidies like the API: trimmed, inner spaces collapsed, case kept", () => {
    expect(tidyName("  ana   de la  Cruz ")).toBe("ana de la Cruz");
  });

  it("needs both, each 60 characters at most once tidied", () => {
    expect(nameErrors({ first: "Ana", last: "Cruz" })).toEqual({});
    expect(nameErrors({ first: " ", last: "" })).toEqual({ first: "required", last: "required" });
    expect(
      nameErrors({ first: "A".repeat(60), last: `${"B".repeat(30)}   ${"C".repeat(29)}` }),
    ).toEqual({});
    expect(nameErrors({ first: "A".repeat(61), last: "Cruz" })).toEqual({ first: "tooLong" });
  });
});

describe("homeErrors", () => {
  const place = { ...EMPTY_ADDRESS_FIELDS, city: "Miami", state: "FL" };

  it("a pro needs the city and a US state or DC code, nothing else", () => {
    expect(homeErrors(place, "pro")).toEqual({});
    expect(homeErrors({ ...place, state: "dc" }, "pro")).toEqual({});
    expect(homeErrors({ ...place, state: "ON" }, "pro")).toEqual({ state: "state" });
    expect(homeErrors({ ...place, city: " ", state: "" }, "pro")).toEqual({
      city: "required",
      state: "required",
    });
    expect(homeErrors({ ...place, city: "M".repeat(81) }, "pro")).toEqual({ city: "tooLong" });
  });

  it("a customer needs a whole address too, its city short enough for the card", () => {
    expect(homeErrors(place, "customer")).toEqual({ line1: "required", zipCode: "required" });
    const address = { ...place, line1: "120 Main St", zipCode: "33101" };
    expect(homeErrors(address, "customer")).toEqual({});
    expect(homeErrors({ ...address, city: "M".repeat(100) }, "customer")).toEqual({
      city: "tooLong",
    });
    expect(homeErrors({ ...address, state: "PR" }, "customer")).toEqual({ state: "state" });
  });
});
