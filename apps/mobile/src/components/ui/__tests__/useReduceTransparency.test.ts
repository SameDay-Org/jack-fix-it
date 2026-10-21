import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import { useReduceTransparency } from "../useReduceTransparency";

const remove = jest.fn();

describe("useReduceTransparency", () => {
  beforeEach(() => {
    remove.mockClear();
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(true);
    jest.mocked(AccessibilityInfo.addEventListener).mockClear().mockReturnValue({ remove });
  });

  it("reads the initial value and subscribes", async () => {
    const { result } = await renderHook(() => useReduceTransparency());

    await waitFor(() => expect(result.current).toBe(true));
    expect(AccessibilityInfo.addEventListener).toHaveBeenCalledWith(
      "reduceTransparencyChanged",
      expect.any(Function),
    );
  });

  it("follows the change event", async () => {
    const { result } = await renderHook(() => useReduceTransparency());
    await waitFor(() => expect(result.current).toBe(true));
    const [, onChange] = jest.mocked(AccessibilityInfo.addEventListener).mock.calls[0];

    await act(() => (onChange as (enabled: boolean) => void)(false));

    expect(result.current).toBe(false);
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
