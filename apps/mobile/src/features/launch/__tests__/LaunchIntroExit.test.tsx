import "@/i18n";

import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useSession } from "@/api";

import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { LaunchIntro } from "../LaunchIntro";
import { useLaunchIntro } from "../useLaunchIntro";

jest.mock("@/api", () => ({
  useSession: jest.fn(),
  logout: jest.fn(async () => undefined),
  restoreSession: jest.fn(async () => undefined),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("../useLaunchIntro", () => ({ useLaunchIntro: jest.fn() }));

const HIDDEN = { includeHiddenElements: true };
const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;

beforeEach(() => {
  jest.mocked(useSession).mockReturnValue({ ...SESSION_SIGNED_OUT, status: "signedOut" });
});

it("while running, Skip is there and the tap layer takes touches", async () => {
  jest.mocked(useLaunchIntro).mockReturnValue({ phase: "running", skip: jest.fn() });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <LaunchIntro onReady={jest.fn()} onDone={jest.fn()} />
    </SafeAreaProvider>,
  );
  expect(screen.getByRole("button", { name: "Skip intro" })).toBeTruthy();
  expect(screen.getByTestId("launch-intro").props.pointerEvents).toBe("auto");
});

it("the moment the exit starts, Skip is gone while the hero still fades: Welcome's second action lands on its row", async () => {
  jest.mocked(useLaunchIntro).mockReturnValue({ phase: "exiting", skip: jest.fn() });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <LaunchIntro onReady={jest.fn()} onDone={jest.fn()} />
    </SafeAreaProvider>,
  );
  expect(screen.queryByRole("button", { name: "Skip intro" })).toBeNull();
  expect(screen.queryByTestId("launch-hero-skip-row", HIDDEN)).toBeNull();
  expect(screen.getByTestId("launch-hero-headline", HIDDEN)).toBeTruthy();
  expect(screen.getByTestId("launch-intro").props.pointerEvents).toBe("none");
});
