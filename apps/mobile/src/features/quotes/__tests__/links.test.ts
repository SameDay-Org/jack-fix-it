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
  });
});
