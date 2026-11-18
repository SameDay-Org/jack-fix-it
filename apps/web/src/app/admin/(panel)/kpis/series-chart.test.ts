// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { centeredScroll, SeriesChart } from "./series-chart";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 30 days of October, two lines: what the KPI page draws for its first chart. */
const DAYS = Array.from(
  { length: 30 },
  (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`,
);
const REQUESTS = DAYS.map((_, index) => index % 7);
const JOBS = DAYS.map((_, index) => index % 3);
const DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const dayOf = (index: number) => DAY.format(new Date(`${DAYS[index]}T00:00:00Z`));

/** A phone: the drawing (880 px) scrolls inside 318 px. */
const PHONE = { clientWidth: 318, scrollWidth: 880 };
const WIDE = { clientWidth: 880, scrollWidth: 880 };

let root: Root;
let container: HTMLDivElement;
let scrolls: ScrollToOptions[];
let reduceMotion: boolean;

beforeEach(() => {
  scrolls = [];
  reduceMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce") ? reduceMotion : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom lays nothing out: record where the chart asks to scroll.
  HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number) {
    if (typeof options === "object") scrolls.push(options);
  } as HTMLElement["scrollTo"];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(size: { clientWidth: number; scrollWidth: number }): Promise<HTMLElement> {
  await act(async () =>
    root.render(
      createElement(SeriesChart, {
        days: DAYS,
        series: [
          { key: "requests", label: "Requests created", color: "red", values: REQUESTS },
          { key: "jobs", label: "Jobs completed", color: "blue", values: JOBS },
        ],
        kind: "count",
        locale: "en",
        label: "Requests and jobs per day",
        keyboardHint: "Use the arrow keys.",
      }),
    ),
  );
  const chart = container.querySelector<HTMLElement>('[role="group"]');
  if (!chart) throw new Error("no chart");
  Object.defineProperty(chart, "clientWidth", { value: size.clientWidth });
  Object.defineProperty(chart, "scrollWidth", { value: size.scrollWidth });
  return chart;
}

async function press(chart: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    chart.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function readout(): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-readout]");
  if (!element) throw new Error("no readout");
  return element;
}

/** Where the drawing marks the selected day, in its own pixels. */
function markerX(): number {
  return Number(container.querySelector("[data-marker] line")?.getAttribute("x1"));
}

describe("the chart's readout and keyboard", () => {
  it("writes the selected day's values outside the part that scrolls", async () => {
    const chart = await mount(PHONE);
    expect(readout().textContent).toBe("");
    await act(async () => chart.focus());
    // Focus selects the last day.
    expect(readout().dataset.index).toBe("29");
    expect(readout().textContent).toBe(
      `${dayOf(29)}${REQUESTS[29]}Requests created${JOBS[29]}Jobs completed`,
    );
    // Never inside the scrolling drawing: it stays in view whatever the scroll.
    expect(chart.contains(readout())).toBe(false);
    expect(
      readout().compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([
    ["ArrowLeft", 28],
    ["Home", 0],
    ["End", 29],
  ])(
    "on a phone, %s selects day %s, writes it and scrolls the drawing to it",
    async (key, index) => {
      const chart = await mount(PHONE);
      await act(async () => chart.focus());
      await press(chart, key);
      expect(readout().dataset.index).toBe(String(index));
      expect(readout().textContent).toContain(dayOf(index));
      expect(readout().textContent).toContain(`${REQUESTS[index]}Requests created`);
      expect(scrolls.at(-1)).toEqual({
        left: centeredScroll(markerX(), PHONE.clientWidth, PHONE.scrollWidth),
        behavior: "smooth",
      });
    },
  );

  it("walks back and forth with the arrows, the scroll following", async () => {
    const chart = await mount(PHONE);
    await act(async () => chart.focus());
    await press(chart, "Home");
    await press(chart, "ArrowRight");
    await press(chart, "ArrowRight");
    expect(readout().dataset.index).toBe("2");
    expect(scrolls.at(-1)?.left).toBe(0); // near the start: the drawing cannot scroll before 0
    await press(chart, "End");
    await press(chart, "ArrowLeft");
    expect(readout().dataset.index).toBe("28");
    expect(scrolls.at(-1)?.left).toBe(PHONE.scrollWidth - PHONE.clientWidth);
  });

  it("scrolls at once under Reduce Motion", async () => {
    reduceMotion = true;
    const chart = await mount(PHONE);
    await act(async () => chart.focus());
    await press(chart, "ArrowLeft");
    expect(scrolls.at(-1)?.behavior).toBe("auto");
  });

  it("does not scroll a drawing that fits, and still writes the readout", async () => {
    const chart = await mount(WIDE);
    await act(async () => chart.focus());
    await press(chart, "ArrowLeft");
    expect(scrolls).toEqual([]);
    expect(readout().dataset.index).toBe("28");
  });

  it("writes the readout on hover too, and clears it when the pointer leaves", async () => {
    await mount(WIDE);
    const svg = container.querySelector("svg");
    const target = container.querySelector("svg rect:last-of-type");
    if (!svg || !target) throw new Error("no drawing");
    svg.getBoundingClientRect = () => ({ left: 0, width: 880 }) as DOMRect;
    await act(async () => {
      target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 64 }));
    });
    expect(readout().dataset.index).toBe("0");
    expect(readout().textContent).toContain(dayOf(0));
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
      target.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    });
    expect(readout().textContent).toBe("");
  });

  it("keeps the screen reader's live region as it was", async () => {
    const chart = await mount(PHONE);
    await act(async () => chart.focus());
    await press(chart, "Home");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      `${dayOf(0)}: Requests created ${REQUESTS[0]}, Jobs completed ${JOBS[0]}`,
    );
    expect(readout().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("centeredScroll", () => {
  it.each([
    [500, 318, 880, 341],
    [64, 318, 880, 0],
    [824, 318, 880, 562],
    [400, 880, 880, 0],
  ])("puts %s px in the middle of %s px out of %s: %s", (point, client, scroll, left) => {
    expect(centeredScroll(point, client, scroll)).toBe(left);
  });
});
