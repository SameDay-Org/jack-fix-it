// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveMascot } from "./react-live.ts";
import type { MascotProps } from "./react-svg.ts";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The viewport's observers, so a test can put the mascot on screen. */
let observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
/** Frames are only counted, never run: a pose that needs one has not shown yet. */
const requestFrame = vi.fn<(callback: FrameRequestCallback) => number>(() => 1);
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  observers = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  requestFrame.mockClear();
  vi.unstubAllGlobals();
});

async function render(props: MascotProps): Promise<void> {
  await act(async () => root.render(createElement(LiveMascot, props)));
}

/** A running mascot: shown, motion allowed, on screen. */
async function running(props: MascotProps): Promise<void> {
  await render(props);
  await act(async () => {
    for (const observe of observers) observe([{ isIntersecting: true }]);
  });
  expect(container.querySelector("svg")?.getAttribute("data-motion")).toBe("running");
  requestFrame.mockClear();
}

/** The markup a page would get for these props, parsed by the same document. */
function drawn(props: MascotProps): string {
  const expected = document.createElement("div");
  expected.innerHTML = renderToStaticMarkup(createElement(LiveMascot, props));
  return expected.innerHTML;
}

describe("<LiveMascot> mounted in a page", () => {
  it("moves to a new pose frame by frame while it runs", async () => {
    await running({ pose: "wave" });
    await render({ pose: "celebrate" });
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it("shows the new pose at once, asking for no frame, when animate turns off in the same render", async () => {
    await running({ pose: "wave" });
    await render({ pose: "celebrate", animate: false });
    expect(requestFrame).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(drawn({ pose: "celebrate", animate: false }));
  });
});
