import i18n from "@/i18n";

import { QueryClientProvider } from "@tanstack/react-query";
import { router, Slot, useNavigationContainerRef } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { createElement, useLayoutEffect } from "react";
import { BackHandler, ScrollView, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { apiGet, useSession } from "@/api";

import AppLayout, { unstable_settings as appSettings } from "../../../app/(app)/_layout";
import { AccountScreen } from "../../account/AccountScreen";
import { METRICS } from "../../auth/__tests__/helpers";
import { HistoryScreen } from "../../history/HistoryScreen";
import { CATEGORIES, newQueryClient, signedIn } from "../../home/__tests__/helpers";
import { HomeScreen } from "../../home/HomeScreen";
import { TabsLayout } from "../TabsLayout";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiGet: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

let navigation: ReturnType<typeof useNavigationContainerRef>;
let client = newQueryClient();

function Root() {
  const container = useNavigationContainerRef();
  useLayoutEffect(() => {
    navigation = container;
  }, [container]);
  return createElement(
    SafeAreaProvider,
    { initialMetrics: METRICS },
    createElement(QueryClientProvider, { client }, createElement(Slot)),
  );
}

// The real shell: the (app) stack with its anchor, the tabs and their real screens, and two of the
// flows pushed over them as stubs.
const routes = {
  _layout: Root,
  "(app)/_layout": { default: AppLayout, unstable_settings: appSettings },
  "(app)/(tabs)/_layout": TabsLayout,
  "(app)/(tabs)/index": HomeScreen,
  "(app)/(tabs)/history": HistoryScreen,
  "(app)/(tabs)/account": AccountScreen,
  "(app)/request/new": () => <Text testID="request-start">request start</Text>,
  "(app)/requests/[id]/index": () => <Text testID="request-detail">request detail</Text>,
};

const tabs = () => screen.getAllByRole("tab");
const labels = () => tabs().map((tab) => tab.props.accessibilityLabel as string);
const selected = () => tabs().map((tab) => tab.props.accessibilityState.selected as boolean);

type RouteState = { routes: { name: string; state?: RouteState }[] };

/** The state of the first route named `name` under `state`, depth first. */
function stateOf(state: RouteState | undefined, name: string): RouteState | undefined {
  for (const route of state?.routes ?? []) {
    if (route.name === name) return route.state;
    const nested = stateOf(route.state, name);
    if (nested) return nested;
  }
  return undefined;
}

/** The route names of the (app) stack, bottom to top. */
function appStack(): string[] {
  return stateOf(navigation.getRootState(), "(app)")?.routes.map((route) => route.name) ?? [];
}

const scrollTo = ScrollView.prototype.scrollTo as jest.Mock;

beforeEach(() => {
  client = newQueryClient();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
  jest.mocked(apiGet).mockReset().mockResolvedValue(CATEGORIES);
  scrollTo.mockClear();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await act(() => i18n.changeLanguage("en"));
});

describe("the tab shell (#213, D18)", () => {
  it("tabs render three tabs in order with labels and selected state, in English and Spanish", async () => {
    const view = await renderRouter(routes, { initialUrl: "/" });

    expect(labels()).toEqual(["Home", "History", "Account"]);
    expect(selected()).toEqual([true, false, false]);
    expect(screen.getByTestId("customer-home")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("tab-history"));
    expect(view.getPathname()).toBe("/history");
    expect(selected()).toEqual([false, true, false]);
    expect(screen.getByRole("header", { name: "Your requests" })).toBeTruthy();

    await fireEvent.press(screen.getByTestId("tab-account"));
    expect(view.getPathname()).toBe("/account");
    expect(selected()).toEqual([false, false, true]);
    expect(screen.getByTestId("account-log-out")).toBeTruthy();
    expect(screen.queryByTestId("back-button")).toBeNull();

    await act(() => i18n.changeLanguage("es"));
    expect(labels()).toEqual(["Inicio", "Historial", "Cuenta"]);
  });

  it("pushed request screen covers the tab bar and Back returns to the tab", async () => {
    const view = await renderRouter(routes, { initialUrl: "/history" });
    expect(selected()).toEqual([false, true, false]);

    await act(() => router.push("/request/new"));

    expect(view.getPathname()).toBe("/request/new");
    expect(screen.getByTestId("request-start")).toBeTruthy();
    // The pushed screen is a sibling of the whole tab group in the (app) stack, over the bar.
    expect(appStack()).toEqual(["(tabs)", "request/new"]);

    await act(() => router.back());

    expect(view.getPathname()).toBe("/history");
    expect(selected()).toEqual([false, true, false]);
    expect(screen.queryByTestId("request-start")).toBeNull();
  });

  it("deep link cold start lands on the pushed screen with Home under it", async () => {
    const view = await renderRouter(routes, { initialUrl: "/requests/R" });

    expect(view.getPathname()).toBe("/requests/R");
    expect(screen.getByTestId("request-detail")).toBeTruthy();
    expect(appStack()).toEqual(["(tabs)", "requests/[id]/index"]);

    await act(() => router.back());

    expect(view.getPathname()).toBe("/");
    expect(selected()).toEqual([true, false, false]);
    expect(screen.getByTestId("customer-home")).toBeTruthy();
  });

  it.each([
    ["customer", "Browse categories", "customer-home"],
    ["pro", "Go to Home", "pro-home"],
  ] as const)("history empty state button switches to Home (%s)", async (role, cta, homeId) => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role }));
    const view = await renderRouter(routes, { initialUrl: "/history" });

    await fireEvent.press(screen.getByRole("button", { name: cta }));

    expect(view.getPathname()).toBe("/");
    expect(selected()).toEqual([true, false, false]);
    expect(screen.getByTestId(homeId)).toBeTruthy();
  });

  it("Android hardware Back on a tab other than Home goes to Home; on Home it leaves the app", async () => {
    type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: BackListener[] = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      handlers.push(handler);
      return { remove: () => handlers.splice(handlers.indexOf(handler), 1) };
    });
    // The system's dispatch: the last listener first, until one handles the press.
    const press = {} as Parameters<BackListener>[0];
    const pressBack = () => [...handlers].reverse().some((handler) => handler(press) === true);
    const view = await renderRouter(routes, { initialUrl: "/history" });

    let handled = false;
    await act(() => {
      handled = pressBack();
    });
    expect(handled).toBe(true);
    expect(view.getPathname()).toBe("/");
    expect(selected()).toEqual([true, false, false]);

    await act(() => {
      handled = pressBack();
    });
    expect(handled).toBe(false);
    expect(view.getPathname()).toBe("/");
  });

  it("tab reselect scrolls the tab's root to the top", async () => {
    await renderRouter(routes, { initialUrl: "/" });
    await screen.findByRole("button", { name: "Painting" });
    expect(scrollTo).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("tab-home"));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true }));

    await fireEvent.press(screen.getByTestId("tab-account"));
    scrollTo.mockClear();
    await fireEvent.press(screen.getByTestId("tab-account"));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true }));
  });
});
