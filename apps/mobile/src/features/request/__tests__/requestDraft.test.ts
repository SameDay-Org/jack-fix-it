import { router } from "expo-router";

import { requestDraftStore, startRequest } from "../requestDraft";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

describe("startRequest", () => {
  beforeEach(() => {
    jest.mocked(router.push).mockClear();
    requestDraftStore.setState({ categorySlug: null });
  });

  it("stores the slug, replacing an earlier start, and opens the request start", () => {
    startRequest("painting");
    startRequest("handyman");

    expect(requestDraftStore.getState().categorySlug).toBe("handyman");
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenLastCalledWith("/request/new");
  });

  it("requires a slug: every request starts from a category", () => {
    // The guard is the compiler's (tsc runs over the tests): the call below never runs.
    // @ts-expect-error null is not a category slug (#232)
    const withoutCategory = () => startRequest(null);

    expect(withoutCategory).toBeInstanceOf(Function);
  });
});
