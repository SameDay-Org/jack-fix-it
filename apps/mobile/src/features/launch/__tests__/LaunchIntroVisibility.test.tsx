import "@/i18n";

import { act, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useSession } from "@/api";

import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";
import { resetHeroMeasurementsForTests } from "../BrandHero";
import { LaunchIntro } from "../LaunchIntro";
import { layOutHero, measureRotatorWords } from "./helpers";

jest.mock("@/api", () => ({
  useSession: jest.fn(),
  logout: jest.fn(async () => undefined),
  restoreSession: jest.fn(async () => undefined),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// No expo-router testing library here, so Reanimated is real and keeps the live animated style
// on the host element (`jestAnimatedStyle`); the intro's visibility gate is a shared value.

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_SIGNED_OUT } = SIGNED_OUT;
const opacity = () =>
  (screen.getByTestId("launch-intro").props.jestAnimatedStyle as { value: { opacity: number } })
    .value.opacity;

beforeEach(() => {
  jest.useFakeTimers();
  resetHeroMeasurementsForTests();
  jest.mocked(useSession).mockReturnValue({ ...SESSION_SIGNED_OUT, status: "signedOut" });
});
afterEach(() => jest.useRealTimers());

it("paints nothing until every word is measured and the hero's rows are laid out, then shows at once", async () => {
  const onReady = jest.fn();
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <LaunchIntro onReady={onReady} onDone={jest.fn()} />
    </SafeAreaProvider>,
  );
  expect(opacity()).toBe(0);
  expect(onReady).not.toHaveBeenCalled();

  // Every word measured, but the hero's rows not yet laid out natively: still nothing.
  await measureRotatorWords();
  await act(async () => jest.advanceTimersByTime(16));
  expect(opacity()).toBe(0);
  expect(onReady).not.toHaveBeenCalled();

  await layOutHero();
  await act(async () => jest.advanceTimersByTime(16)); // one frame: the style picks up the gate

  expect(opacity()).toBe(1);
  expect(onReady).toHaveBeenCalledTimes(1);
});
