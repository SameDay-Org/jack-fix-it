import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactElement } from "react";
import * as ReactNative from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import HelpRoute from "@/app/(app)/help";
import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

import { METRICS } from "../../../auth/__tests__/helpers";
import { FAQ } from "../faq";
import { HelpScreen } from "../HelpScreen";

// The route comes through the account barrel, whose other screens read the session.
jest.mock("@/api", () => ({ useSession: jest.fn(), logout: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const renderScreen = (ui: ReactElement = <HelpScreen />) =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>);

const question = (name: string) => screen.getByRole("button", { name });
const expanded = (name: string) => question(name).props.accessibilityState.expanded;
const headers = () =>
  screen.getAllByRole("header").map((header) => header.props.children as string);

const { faq } = en.help;

afterEach(async () => {
  await i18n.changeLanguage("en");
  jest.restoreAllMocks();
});

describe("HelpScreen", () => {
  it("opens from its route with the intro and the four sections, in order", async () => {
    await renderScreen(<HelpRoute />);

    expect(headers()).toEqual([
      "Support when you need it",
      "Booking and quotes",
      "Payments",
      "During the job",
      "Account and safety",
    ]);
    expect(screen.getByText(en.help.intro)).toBeOnTheScreen();
  });

  it("lists every question as a collapsed button, top to bottom, and nothing else to press", async () => {
    await renderScreen();

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      "Back",
      ...FAQ.map(({ id }) => faq[id].question),
    ]);
    // Part 2 brings the way to reach the team: until then there is no link and no closing block.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    for (const button of buttons.slice(1)) {
      expect(button.props.accessibilityState).toEqual({ expanded: false });
    }
    // A shut question's answer is not in the tree at all, hidden elements included.
    for (const { id } of FAQ) {
      expect(screen.queryByText(faq[id].answer, { includeHiddenElements: true })).toBeNull();
    }
  });

  it("shows a question's answer once it is expanded, and says so", async () => {
    await renderScreen();

    await fireEvent.press(question(faq.whenPay.question));

    expect(expanded(faq.whenPay.question)).toBe(true);
    expect(screen.getByText(faq.whenPay.answer)).toBeOnTheScreen();
  });

  it("keeps one question open at a time, across sections", async () => {
    await renderScreen();

    await fireEvent.press(question(faq.request.question));
    await fireEvent.press(question(faq.problem.question));

    expect(expanded(faq.request.question)).toBe(false);
    expect(expanded(faq.problem.question)).toBe(true);
    expect(screen.getByText(faq.problem.answer)).toBeOnTheScreen();
    // The first answer folds away, then leaves the tree.
    await waitFor(() => expect(screen.queryByText(faq.request.answer)).toBeNull());
    expect(
      screen.getAllByRole("button").filter((button) => button.props.accessibilityState?.expanded),
    ).toHaveLength(1);
  });

  it("closes the open question on a second tap", async () => {
    await renderScreen();

    await fireEvent.press(question(faq.chat.question));
    await fireEvent.press(question(faq.chat.question));

    expect(expanded(faq.chat.question)).toBe(false);
    await waitFor(() => expect(screen.queryByText(faq.chat.answer)).toBeNull());
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");

    await renderScreen();
    await fireEvent.press(question(es.help.faq.cancel.question));

    expect(headers()).toEqual([
      "Apoyo cuando lo necesites",
      "Reservas y presupuestos",
      "Pagos",
      "Durante el trabajo",
      "Cuenta y seguridad",
    ]);
    expect(screen.getByText(es.help.faq.cancel.answer)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Atrás" })).toBeOnTheScreen();
  });

  // Jest lays nothing out: that no line is clipped at 2.0 is the emulator's proof (PR evidence).
  // This pins what makes it possible: no text opts out of the system font size or caps its lines.
  it("renders at font scale 2.0 on a 320 dp phone with no text capped or held back", async () => {
    jest.spyOn(ReactNative.PixelRatio, "getFontScale").mockReturnValue(2);
    jest
      .spyOn(ReactNative, "useWindowDimensions")
      .mockReturnValue({ width: 320, height: 640, scale: 1, fontScale: 2 });

    await renderScreen();
    await fireEvent.press(question(faq.problem.question));

    expect(screen.getByText(faq.problem.answer)).toBeOnTheScreen();
    const back = screen.getByTestId("back-button");
    const texts = screen
      .getByTestId("help-screen")
      .queryAll((node) => node.type === "Text")
      // The Back pill's label is one line by the kit's contract.
      .filter((text) => !back.queryAll((node) => node === text).length);
    expect(texts.length).toBeGreaterThan(FAQ.length);
    for (const text of texts) {
      expect(text.props.numberOfLines).toBeUndefined();
      expect(text.props.allowFontScaling).not.toBe(false);
      expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    }
  });
});
