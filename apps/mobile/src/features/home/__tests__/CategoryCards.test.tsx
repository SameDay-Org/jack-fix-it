import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import { Dimensions, StyleSheet } from "react-native";

import { apiGet } from "@/api";
import { FALLBACK_GLYPH } from "@/components/icons";
import { requestDraftStore } from "@/features/request";
import { tokens } from "@/theme";

import { deferred } from "../../../api/__tests__/helpers";
import { CARD_GAP, cardSide, nameSlotLines, nameSlotMinHeight } from "../CategoryCard";
import { CategoryCards } from "../CategoryCards";
import { CATEGORIES, renderWithQuery } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiGet: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// The 320 dp Android emulator: the panel's 16 dp inset on each side leaves a 288 dp row, and two
// cards 12 dp apart in it are 138 dp squares.
const WINDOW_WIDTH = 320;
const ROW_WIDTH = 288;
const SIDE = 138;

const HIDDEN = { includeHiddenElements: true };
const EN_NAMES = [
  "House Cleaning",
  "Handyman",
  "Painting",
  "Lawn & Landscaping",
  "Moving & Assembly",
];

const cards = () =>
  screen
    .getAllByRole("button")
    .filter((button) => String(button.props.testID).startsWith("home-category-"));
const cardNames = () => cards().map((card) => card.props.accessibilityLabel as string);
const flat = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as Parameters<typeof StyleSheet.flatten>[0]) ?? {};
const layout = (node: ReturnType<typeof screen.getByTestId>, width: number) =>
  fireEvent(node, "layout", { nativeEvent: { layout: { x: 0, y: 0, width, height: 0 } } });
const rowsOf = (gridTestID: string) =>
  screen
    .getAllByTestId(new RegExp(`^${gridTestID}-row-\\d+$`), HIDDEN)
    .map((row) => ({ row, cells: row.children.length }));

/** The numbers that decide a cell's size: the cell, its tile and its name slot. */
function geometry(cellTestID: string, innerTestID: string) {
  const cell = screen.getByTestId(cellTestID, HIDDEN);
  const tile = screen.getByTestId(`${innerTestID}-tile`, HIDDEN);
  const slot = screen.getByTestId(`${innerTestID}-name`, HIDDEN);
  const { width, minHeight, height } = flat(cell);
  const classes = String(cell.props.className)
    .split(" ")
    .filter((name) => !name.startsWith("bg-"))
    .sort();
  return {
    width,
    minHeight,
    height,
    classes,
    tile: { width: flat(tile).width, height: flat(tile).height },
    slot: { minHeight: flat(slot).minHeight, className: slot.props.className },
  };
}

const skeletonGeometry = (index: number) =>
  geometry(`home-category-skeleton-${index}-shape`, `home-category-skeleton-${index}`);
const cardGeometry = (slug: string) => geometry(`home-category-${slug}`, `home-category-${slug}`);

