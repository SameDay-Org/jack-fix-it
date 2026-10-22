import { render, screen } from "@testing-library/react-native";
import { StatusBar } from "expo-status-bar";
import type { ReactElement } from "react";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Screen } from "../Screen";

// The StatusBar renders no host view, so the mock exposes the props it was given.
jest.mock("expo-status-bar", () => ({ StatusBar: jest.fn(() => null) }));
jest.mock("react-native-safe-area-context", () => {
  const mock = jest.requireActual("react-native-safe-area-context/jest/mock").default;
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  // A plain View keeps the `edges` prop readable instead of the native edge map.
  return { ...mock, SafeAreaView: (props: object) => createElement(View, props) };
});

const METRICS = {
  frame: { x: 0, y: 0, width: 320, height: 640 },
  insets: { top: 24, right: 0, bottom: 16, left: 0 },
};

const renderScreen = (ui: ReactElement) =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>);

const statusBarStyle = () => jest.mocked(StatusBar).mock.lastCall?.[0].style;

describe("Screen", () => {
  beforeEach(() => jest.mocked(StatusBar).mockClear());

  it("hero bar: light status icons over a navy-900 backdrop as tall as the top inset", async () => {
    await renderScreen(
      <Screen bar="hero">
        <Text>Body</Text>
      </Screen>,
    );

    expect(statusBarStyle()).toBe("light");
    const backdrop = screen.getByTestId("system-bar-backdrop");
    expect(backdrop.props.className).toContain("bg-navy-900");
    expect(backdrop.props.style).toMatchObject({ height: 24 });
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("the page under a hero bar is navy at its very first layer (a hero fading over a hero stays navy)", async () => {
    await renderScreen(
      <Screen bar="hero" testID="hero-screen">
        <Text>Body</Text>
      </Screen>,
    );
    expect(screen.getByTestId("hero-screen").props.className).toContain("bg-navy-900");
    expect(screen.getByTestId("hero-screen").props.className).not.toContain("bg-gray-50");

    await renderScreen(
      <Screen bar="light" testID="light-screen">
        <Text>Body</Text>
      </Screen>,
    );
    expect(screen.getByTestId("light-screen").props.className).toContain("bg-gray-50");
  });

  it("light bar: dark status icons over a gray-50 backdrop", async () => {
    await renderScreen(
      <Screen bar="light">
        <Text>Body</Text>
      </Screen>,
    );

    expect(statusBarStyle()).toBe("dark");
    expect(screen.getByTestId("system-bar-backdrop").props.className).toContain("bg-gray-50");
  });

  it("statusBar sets only the icons: the page and its backdrop stay the bar's", async () => {
    await renderScreen(
      <Screen bar="light" statusBar="hero" testID="page">
        <Text>Body</Text>
      </Screen>,
    );

    expect(statusBarStyle()).toBe("light"); // the hero's icons, still showing above
    expect(screen.getByTestId("system-bar-backdrop").props.className).toContain("bg-gray-50");
    expect(screen.getByTestId("page").props.className).toContain("bg-gray-50");
  });

  it("ownsStatusBar false renders no StatusBar (a screen built ahead of time)", async () => {
    await renderScreen(
      <Screen bar="light" ownsStatusBar={false}>
        <Text>Body</Text>
      </Screen>,
    );

    expect(StatusBar).not.toHaveBeenCalled();
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("edges defaults to bottom", async () => {
    await renderScreen(
      <Screen bar="light" testID="screen">
        <Text>Body</Text>
      </Screen>,
    );

    expect(screen.getByTestId("screen").props.edges).toEqual(["bottom"]);
  });

  it("edges can be overridden", async () => {
    await renderScreen(
      <Screen bar="light" edges={[]} testID="screen">
        <Text>Body</Text>
      </Screen>,
    );

    expect(screen.getByTestId("screen").props.edges).toEqual([]);
  });
});
