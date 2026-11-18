// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import type { ResolveState } from "../actions";
import { RESOLVE_ERRORS } from "../disputes";
import { CODE } from "../disputes-test-helpers";
import { ResolveControl, type ResolveControlText } from "./resolve-control";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT: ResolveControlText = {
  title: "Resolve",
  decisionLabel: "Decision",
  decisions: {
    release: { label: "Release the payout to the pro", hint: "h1" },
    partial: { label: "Split", hint: "h2" },
    refund: { label: "Refund the customer in full", hint: "h3" },
  },
  decisionError: "Choose a decision.",
  amountLabel: "Amount released to the pro",
  amountHint: "More than $0 and less than $100.00.",
  amountErrors: { format: "FORMAT", zero: "ZERO", not_less: "NOT_LESS" },
  noteLabel: "Note (staff only)",
  noteHint: "Why.",
  noteError: "Write a note.",
  review: "Review the decision",
  confirmTitle: "Confirm the decision",
  totals: "Customer paid $132.50, pro payout $100.00.",
  sentences: {
    release: "Release the payout to the pro.",
    partial:
      "Release {{amount}} to the pro; the customer gets the remainder back by our calculation.",
    refund: "Refund the customer in full. This cannot be undone.",
  },
  codeLabel: `Type ${CODE} to confirm`,
  codeHint: "The request code.",
  submit: "Confirm",
  back: "Back",
  resolving: "Resolving…",
  resolved: "Dispute resolved.",
  errors: Object.fromEntries(RESOLVE_ERRORS.map((key) => [key, `ERROR:${key}`])) as Record<
    (typeof RESOLVE_ERRORS)[number],
    string
  >,
};

type Action = (previous: ResolveState, form: FormData) => Promise<ResolveState>;

let root: Root;
let container: HTMLDivElement;
let action: ReturnType<typeof vi.fn<Action>>;
/** Ends the request the action is waiting on. */
let finish: (state: ResolveState) => void;
let fail: (error: Error) => void;

