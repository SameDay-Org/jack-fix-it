// @vitest-environment jsdom
import { act, createElement, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The navigation each range change waits on: settled by the test, like the server's answer. */
const navigation = vi.hoisted(() => ({ settle: () => {}, pushes: [] as string[] }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      navigation.pushes.push(href);
      return new Promise<void>((resolve) => {
        navigation.settle = resolve;
      });
    },
  }),
}));
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props),
}));

import { RangeControl, UPDATING_DELAY_MS, type RangeControlText } from "./range-control";

const TEXT: RangeControlText = {
  label: "Date range",
  presets: { 7: "Last 7 days", 30: "Last 30 days", 90: "Last 90 days" },
  custom: "Custom range",
  from: "From",
  to: "To",
  apply: "Show",
  updating: "Updating…",
  errors: { missing: "Pick both days.", order: "From comes first.", length: "Too long." },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  navigation.pushes = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(RangeControl, {
        preset: 30,
        from: "2026-10-20",
        to: "2026-11-18",
        today: "2026-11-18",
        maxDays: 366,
        text: TEXT,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const section = () => container.querySelector("section") as HTMLElement;
const status = () => container.querySelector("[aria-live]")?.textContent ?? "";

async function choose(name: string): Promise<void> {
  const link = [...container.querySelectorAll("a")].find((a) => a.textContent === name);
  await act(async () => {
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function answer(): Promise<void> {
  await act(async () => navigation.settle());
}

describe("range control: the updating label (#453)", () => {
  it("is busy at once but says it is updating only after the delay", async () => {
    await choose("Last 7 days");

    expect(navigation.pushes).toEqual(["/admin/kpis?days=7"]);
    expect(section().getAttribute("aria-busy")).toBe("true");
    expect(status()).toBe("");

    await wait(UPDATING_DELAY_MS - 1);
    expect(status()).toBe("");

    await wait(1);
    expect(status()).toBe("Updating…");

    await answer();
    expect(section().getAttribute("aria-busy")).toBe("false");
    expect(status()).toBe("");
  });

  it("never shows the label when the answer comes before the delay", async () => {
    await choose("Last 90 days");
    await wait(UPDATING_DELAY_MS / 3);
    await answer();
    await wait(UPDATING_DELAY_MS * 2);

    expect(status()).toBe("");
    expect(section().getAttribute("aria-busy")).toBe("false");
  });

  it("waits the full delay again on the next change", async () => {
    await choose("Last 7 days");
    await wait(UPDATING_DELAY_MS);
    expect(status()).toBe("Updating…");
    await answer();

    await choose("Last 90 days");
    expect(status()).toBe("");
    await wait(UPDATING_DELAY_MS - 1);
    expect(status()).toBe("");
    await wait(1);
    expect(status()).toBe("Updating…");
    await answer();
  });
});
