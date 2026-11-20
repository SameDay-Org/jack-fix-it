// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { OPS_ERRORS, type OpsState } from "../ops";
import { ActionBar, type ActionBarText, FollowupDone, KeptDoneRefusal } from "./ops-controls";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT: ActionBarText = {
  saving: "Saving…",
  saved: "Saved.",
  cancel: "Cancel",
  errors: Object.fromEntries(
    OPS_ERRORS.map((code) => [code, `ERROR:${code}`]),
  ) as ActionBarText["errors"],
  label: "Actions on this request",
  note: { open: "Add note", label: "Internal note", submit: "Save note" },
  contacted: { press: "Mark contacted" },
  classify: { open: "Classify", label: "Category", submit: "Save category" },
  followup: {
    open: "Schedule follow-up",
    day: "Day",
    time: "Time",
    zone: "Day and time in Eastern Time.",
    note: "What to do",
    assignee: "Assigned to",
    me: "Me",
    noName: "No name",
    submit: "Schedule",
  },
};
const SELF = "6f1c2a1e-1111-4222-8333-944455556666";
const CATEGORIES = [
  { id: "c1", name: "Handyman" },
  { id: "c2", name: "Painting" },
];

type FormAction = (previous: OpsState, form: FormData) => Promise<OpsState>;

/** An action that waits until the test ends it, recording each call. */
function pending() {
  let finish: (state: OpsState) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const action = vi.fn<FormAction>(
    () =>
      new Promise<OpsState>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  return { action, finish: (state: OpsState) => finish(state), fail: (e: Error) => fail(e) };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  refresh.mockReset();
});