describe("CategoryCards", () => {
  let dimensions: jest.SpyInstance;

  const useDevice = (fontScale: number) => {
    const real = Dimensions.get("window");
    dimensions.mockReturnValue({ ...real, width: WINDOW_WIDTH, fontScale });
  };

  beforeEach(() => {
    jest.mocked(apiGet).mockReset().mockResolvedValue(CATEGORIES);
    jest.mocked(router.push).mockClear();
    requestDraftStore.setState({ categorySlug: null });
    dimensions = jest.spyOn(Dimensions, "get");
    useDevice(1);
  });

  afterEach(async () => {
    dimensions.mockRestore();
    await act(() => i18n.changeLanguage("en"));
  });

  it("renders one square card per category in the API's order, two per row", async () => {
    await renderWithQuery(<CategoryCards />);
    await screen.findByRole("button", { name: "Painting" });

    expect(cardNames()).toEqual(EN_NAMES);
    expect(rowsOf("home-categories-grid").map(({ cells }) => cells)).toEqual([2, 2, 1]);
    for (const { row } of rowsOf("home-categories-grid")) {
      expect(row.props.className).toBe("flex-row");
      expect(flat(row)).toEqual({ columnGap: CARD_GAP });
    }
    expect(flat(screen.getByTestId("home-categories-grid"))).toEqual({ rowGap: CARD_GAP });
    for (const card of cards()) {
      expect(flat(card)).toMatchObject({ width: SIDE, minHeight: SIDE, borderCurve: "continuous" });
      expect(flat(card).height).toBeUndefined();
    }
    expect(cardSide(ROW_WIDTH)).toBe(SIDE);
  });

  it("the card side follows the measured row, not the window", async () => {
    const real = Dimensions.get("window");
    dimensions.mockReturnValue({ ...real, width: 360, fontScale: 1 });
    await renderWithQuery(<CategoryCards />);
    await screen.findByRole("button", { name: "Painting" });

    // Before the row reports, the first frame sizes from the window minus the panel inset.
    expect(flat(cards()[0]).width).toBe(cardSide(360 - 32));

    await layout(screen.getByTestId("home-categories-grid"), ROW_WIDTH);

    for (const card of cards()) {
      expect(flat(card)).toMatchObject({ width: SIDE, minHeight: SIDE });
    }
  });

  it("each card shows the category icon and the localized name", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<CategoryCards />);
    await screen.findByRole("button", { name: "Pintura" });

    const expected: Record<string, string> = {
      "house-cleaning": "Limpieza del hogar",
      handyman: "Reparaciones generales",
      painting: "Pintura",
      "lawn-landscaping": "Jardinería y paisajismo",
      "moving-assembly": "Moving & Assembly",
    };
    for (const [slug, name] of Object.entries(expected)) {
      const card = screen.getByTestId(`home-category-${slug}`);
      const text = within(card).getByText(name, HIDDEN);
      expect(text.props.numberOfLines).toBe(3);
      expect(text.props.android_hyphenationFrequency).toBe("normal");
      const icons = card.queryAll((node) => node.type === "RNSVGSvgView");
      expect(icons).toHaveLength(1);
      expect(icons[0].props).toMatchObject({ width: 32, height: 32 });
      expect(flat(screen.getByTestId(`home-category-${slug}-tile`))).toMatchObject({
        width: 56,
        height: 56,
        borderRadius: tokens.radius.md,
      });
    }
  });

  it("an unknown slug renders the fallback tile, not a crash", async () => {
    jest.mocked(apiGet).mockResolvedValue([
      ...CATEGORIES,
      {
        ...CATEGORIES[0],
        id: "00000000-0000-4000-8000-0000000000ff",
        slug: "plumbing",
        names: { en: "Plumbing" },
      },
    ]);
    await renderWithQuery(<CategoryCards />);

    const card = await screen.findByRole("button", { name: "Plumbing" });
    expect(cardNames()).toEqual([...EN_NAMES, "Plumbing"]);
    expect(rowsOf("home-categories-grid").map(({ cells }) => cells)).toEqual([2, 2, 2]);
    const strokes = card
      .queryAll((node) => node.type === "RNSVGPath" && node.props.stroke != null)
      .map((node) => node.props.d);
    expect(strokes).toEqual(FALLBACK_GLYPH.strokes);
    expect(flat(screen.getByTestId("home-category-plumbing-tile"))).toMatchObject({
      width: 56,
      height: 56,
    });
  });

  it("pressing a card starts a request for its slug", async () => {
    await renderWithQuery(<CategoryCards />);

    await fireEvent.press(await screen.findByRole("button", { name: "Lawn & Landscaping" }));

    expect(requestDraftStore.getState().categorySlug).toBe("lawn-landscaping");
    expect(router.push).toHaveBeenCalledWith("/request/new");
  });

  it("a pressed card shrinks through its style, not a class", async () => {
    await renderWithQuery(<CategoryCards />);
    const card = await screen.findByRole("button", { name: "Painting" });
    const restingClass = card.props.className;

    await fireEvent(card, "pressIn");

    expect(flat(card).transform).toEqual([{ scale: tokens.motion.pressedScale }]);
    expect(card.props.className).toBe(restingClass);

    await fireEvent(card, "pressOut");

    expect(flat(card).transform).toBeUndefined();
  });

  it("the card is one accessible button labeled with the category name; the icon is hidden", async () => {
    await renderWithQuery(<CategoryCards />);
    const card = await screen.findByRole("button", { name: "Painting" });

    expect(card.props.testID).toBe("home-category-painting");
    expect(screen.getAllByRole("button", { name: "Painting" })).toHaveLength(1);
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    const icon = card.queryAll((node) => node.type === "RNSVGSvgView")[0];
    expect(icon.props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    });
    expect(within(card).queryByTestId("home-category-painting-tile")).toBeTruthy();
  });

  it.each([
    { language: "en", fontScale: 1 },
    { language: "en", fontScale: 1.3 },
    { language: "es", fontScale: 1 },
    { language: "es", fontScale: 1.3 },
  ])(
    "loading skeletons fill the same grid cells as the cards ($language, font scale $fontScale)",
    async ({ language, fontScale }) => {
      useDevice(fontScale);
      await act(() => i18n.changeLanguage(language));
      const pending = deferred<typeof CATEGORIES>();
      jest.mocked(apiGet).mockReturnValue(pending.promise);
      await renderWithQuery(<CategoryCards />);

      expect(
        screen.getByRole("progressbar", { name: i18n.t("home.categoriesLoading") }),
      ).toBeTruthy();
      await layout(screen.getByTestId("home-categories-skeleton-grid", HIDDEN), ROW_WIDTH);
      const skeletonRows = rowsOf("home-categories-skeleton-grid").map(({ cells }) => cells);
      const skeletons = [0, 1, 2, 3, 4].map(skeletonGeometry);

      await act(async () => pending.resolve(CATEGORIES));
      await waitFor(() => expect(cardNames()).toHaveLength(5));

      // The measured row outlives the skeleton grid, so the cards need no second measurement.
      const cardRows = rowsOf("home-categories-grid").map(({ cells }) => cells);
      const loaded = CATEGORIES.map((category) => cardGeometry(category.slug));
      expect(cardRows).toEqual(skeletonRows);
      expect(loaded).toEqual(skeletons);
      for (const cell of loaded) {
        expect(cell).toMatchObject({
          width: SIDE,
          minHeight: SIDE,
          height: undefined,
          slot: { minHeight: nameSlotMinHeight(SIDE, fontScale), className: "justify-end" },
        });
      }
    },
  );

  it.each([
    // [window width, font scale, lines]: the slot is the card side less the 12 dp inset on each side.
    [320, 1, 2], // 114 dp holds "Reparaciones" (104 dp)
    [320, 1.3, 3], // 114 dp cannot hold it at 1.3 (about 135 dp): the third line is reserved
    [360, 1, 2],
    [393, 1.3, 2], // 150 dp holds it at 1.3
  ])(
    "the name slot of a %i dp window at font scale %s reserves %i lines",
    (width, fontScale, lines) => {
      expect(nameSlotLines(cardSide(width - 32), fontScale)).toBe(lines);
      expect(nameSlotMinHeight(cardSide(width - 32), fontScale)).toBe(lines * 24 * fontScale);
    },
  );

  it("the slot's longest-word constant still names the catalog's longest word", () => {
    // LONGEST_WORD_WIDTH in CategoryCard.tsx measures "Reparaciones"; a longer seeded word must
    // update it. The fixture mirrors the seed's names.
    const words = CATEGORIES.flatMap((category) => Object.values(category.names)).flatMap((name) =>
      name.split(" "),
    );
    const longest = words.reduce((best, word) => (word.length > best.length ? word : best), "");
    expect(longest).toBe("Reparaciones");
    expect(cardSide(0)).toBe(0);
  });

  it("rows grow together when a name needs more lines (at 1.3)", async () => {
    useDevice(1.3);
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<CategoryCards />);
    await screen.findByRole("button", { name: "Pintura" });

    // Every card keeps a fixed width and a square minimum, never a fixed height, so a third line
    // grows its card; a row has no cross-axis alignment of its own, so the row's other card
    // stretches to the same height.
    const slot = nameSlotMinHeight(SIDE, 1.3);
    expect(slot).toBeGreaterThan(nameSlotMinHeight(SIDE, 1));
    for (const { row } of rowsOf("home-categories-grid")) {
      expect(flat(row).alignItems).toBeUndefined();
      for (const card of row.children) {
        if (typeof card !== "object" || card === null) continue;
        expect(flat(card)).toMatchObject({ width: SIDE, minHeight: SIDE });
        expect(flat(card).height).toBeUndefined();
      }
    }
    for (const category of CATEGORIES) {
      expect(cardGeometry(category.slug).slot.minHeight).toBe(slot);
    }
  });
});
