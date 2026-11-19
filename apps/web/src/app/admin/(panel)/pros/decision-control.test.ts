// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewState } from "./actions";
import { DecisionControl, type DecisionControlText } from "./decision-control";
import { type Decision, DECISIONS } from "./pros";

// React's act() expects to be told it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT: DecisionControlText = {
  label: "Review Photo ID",
  approve: "Approve",
  reject: "Reject",
  approveQuestion: "Approve this pro?",
  confirmApprove: "Yes, approve",
  confirmReject: "Reject with this reason",
  cancel: "Cancel",
  reasonLabel: "Reason",
  reasonHint: "The pro can read this.",
  saving: "Saving…",
  saved: "Saved.",
  decided: { approved: "Approved.", rejected: "Rejected." },
  errors: {
    reason_required: "Write a reason.",
    not_found: "Not found.",
    already_reviewed: "Already reviewed.",
    not_approvable: "Not approvable.",
    forbidden: "Not allowed.",
    unavailable: "Try again.",
  },
};

type Action = (previous: ReviewState, form: FormData) => Promise<ReviewState>;
let root: Root;
let container: HTMLDivElement;
let finish: (state: ReviewState) => void;
const action = vi.fn<Action>(
  () =>
    new Promise<ReviewState>((resolve) => {
      finish = resolve;
    }),
);

/** The document as the page draws it: its heading (the focus target) and the control. */
async function render(offered: readonly Decision[]) {
  await act(async () =>
    root.render(
      createElement(
        "li",
        null,
        createElement("h3", { id: "document-1", tabIndex: -1 }, "Photo ID"),
        createElement(DecisionControl, { action, offered, focusAfter: "document-1", text: TEXT }),
      ),
    ),
  );
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement;
const status = () => container.querySelector('[role="status"]')?.textContent ?? "";

beforeEach(() => {
  action.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a document's decision by keyboard (#463)", () => {
  it("approving hands the focus to the document's heading and announces it", async () => {
    await render(DECISIONS);
    const approve = button("Approve");
    approve.focus();

    await act(async () => approve.closest("form")?.requestSubmit(approve));
    expect(action.mock.calls[0][1].get("decision")).toBe("approved");
    expect(status()).toBe("Saving…");
    await act(async () => finish({ error: null, saved: true }));
    // The page comes back with the document decided: nothing left to offer.
    await render([]);

    expect(document.activeElement?.id).toBe("document-1");
    expect(status()).toBe("Approved. Saved.");
    expect(container.querySelector('[role="group"]')).toBeNull(); // no empty button group
  });

  it("rejecting with a reason does the same", async () => {
    await render(DECISIONS);
    await act(async () => button("Reject").click());
    const reason = container.querySelector("textarea") as HTMLTextAreaElement;
    reason.value = "The photo is cropped.";
    const confirm = button("Reject with this reason");

    await act(async () => confirm.closest("form")?.requestSubmit(confirm));
    await act(async () => finish({ error: null, saved: true }));
    await render([]);

    expect(action.mock.calls[0][1].get("decision")).toBe("rejected");
    expect(document.activeElement?.id).toBe("document-1");
    expect(status()).toBe("Rejected. Saved.");
  });

  it("a refused decision keeps the buttons and the focus, and says why", async () => {
    await render(DECISIONS);
    const approve = button("Approve");
    approve.focus();

    await act(async () => approve.closest("form")?.requestSubmit(approve));
    await act(async () => finish({ error: "already_reviewed", saved: false }));

    expect(document.activeElement).toBe(approve);
    expect(status()).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Already reviewed.");
  });
});
