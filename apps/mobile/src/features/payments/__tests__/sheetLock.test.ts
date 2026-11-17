import { claimSheet } from "../sheetLock";

describe("claimSheet", () => {
  it("gives the app's one Stripe sheet to one flow at a time", () => {
    const release = claimSheet();
    expect(release).not.toBeNull();
    // A second flow (a payment while a card is being added, or the reverse) is refused.
    expect(claimSheet()).toBeNull();

    release?.();
    const next = claimSheet();
    expect(next).not.toBeNull();

    // A late second release of the first claim does not free the sheet the next flow holds.
    release?.();
    expect(claimSheet()).toBeNull();
    next?.();
    claimSheet()?.();
  });
});
