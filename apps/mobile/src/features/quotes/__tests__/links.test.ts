import { redirectSystemPath } from "../links";

import { QUOTES, REQUEST_ID } from "./helpers";

const QUOTE_ID = QUOTES[1].id;
const OTHER_ID = QUOTES[2].id;
const profile = (requestId: string, quoteId: string) =>
  `/requests/${requestId}/quotes/${quoteId}/pro`;
const PROFILE = profile(REQUEST_ID, QUOTE_ID);
const COMPARE = `/requests/${REQUEST_ID}?profile=${QUOTE_ID}`;
const redirect = (path: string) => redirectSystemPath({ path, initial: false });

describe("redirectSystemPath", () => {
  it("sends a pro profile link that reaches the running app to its comparison", () => {
    expect(redirect(PROFILE)).toBe(COMPARE);
    expect(redirect(`${PROFILE}/`)).toBe(COMPARE);
    expect(redirect(`${PROFILE}?utm=x`)).toBe(COMPARE);
    expect(redirect(`${PROFILE}#top`)).toBe(COMPARE);
    // A native build hands the whole URL over; the scheme stays as it came.
    expect(redirect(`jackfixit:/${PROFILE}`)).toBe(`jackfixit:/${COMPARE}`);
    // Expo Go: its host, then the path after `/--/`.
    expect(redirect(`exp://192.168.1.20:8081/--${PROFILE}`)).toBe(
      `exp://192.168.1.20:8081/--${COMPARE}`,
    );
    expect(redirect(`exps://u.expo.dev/--${PROFILE}`)).toBe(`exps://u.expo.dev/--${COMPARE}`);
    // An id written with escapes is read once; the output is built from the checked ids.
    expect(redirect(profile(REQUEST_ID, QUOTE_ID.replaceAll("-", "%2D")))).toBe(COMPARE);
  });

  it("leaves the initial URL as it came, hostile or not", () => {
    expect(redirectSystemPath({ path: PROFILE, initial: true })).toBe(PROFILE);
    const forged = `jackfixit:/${profile(REQUEST_ID, `${QUOTE_ID}%26profile%3D..`)}`;
    expect(redirectSystemPath({ path: forged, initial: true })).toBe(forged);
  });

  // Each one exactly as it came: `toBe` on the same string, byte for byte.
  it.each([
    // Delimiters in either id, raw.
    ["& in the quote id", profile(REQUEST_ID, `${QUOTE_ID}&profile=${OTHER_ID}`)],
    ["& in the request id", profile(`${REQUEST_ID}&id=${OTHER_ID}`, QUOTE_ID)],
    ["= in the quote id", profile(REQUEST_ID, `${QUOTE_ID}=`)],
    ["? in the quote id", `/requests/${REQUEST_ID}/quotes/${QUOTE_ID}?/pro`],
    ["# in the request id", `/requests/${REQUEST_ID}#/quotes/${QUOTE_ID}/pro`],
    // Encoded, then double-encoded.
    ["%26 and %3D in the quote id", profile(REQUEST_ID, `${QUOTE_ID}%26profile%3D..`)],
    ["%26 in the request id", profile(`${REQUEST_ID}%26x`, QUOTE_ID)],
    ["%3F and %23 in the quote id", profile(REQUEST_ID, `${QUOTE_ID}%3F%23`)],
    ["%2526 double encoding", profile(REQUEST_ID, `${QUOTE_ID}%2526profile%253D..`)],
    ["%2F in an id", profile(REQUEST_ID, `${QUOTE_ID}%2F..`)],
    // Dot segments and extra segments.
    ["a .. quote id", profile(REQUEST_ID, "..")],
    ["an encoded .. quote id", profile(REQUEST_ID, "%2E%2E")],
    ["a .. request id", profile("..", QUOTE_ID)],
    ["an extra segment", `${PROFILE}/extra`],
    ["a segment in between", `/requests/${REQUEST_ID}/x/quotes/${QUOTE_ID}/pro`],
    ["two trailing slashes", `${PROFILE}//`],
    ["a leading path", `/admin${PROFILE}`],
    // Ids that are not UUIDs.
    ["a short quote id", profile(REQUEST_ID, "123")],
    ["an uppercase quote id", profile(QUOTE_ID, REQUEST_ID.toUpperCase())],
    ["an empty quote id", profile(REQUEST_ID, "")],
    ["a UUID with a suffix", profile(REQUEST_ID, `${QUOTE_ID}0`)],
    ["unicode", profile(REQUEST_ID, "猫+é")],
    // Malformed escapes: decoding throws, the input passes.
    ["a lone %", profile(REQUEST_ID, "%")],
    ["a broken escape", profile(REQUEST_ID, "%E0%A4%A")],
    ["a lone surrogate", profile(REQUEST_ID, "%ED%A0%80")],
    // A host is never a path segment.
    ["https with requests as the host", `https:/${PROFILE}`],
    ["https with a host", `https://jackfixit.com${PROFILE}`],
    ["another scheme", `otherapp:/${PROFILE}`],
    ["another scheme in the Expo Go shape", `otherapp://host/--${PROFILE}`],
    ["an uppercase app scheme", `JACKFIXIT:/${PROFILE}`],
    ["a triple-slash app URL", `jackfixit://${PROFILE}`],
    ["a protocol-relative path", `/${PROFILE}`],
    ["no leading slash", PROFILE.slice(1)],
    // Unrelated paths.
    ["the comparison", `/requests/${REQUEST_ID}`],
    ["the accept sheet", `/requests/${REQUEST_ID}/accept?quote=${QUOTE_ID}`],
    ["a forged comparison", `/requests/${REQUEST_ID}?profile=..&profile=${OTHER_ID}`],
    ["the root", "/"],
    ["an empty string", ""],
  ])("passes %s through unchanged", (_, path) => {
    expect(redirect(path)).toBe(path);
  });

  it("passes very long input through without throwing, in linear time", () => {
    const long = [
      profile(REQUEST_ID, "a".repeat(1_000_000)),
      `jackfixit://${"requests/".repeat(100_000)}`,
      `exp://${"x".repeat(1_000_000)}`,
    ];
    for (const path of long) expect(redirect(path)).toBe(path);
    // A query of any length after a valid path is dropped, malformed escapes and all.
    expect(redirect(`${PROFILE}?${"%".repeat(1_000_000)}`)).toBe(COMPARE);
  });
});
