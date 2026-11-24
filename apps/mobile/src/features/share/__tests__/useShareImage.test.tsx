import { act, renderHook } from "@testing-library/react-native";
import { shareAsync } from "expo-sharing";

import type { ShareCapture, ShareHandle } from "@/components/ui";

import { useShareImage } from "../useShareImage";

jest.mock("@/api", () => ({
  sessionGeneration: () => 1,
  isCurrentGeneration: (generation: number) => generation === 1,
}));
// expo-sharing: the root manual mock (apps/mobile/__mocks__), the sheet "available".
const TEXTS = { dialogTitle: "Share your receipt", failed: "We couldn't share the receipt." };

beforeEach(() => {
  jest.mocked(shareAsync).mockReset().mockResolvedValue(undefined);
});

describe("useShareImage", () => {
  it("two taps before the screen redraws open one share sheet", async () => {
    const discard = jest.fn();
    const capture = jest.fn(async (): Promise<ShareCapture> => ({
      uri: "file:///cache/receipt-share/receipt-1.png",
      width: 1080,
      height: 2400,
      discard,
    }));
    const render = { current: { capture } satisfies ShareHandle };
    const { result } = await renderHook(() => useShareImage(render, TEXTS));

    // Both taps reach the hook as drawn (not sharing yet): the in-flight check ignores the second.
    const drawn = result.current;
    await act(async () => {
      await Promise.all([drawn.share(), drawn.share()]);
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(shareAsync).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(result.current.sharing).toBe(false);
  });
});
