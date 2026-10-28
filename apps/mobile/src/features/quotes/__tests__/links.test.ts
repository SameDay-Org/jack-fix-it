import { redirectSystemPath } from "../links";

import { QUOTES, REQUEST_ID } from "./helpers";

const QUOTE_ID = QUOTES[1].id;
const PROFILE = `/requests/${REQUEST_ID}/quotes/${QUOTE_ID}/pro`;
const COMPARE = `/requests/${REQUEST_ID}?profile=${QUOTE_ID}`;

describe("redirectSystemPath", () => {
  it("sends a pro profile link that reaches the running app to its comparison", () => {
    expect(redirectSystemPath({ path: PROFILE, initial: false })).toBe(COMPARE);
    expect(redirectSystemPath({ path: `${PROFILE}/`, initial: false })).toBe(COMPARE);
    expect(redirectSystemPath({ path: `${PROFILE}?utm=x`, initial: false })).toBe(COMPARE);
    // A native build hands the whole URL over; the scheme stays as it came.
    expect(redirectSystemPath({ path: `jackfixit:/${PROFILE}`, initial: false })).toBe(
      `jackfixit:/${COMPARE}`,
    );
    // Expo Go: its host, then the path after `/--/`.
    expect(
      redirectSystemPath({ path: `exp://192.168.1.20:8081/--${PROFILE}`, initial: false }),
    ).toBe(`exp://192.168.1.20:8081/--${COMPARE}`);
  });

  it("leaves the initial URL and every other path alone", () => {
    expect(redirectSystemPath({ path: PROFILE, initial: true })).toBe(PROFILE);
    expect(redirectSystemPath({ path: `/requests/${REQUEST_ID}`, initial: false })).toBe(
      `/requests/${REQUEST_ID}`,
    );
    expect(
      redirectSystemPath({
        path: `/requests/${REQUEST_ID}/accept?quote=${QUOTE_ID}`,
        initial: false,
      }),
    ).toBe(`/requests/${REQUEST_ID}/accept?quote=${QUOTE_ID}`);
    expect(redirectSystemPath({ path: "/", initial: false })).toBe("/");
    // Only the route itself, not a deeper path that happens to contain it.
    expect(redirectSystemPath({ path: `/admin${PROFILE}`, initial: false })).toBe(
      `/admin${PROFILE}`,
    );
    expect(redirectSystemPath({ path: PROFILE.slice(1), initial: false })).toBe(PROFILE.slice(1));
  });
});
