// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RetryOnce } from "./retry-once";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HREF = "/admin/session/refresh?retried=1";
let root: Root;
let go: ReturnType<typeof vi.fn<(href: string) => void>>;

beforeEach(async () => {
  vi.useFakeTimers();
  go = vi.fn();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(RetryOnce, { href: HREF, seconds: 3, go })));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("RetryOnce (#530)", () => {
  it("opens the retry once, after the wait, and never again", async () => {
    await act(async () => vi.advanceTimersByTime(2999));
    expect(go).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(go).toHaveBeenCalledExactlyOnceWith(HREF);

    await act(async () => vi.advanceTimersByTime(60_000));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the page is gone", async () => {
    act(() => root.unmount());
    root = createRoot(document.createElement("div"));

    await act(async () => vi.advanceTimersByTime(60_000));
    expect(go).not.toHaveBeenCalled();
  });
});
