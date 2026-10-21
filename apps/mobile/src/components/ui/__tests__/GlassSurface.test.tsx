import { act, render, screen, waitFor } from "@testing-library/react-native";
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ComponentProps } from "react";
import { AccessibilityInfo, StyleSheet, Text } from "react-native";

import { glassFallback, glassTint, tokens } from "@/theme";

import { GlassSurface } from "../GlassSurface";

// The native view becomes a View flagged `nativeGlass`, keeping every prop it was given.
jest.mock("expo-glass-effect", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return {
    GlassView: jest.fn((props) => createElement(View, { ...props, nativeGlass: true })),
    isLiquidGlassAvailable: jest.fn(() => true),
    isGlassEffectAPIAvailable: jest.fn(() => true),
  };
});

const surface = () => screen.getByTestId("surface");
const isNativeGlass = () => surface().props.nativeGlass === true;
const surfaceStyle = () => StyleSheet.flatten(surface().props.style);
const reduceTransparencyListener = () =>
  jest
    .mocked(AccessibilityInfo.addEventListener)
    .mock.calls.find(([event]) => event === "reduceTransparencyChanged")?.[1] as (
    enabled: boolean,
  ) => void;

const renderSurface = (props: Partial<ComponentProps<typeof GlassSurface>> = {}) =>
  render(
    <GlassSurface tone="light" shape="pill" testID="surface" {...props}>
      <Text>Label</Text>
    </GlassSurface>,
  );

describe("GlassSurface", () => {
  beforeEach(() => {
    jest.mocked(isLiquidGlassAvailable).mockReturnValue(true);
    jest.mocked(isGlassEffectAPIAvailable).mockReturnValue(true);
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(false);
    jest
      .mocked(AccessibilityInfo.addEventListener)
      .mockClear()
      .mockReturnValue({ remove: jest.fn() });
  });

  it("uses native glass when available and reduce transparency is off", async () => {
    await renderSurface({ interactive: true });

    await act(async () => {});
    expect(isNativeGlass()).toBe(true);
    expect(surface().props).toMatchObject({
      glassEffectStyle: "regular",
      tintColor: glassTint.light,
      colorScheme: "light",
      isInteractive: true,
    });
    expect(surfaceStyle()).toMatchObject({ borderCurve: "continuous" });
    expect(screen.getByText("Label")).toBeTruthy();
  });

  it("falls back to the solid surface when glass is unavailable", async () => {
    jest.mocked(isLiquidGlassAvailable).mockReturnValue(false);

    await renderSurface();

    await act(async () => {});
    expect(isNativeGlass()).toBe(false);
    expect(surfaceStyle()).toMatchObject({ ...glassFallback.light, borderCurve: "continuous" });
  });

  it("falls back to the solid surface when reduce transparency is on", async () => {
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(true);

    await renderSurface();

    await waitFor(() => expect(isNativeGlass()).toBe(false));
    expect(surfaceStyle()).toMatchObject(glassFallback.light);
  });

  it("switches live when reduce transparency changes", async () => {
    await renderSurface();
    await act(async () => {});
    expect(isNativeGlass()).toBe(true);

    await act(() => reduceTransparencyListener()(true));
    expect(isNativeGlass()).toBe(false);

    await act(() => reduceTransparencyListener()(false));
    expect(isNativeGlass()).toBe(true);
  });

  it.each([
    [
      "light",
      { backgroundColor: "rgba(255, 255, 255, 0.95)", shadowColor: tokens.colors["navy-900"] },
    ],
    ["dark", { backgroundColor: "rgba(11, 45, 73, 1)" }],
  ] as const)("light and dark tones use their token surfaces: %s", async (tone, expected) => {
    jest.mocked(isLiquidGlassAvailable).mockReturnValue(false);

    await renderSurface({ tone });

    await act(async () => {});
    expect(surfaceStyle()).toMatchObject(expected);
    if (tone === "dark") expect(surfaceStyle().shadowColor).toBeUndefined();
  });

  it.each(["pill", "xl", "lg"] as const)("applies the shape radius token: %s", async (shape) => {
    await renderSurface({ shape });
    await act(async () => {});
    expect(isNativeGlass()).toBe(true);
    expect(surfaceStyle()).toMatchObject({
      borderRadius: tokens.radius[shape],
      borderCurve: "continuous",
    });

    jest.mocked(isLiquidGlassAvailable).mockReturnValue(false);
    await renderSurface({ shape, className: "p-4" });
    await act(async () => {});
    expect(isNativeGlass()).toBe(false);
    expect(surfaceStyle()).toMatchObject({ borderRadius: tokens.radius[shape] });
    expect(surface().props.className).toBe("p-4");
  });
});
