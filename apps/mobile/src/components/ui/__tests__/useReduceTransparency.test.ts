import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import { useReduceTransparency } from "../useReduceTransparency";

const remove = jest.fn();

/** A promise the test settles by hand, to order the read against the change event. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const changeListener = () =>
  jest.mocked(AccessibilityInfo.addEventListener).mock.calls[0][1] as (enabled: boolean) => void;

describe("useReduceTransparency", () => {
  beforeEach(() => {
    remove.mockClear();
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(true);
    jest.mocked(AccessibilityInfo.addEventListener).mockClear().mockReturnValue({ remove });
  });

  it("is unknown until the read answers, then reads the initial value and subscribes", async () => {
    const read = deferred<boolean>();
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(read.promise);

    const { result } = await renderHook(() => useReduceTransparency());

    expect(result.current).toBeNull();
    expect(AccessibilityInfo.addEventListener).toHaveBeenCalledWith(
      "reduceTransparencyChanged",
      expect.any(Function),
    );
    await act(async () => read.resolve(true));
    expect(result.current).toBe(true);
  });

  it("follows the change event", async () => {
    const { result } = await renderHook(() => useReduceTransparency());
    await waitFor(() => expect(result.current).toBe(true));

    await act(() => changeListener()(false));

    expect(result.current).toBe(false);
  });

  it("a late initial read never overwrites a change event", async () => {
    const read = deferred<boolean>();
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(read.promise);
    const { result } = await renderHook(() => useReduceTransparency());

    await act(() => changeListener()(true));
    expect(result.current).toBe(true);
    await act(async () => read.resolve(false));

    expect(result.current).toBe(true);
  });

  it("a rejected read resolves to the safe value", async () => {
    const read = deferred<boolean>();
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(read.promise);
    const { result } = await renderHook(() => useReduceTransparency());

    await act(async () => read.reject(new Error("unavailable")));

    expect(result.current).toBe(true);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = await renderHook(() => useReduceTransparency());

    await unmount();

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("treats a missing iOS-only API as off", async () => {
    const query = AccessibilityInfo.isReduceTransparencyEnabled;
    // Android ships no isReduceTransparencyEnabled; the hook must not call undefined.
    (AccessibilityInfo as { isReduceTransparencyEnabled?: unknown }).isReduceTransparencyEnabled =
      undefined;
    try {
      const { result } = await renderHook(() => useReduceTransparency());

      await act(async () => {});
      expect(result.current).toBe(false);
    } finally {
      AccessibilityInfo.isReduceTransparencyEnabled = query;
    }
  });
});
