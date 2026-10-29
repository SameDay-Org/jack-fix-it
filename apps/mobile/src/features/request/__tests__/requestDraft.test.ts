import { router } from "expo-router";

import { requestDraftStore, resetDraft, startRequest } from "../requestDraft";
import { flowRisen, requestFlowOptions } from "../rise";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);

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

  it("with Home's rise, marks the flow risen until the draft goes; a refused rise changes nothing", () => {
    startRequest("painting", () => true);
    expect(flowRisen()).toBe(true);
    expect(requestFlowOptions()).not.toEqual({ animation: "default" });
    expect(router.push).not.toHaveBeenCalled(); // the rise navigates

    // The panel is already rising into Painting: a second card does not take its place.
    const rise = jest.fn(() => false);
    startRequest("handyman", rise);
    expect(rise).toHaveBeenCalledWith("/request/new");
    expect(requestDraftStore.getState().categorySlug).toBe("painting");
    expect(flowRisen()).toBe(true);

    resetDraft();
    expect(flowRisen()).toBe(false);
    expect(requestFlowOptions()).toEqual({ animation: "default" });
  });

  it("requires a slug: every request starts from a category", () => {
    // The guard is the compiler's (tsc runs over the tests): the call below never runs.
    // @ts-expect-error null is not a category slug (#232)
    const withoutCategory = () => startRequest(null);

    expect(withoutCategory).toBeInstanceOf(Function);
  });
});
