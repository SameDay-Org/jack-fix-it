import { render } from "@testing-library/react-native";
import { Stack } from "expo-router";

import { useSession } from "@/api";

import AppLayout from "../../../app/(app)/_layout";
import { requestFlowOptions } from "../rise";

jest.mock("@/api", () => ({
  useSession: jest.fn(),
  // The phone flow registers its sign-out cleanup on import.
  onSignOut: jest.fn(() => () => undefined),
}));
// Tapped pushes (#323) have their own suite; this one renders the layout without a router.
jest.mock("@/features/notifications", () => ({ useOpenPushTaps: jest.fn() }));
jest.mock("expo-router", () => {
  const Stack = ({ children }: { children?: unknown }) => children ?? null;
  Stack.Screen = jest.fn(() => null);
  return { Stack };
});

describe("the (app) layout", () => {
  it("gives the request flow the options its start decides (the panel rise from Home)", async () => {
    jest
      .mocked(useSession)
      .mockReturnValue({ status: "signedIn" } as ReturnType<typeof useSession>);

    await render(<AppLayout />);

    expect(jest.mocked(Stack.Screen).mock.calls.map(([props]) => props)).toContainEqual({
      name: "request/(flow)",
      options: requestFlowOptions,
    });
  });
});