async function mount(props: Partial<Parameters<typeof ActionBar>[0]> = {}): Promise<void> {
  const idle = vi.fn<FormAction>(async () => ({ error: null, saved: true }));
  await act(async () =>
    root.render(
      createElement(ActionBar, {
        allowed: true,
        heldText: "Sam holds this request: take it to act on it.",
        addNote: idle,
        markContacted: async () => ({ error: null, saved: true }),
        classify: idle,
        schedule: idle,
        contacted: false,
        canClassify: true,
        categories: CATEGORIES,
        currentCategoryId: "c2",
        staff: null,
        selfId: SELF,
        days: { min: "2026-11-19", max: "2026-12-19" },
        text: TEXT,
        ...props,
      }),
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const tag = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  const target = tag && document.getElementById(tag.htmlFor);
  if (!target) throw new Error(`no field ${label}`);
  return target as HTMLInputElement;
}

async function type(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
}

async function key(target: Element, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

function alert(): string | null | undefined {
  return container.querySelector('[role="alert"]')?.textContent;
}

describe("the action bar", () => {
  it("opens one form at a time, and gives the focus back to its button when it closes", async () => {
    await mount();
    await click(button("Add note"));
    expect(button("Add note").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(field("Internal note"));
    await click(button("Classify"));
    expect(container.querySelector("textarea")).toBeNull();
    expect(field("Category").value).toBe("c2");
    await key(field("Category"), "Escape");
    expect(container.querySelector("select")).toBeNull();
    expect(document.activeElement).toBe(button("Classify"));
    await click(button("Add note"));
    await click(button("Cancel"));
    expect(document.activeElement).toBe(button("Add note"));
  });

  it("offers neither Classify nor Mark contacted when the page says not to", async () => {
    await mount({ canClassify: false, contacted: true });
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Add note", "Schedule follow-up"]);
  });
});

describe("a note", () => {
  it("is sent once per press, keeps its text on a refusal and clears only once saved", async () => {
    const { action, finish } = pending();
    await mount({ addNote: action });
    await click(button("Add note"));
    await type(field("Internal note") as HTMLTextAreaElement, "Called, no answer.");
    expect(container.textContent).toContain("18 / 2000");
    await click(button("Save note"));
    await click(button("Save note"));
    await act(async () => button("Save note").closest("form")?.requestSubmit());
    expect(action).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(action.mock.calls[0]![1].entries())).toEqual({
      body: "Called, no answer.",
    });
    expect(button("Save note").getAttribute("aria-disabled")).toBe("true");

    await act(async () => finish({ error: "request_held", saved: false }));
    expect(alert()).toBe("ERROR:request_held");
    expect((field("Internal note") as HTMLTextAreaElement).value).toBe("Called, no answer.");

    await click(button("Save note"));
    await act(async () => finish({ error: null, saved: true }));
    expect(action).toHaveBeenCalledTimes(2);
    expect((field("Internal note") as HTMLTextAreaElement).value).toBe("");
    const form = button("Save note").closest("form");
    expect(form?.querySelector('[role="status"]')?.textContent).toBe("Saved.");
  });

  it("is never sent again by itself when the request does not answer: the card is read again", async () => {
    const { action, fail } = pending();
    await mount({ addNote: action });
    await click(button("Add note"));
    await type(field("Internal note") as HTMLTextAreaElement, "n");
    await click(button("Save note"));
    await act(async () => fail(new TypeError("Failed to fetch")));
    expect(action).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(alert()).toBe("ERROR:unconfirmed");
    expect((field("Internal note") as HTMLTextAreaElement).value).toBe("n");
  });
});

describe("a refusal the card's refresh would hide", () => {
  it("is still said once the card shows the request held by another agent", async () => {
    const { action, finish } = pending();
    await mount({ addNote: action });
    await click(button("Add note"));
    await type(field("Internal note") as HTMLTextAreaElement, "Trying to reach them.");
    await click(button("Save note"));
    await act(async () => finish({ error: "request_held", saved: false }));
    // The server action read the card again: another agent holds it now.
    await mount({ addNote: action, allowed: false });
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(container.textContent).toContain("Sam holds this request: take it to act on it.");
    expect(alert()).toBe("ERROR:request_held");
  });

  it("shows who holds the request, and no button, when the reader may not act", async () => {
    await mount({ allowed: false });
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toBe("Sam holds this request: take it to act on it.");
  });
});

describe("a follow-up", () => {
  it("names the business time zone, and sends day, time and note", async () => {
    const schedule = vi.fn<FormAction>(async () => ({ error: null, saved: true }));
    await mount({ schedule });
    await click(button("Schedule follow-up"));
    expect(container.textContent).toContain("Day and time in Eastern Time.");
    const day = field("Day") as HTMLInputElement;
    expect([day.min, day.max]).toEqual(["2026-11-19", "2026-12-19"]);
    await type(day, "2026-11-20");
    await type(field("Time") as HTMLInputElement, "09:30");
    await type(field("What to do") as HTMLTextAreaElement, "Call back.");
    expect(container.querySelector("select")).toBeNull(); // an agent's form: no assignee
    await click(button("Schedule"));
    expect(Object.fromEntries(schedule.mock.calls[0]![1].entries())).toEqual({
      day: "2026-11-20",
      time: "09:30",
      note: "Call back.",
    });
  });

  it("lets an admin give it to another staff member, themselves by default", async () => {
    await mount({
      staff: [
        { id: SELF, name: "Probe" },
        { id: "a9e07f3a-1111-4222-8333-944455556681", name: "Sam" },
      ],
    });
    await click(button("Schedule follow-up"));
    const assignee = field("Assigned to") as HTMLSelectElement;
    expect(assignee.value).toBe(SELF);
    expect([...assignee.options].map((option) => option.textContent)).toEqual(["Me", "Sam"]);
  });
});

describe("one-press actions", () => {
  it("sends Mark contacted once however often it is pressed while out", async () => {
    let finish: (state: OpsState) => void = () => {};
    const markContacted = vi.fn(() => new Promise<OpsState>((resolve) => (finish = resolve)));
    await mount({ markContacted });
    await click(button("Mark contacted"));
    await click(button("Mark contacted"));
    expect(markContacted).toHaveBeenCalledTimes(1);
    await act(async () => finish({ error: null, saved: true }));
    expect(container.textContent).toContain("Saved.");
  });

  it("sends Mark done once, and says why it was refused", async () => {
    let finish: (state: OpsState) => void = () => {};
    const done = vi.fn(() => new Promise<OpsState>((resolve) => (finish = resolve)));
    await act(async () =>
      root.render(
        createElement(FollowupDone, { id: "f1", action: done, label: "Mark done", text: TEXT }),
      ),
    );
    await click(button("Mark done"));
    await click(button("Mark done"));
    expect(done).toHaveBeenCalledTimes(1);
    await act(async () => finish({ error: "forbidden", saved: false }));
    expect(alert()).toBe("ERROR:forbidden");
  });
});

describe("a Mark done refusal once the refresh takes the row away (#499 round 1)", () => {
  /** The list as the page renders it: the follow-ups still offering the button, each with one. */
  async function list(offered: string[], done: () => Promise<OpsState>) {
    await act(async () =>
      root.render(
        createElement(
          KeptDoneRefusal,
          { offered, text: TEXT },
          ...offered.map((id) =>
            createElement(FollowupDone, {
              key: id,
              id,
              action: done,
              label: "Mark done",
              text: TEXT,
            }),
          ),
        ),
      ),
    );
  }
  const alerts = () => [...container.querySelectorAll('[role="alert"]')].map((n) => n.textContent);

  it("says it once in the row while the row stays, and keeps saying it when the row goes", async () => {
    // A demoted admin presses Mark done on another's follow-up: 403, and the card read again
    // shows only their own, so the row (and the message in it) is gone.
    const done = vi.fn(async (): Promise<OpsState> => ({ error: "forbidden", saved: false }));
    await list(["f1", "f2"], done);
    await click(button("Mark done"));
    expect(alerts()).toEqual(["ERROR:forbidden"]);
    await list(["f2"], done);
    expect(alerts()).toEqual(["ERROR:forbidden"]);
    await list([], done);
    expect(alerts()).toEqual(["ERROR:forbidden"]);
  });

  it("clears the kept message once a later Mark done goes through", async () => {
    const refused = vi.fn(async (): Promise<OpsState> => ({ error: "forbidden", saved: false }));
    await list(["f1"], refused);
    await click(button("Mark done"));
    await list([], refused);
    expect(alerts()).toEqual(["ERROR:forbidden"]);
    const ok = vi.fn(async (): Promise<OpsState> => ({ error: null, saved: true }));
    await list(["f2"], ok);
    // The kept message stays until the next press answers.
    expect(alerts()).toEqual(["ERROR:forbidden"]);
    await click(button("Mark done"));
    expect(alerts()).toEqual([]);
    expect(container.textContent).toContain("Saved.");
  });
});
