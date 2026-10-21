import { tokens } from "@/theme";

import { dismissToast, showToast, toastStore } from "../toast";

const current = () => toastStore.getState().current;

describe("toast store", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    dismissToast();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("show sets the current toast", () => {
    showToast({ message: "Saved", tone: "success" });

    expect(current()).toMatchObject({ message: "Saved", tone: "success" });
  });

  it("a new toast replaces the current one and restarts the timer", () => {
    showToast({ message: "First", tone: "neutral" });
    jest.advanceTimersByTime(tokens.motion.toastMs / 2);
    showToast({ message: "Second", tone: "danger" });

    expect(current()).toMatchObject({ message: "Second", tone: "danger" });
    jest.advanceTimersByTime(tokens.motion.toastMs - 1); // the first toast's timer would have fired by now
    expect(current()).toMatchObject({ message: "Second" });
    jest.advanceTimersByTime(1);
    expect(current()).toBeNull();
  });

  it("auto-dismisses after motion.toastMs", () => {
    showToast({ message: "Saved", tone: "neutral" });

    jest.advanceTimersByTime(tokens.motion.toastMs - 1);
    expect(current()).not.toBeNull();
    jest.advanceTimersByTime(1);
    expect(current()).toBeNull();
  });

  it("dismiss clears it", () => {
    showToast({ message: "Saved", tone: "neutral" });

    dismissToast();

    expect(current()).toBeNull();
    jest.advanceTimersByTime(tokens.motion.toastMs);
    expect(current()).toBeNull();
  });

  it("dismissing by id ignores a toast that was already replaced", () => {
    showToast({ message: "First", tone: "neutral" });
    const first = current()!.id;
    showToast({ message: "Second", tone: "neutral" });

    dismissToast(first);

    expect(current()).toMatchObject({ message: "Second" });
  });
});