beforeEach(() => {
  action = vi.fn<Action>(
    () =>
      new Promise<ResolveState>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ResolveControl, {
        action,
        code: CODE,
        payoutCents: 10_000,
        currency: "usd",
        locale: "en",
        text: TEXT,
      }),
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const tag = [...container.querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith(label),
  );
  const target = tag && container.ownerDocument.getElementById(tag.htmlFor);
  if (!target) throw new Error(`no field ${label}`);
  return target as HTMLInputElement | HTMLTextAreaElement;
}

async function type(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

async function choose(label: string): Promise<void> {
  await click(field(label) as HTMLInputElement);
}

/** Decision, amount and note filled, then on to the confirmation. */
async function reviewed(decision: string, note = "Checked the photos.", amount?: string) {
  await mount();
  await choose(decision);
  if (amount !== undefined) await type(field("Amount released to the pro"), amount);
  await type(field("Note (staff only)"), note);
  await click(button("Review the decision"));
}

function text(): string {
  return container.textContent ?? "";
}

describe("the resolve control", () => {
  it("asks for a decision and a note before anything else", async () => {
    await mount();
    await click(button("Review the decision"));
    expect(text()).toContain("Choose a decision.");
    expect(text()).toContain("Write a note.");
    expect(text()).not.toContain("Confirm the decision");
    expect(document.activeElement).toBe(field("Release the payout to the pro"));
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ["0", "ZERO"],
    ["100", "NOT_LESS"],
    ["100.00", "NOT_LESS"],
    ["250", "NOT_LESS"],
    ["-5", "FORMAT"],
    ["ten", "FORMAT"],
    ["", "FORMAT"],
  ])("refuses a split of %j with its message", async (amount, message) => {
    await reviewed("Split", "n", amount);
    expect(text()).toContain(message);
    expect(text()).not.toContain("Confirm the decision");
    const input = field("Amount released to the pro");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
  });

  it("restates a split in words with the amount typed, rounded to the cent", async () => {
    await reviewed("Split", "n", "12.345");
    expect(text()).toContain(
      "Release $12.35 to the pro; the customer gets the remainder back by our calculation.",
    );
    expect(text()).toContain("Customer paid $132.50, pro payout $100.00.");
    expect(document.activeElement?.textContent).toBe("Confirm the decision");
  });

  it("keeps Confirm unavailable for a refund until the code is typed again", async () => {
    await reviewed("Refund the customer in full");
    expect(text()).toContain("Refund the customer in full. This cannot be undone.");
    const confirm = button("Confirm");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.disabled).toBe(false); // focusable, never a dead control

    await click(confirm);
    expect(action).not.toHaveBeenCalled();

    await type(field(`Type ${CODE} to confirm`), "JFX-0000");
    expect(button("Confirm").getAttribute("aria-disabled")).toBe("true");
    await click(button("Confirm"));
    expect(action).not.toHaveBeenCalled();

    await type(field(`Type ${CODE} to confirm`), CODE.toLowerCase());
    expect(button("Confirm").getAttribute("aria-disabled")).toBeNull();
  });

  it("asks for the code for a split too, not for a release", async () => {
    await reviewed("Split", "n", "45");
    expect(button("Confirm").getAttribute("aria-disabled")).toBe("true");
    await act(async () => root.unmount());
    root = createRoot(container);
    await reviewed("Release the payout to the pro");
    expect(text()).toContain("Release the payout to the pro.");
    expect(container.querySelector(`input[autocomplete="off"][autocapitalize]`)).toBeNull();
    expect(button("Confirm").getAttribute("aria-disabled")).toBeNull();
  });

  it("sends one request per confirmation, what was typed, and ignores Confirm meanwhile", async () => {
    await reviewed("Split", "  Half the job.  ", "45.50");
    await type(field(`Type ${CODE} to confirm`), CODE);
    await click(button("Confirm"));
    await click(button("Confirm"));
    await act(async () => button("Confirm").closest("form")?.requestSubmit());
    expect(action).toHaveBeenCalledTimes(1);
    const sent = action.mock.calls[0]?.[1];
    expect(Object.fromEntries(sent?.entries() ?? [])).toEqual({
      decision: "partial",
      amount: "45.50",
      note: "  Half the job.  ",
    });
    expect(button("Confirm").getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain("Resolving…");

    await act(async () => finish({ error: null, resolved: true }));
    expect(text()).toContain("Dispute resolved.");
  });

  it("never sends again by itself when the request does not answer: it reads the page again", async () => {
    await reviewed("Refund the customer in full");
    await type(field(`Type ${CODE} to confirm`), CODE);
    await click(button("Confirm"));
    await act(async () => fail(new TypeError("Failed to fetch")));
    expect(action).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("ERROR:unconfirmed");
    expect(document.activeElement).toBe(alert);
    // Back on the first step, with what was typed: a retry is the admin's own choice.
    expect(text()).not.toContain("Confirm the decision");
    expect((field("Note (staff only)") as HTMLTextAreaElement).value).toBe("Checked the photos.");
  });

  it("shows the API's refusal in calm words and asks for the code again", async () => {
    await reviewed("Refund the customer in full");
    await type(field(`Type ${CODE} to confirm`), CODE);
    await click(button("Confirm"));
    await act(async () => finish({ error: "refund_pending", resolved: false }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("ERROR:refund_pending");
    expect(refresh).not.toHaveBeenCalled();
    await click(button("Review the decision"));
    expect((field(`Type ${CODE} to confirm`) as HTMLInputElement).value).toBe("");
  });

  it("sends nothing while offline and says so", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await reviewed("Release the payout to the pro");
    await click(button("Confirm"));
    expect(action).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("ERROR:offline");
    vi.restoreAllMocks();
  });

  it("goes back with the focus on Review, keeping what was typed", async () => {
    await reviewed("Split", "n", "45");
    await click(button("Back"));
    expect(document.activeElement).toBe(button("Review the decision"));
    expect((field("Amount released to the pro") as HTMLInputElement).value).toBe("45");
  });
});
