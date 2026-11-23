import i18n from "@/i18n";

import { act, screen, waitFor, within } from "@testing-library/react-native";

import { apiGet } from "@/api";

import type { Category } from "../../home/useCategories";
import { asIntakeAnswer } from "../../request/AnswerList";
import { QUESTIONS } from "../../request/__tests__/helpers";
import { OpportunityDetailScreen } from "../OpportunityDetailScreen";
import type { OpportunityDetail } from "../useOpportunity";
import { detail, freezeClock, navigation, renderWithQuery } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const CATALOG = "/v1/categories";

/** The opportunity's category (painting, the same id) with a question of each type. */
const PAINTING: Category = {
  id: "00000000-0000-4000-8000-000000000003",
  slug: "painting",
  names: { en: "Painting", es: "Pintura" },
  icon: null,
  requires_license: false,
  intake_questions: [
    QUESTIONS.rooms,
    QUESTIONS.surface,
    QUESTIONS.extras,
    QUESTIONS.notes,
    QUESTIONS.furnished,
  ],
};

const ANSWERS = {
  // In another order than the questions: the list follows the category's order.
  furnished: true,
  extras: ["doors", "trim"],
  surface: "walls",
  rooms: 3,
  notes: "  Soft white, like the hallway.  ",
  // A key the category no longer asks: not listed.
  retired: "anything",
};

let opportunity: OpportunityDetail;
let catalog: Category[];

const catalogCalls = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === CATALOG);
const rows = () =>
  screen.queryAllByTestId(/^opportunity-answer-/).map((row) =>
    within(row)
      .queryAllByText(/./)
      .map((text) => text.props.children as string),
  );

beforeEach(() => {
  freezeClock();
  navigation.reset();
  opportunity = detail({ intake_answers: ANSWERS });
  catalog = [PAINTING];
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async (path: string) =>
      path === CATALOG ? catalog : opportunity) as unknown as typeof apiGet);
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("the opportunity's answers (#468)", () => {
  it("lists the customer's answers under their questions, in the category's order", async () => {
    await renderWithQuery(<OpportunityDetailScreen />);
    expect(await screen.findByRole("header", { name: "Their answers" })).toBeTruthy();
    expect(rows()).toEqual([
      ["How many rooms?", "3"],
      ["What needs painting?", "Walls"],
      ["Anything else?", "Doors, Trim"],
      ["Colors you have in mind", "Soft white, like the hallway."],
      ["Is the room furnished?", "Yes"],
    ]);
    // With the description, before the photos.
    const body = screen.getByTestId("opportunity-body");
    const order = within(body)
      .queryAllByTestId(/^opportunity-(description|answers|media.*)$/)
      .map((node) => node.props.testID as string);
    expect(order.indexOf("opportunity-description")).toBeLessThan(
      order.indexOf("opportunity-answers"),
    );
  });

  it("speaks Spanish: the labels and the options as the category writes them", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<OpportunityDetailScreen />);
    expect(await screen.findByRole("header", { name: "Sus respuestas" })).toBeTruthy();
    expect(rows()).toEqual([
      ["¿Cuántas habitaciones?", "3"],
      ["¿Qué hay que pintar?", "Paredes"],
      ["¿Algo más?", "Puertas, Molduras"],
      ["Colores que tienes en mente", "Soft white, like the hallway."],
      ["¿La habitación tiene muebles?", "Sí"],
    ]);
  });

  it("an optional question left empty, or a no, reads as the customer left it", async () => {
    opportunity = detail({ intake_answers: { rooms: 2, surface: "ceiling", furnished: false } });
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByRole("header", { name: "Their answers" });
    expect(rows()).toEqual([
      ["How many rooms?", "2"],
      ["What needs painting?", "Ceiling"],
      ["Is the room furnished?", "No"],
    ]);
  });

  it("no answers: no section, and the categories are not asked for", async () => {
    opportunity = detail({ intake_answers: {} });
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByTestId("opportunity-description");
    expect(screen.queryByTestId("opportunity-answers")).toBeNull();
    expect(catalogCalls()).toHaveLength(0);
  });

  it("a category the catalog no longer lists shows no section rather than unnamed answers", async () => {
    catalog = [];
    await renderWithQuery(<OpportunityDetailScreen />);
    await screen.findByTestId("opportunity-description");
    await waitFor(() => expect(catalogCalls()).toHaveLength(1));
    expect(screen.queryByTestId("opportunity-answers")).toBeNull();
  });
});

describe("asIntakeAnswer", () => {
  it("keeps what an answer can be, and nothing else", () => {
    expect(asIntakeAnswer(3)).toBe(3);
    expect(asIntakeAnswer("walls")).toBe("walls");
    expect(asIntakeAnswer(false)).toBe(false);
    expect(asIntakeAnswer(["a", "b"])).toEqual(["a", "b"]);
    expect(asIntakeAnswer(["a", 1])).toBeUndefined();
    expect(asIntakeAnswer({ a: 1 })).toBeUndefined();
    expect(asIntakeAnswer(null)).toBeUndefined();
  });
});
