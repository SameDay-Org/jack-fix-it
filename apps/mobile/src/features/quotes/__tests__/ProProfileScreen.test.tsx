import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";

import { ApiError, apiGet, NetworkError } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { ProProfileScreen } from "../ProProfileScreen";
import type { ProPublicProfile } from "../useProProfile";
import { quotesQueryKey, type CustomerQuote, type CustomerQuoteList } from "../useRequestQuotes";
import {
  fakeClock,
  freezeClock,
  navigation,
  newQueryClient,
  NOW,
  quote,
  QUOTES,
  renderWithQuery,
  REQUEST_ID,
} from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
}));
// The route's params: the request and María's quote (QUOTES[1]).
jest.mock("expo-router", () => {
  const helpers = jest.requireActual<typeof import("./helpers")>("./helpers");
  return {
    ...helpers.routerMock,
    useLocalSearchParams: () => ({ id: helpers.REQUEST_ID, quoteId: helpers.QUOTES[1].id }),
  };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const [, MARIA, DAN] = QUOTES;
const PATH = "/v1/requests/{request_id}/quotes/{quote_id}/pro";
const BIO = "Licensed plumber. Kitchens and bathrooms, same day when I can. Reach me at [hidden].";
const TRUST =
  "Verified by Jack Fix It: our team reviewed this pro's information and documents and approved their profile before they could send you a quote.";
const PROFILE: ProPublicProfile = {
  id: MARIA.pro.id,
  name: "María P.",
  rating_avg: "4.80",
  jobs_count: 23,
  years_of_experience: 8,
  verified: true,
  bio: BIO,
  categories: [
    {
      id: "00000000-0000-4000-8000-000000000301",
      slug: "handyman",
      names: { en: "Handyman", es: "Reparaciones" },
    },
    {
      id: "00000000-0000-4000-8000-000000000302",
      slug: "painting",
      names: { en: "Painting", es: "Pintura" },
    },
  ],
  member_since: "2024-03-01",
};
const list = (items: CustomerQuote[]): CustomerQuoteList => ({ items });
const accepted = (item: CustomerQuote): CustomerQuote => ({ ...item, status: "accepted" });

/** The screen over a cache holding the comparison list, as when a card pushed it; `null` for none. */
async function renderOver(items: CustomerQuote[] | null = QUOTES) {
  const client = newQueryClient();
  if (items) client.setQueryData(quotesQueryKey(REQUEST_ID), list(items));
  const { unmount } = await renderWithQuery(<ProProfileScreen />, client);
  return { client, unmount };
}

/** Every visible text, top to bottom. */
const texts = () =>
  screen.getAllByText(/.+/).map((node) => String(node.props.children).replaceAll(" ", " "));

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(apiGet).mockReset().mockResolvedValue(PROFILE);
  jest.mocked(router.push).mockClear();
  jest.mocked(router.back).mockClear();
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("ProProfileScreen", () => {
  it("shows every field as one page, in reading order, for exactly this quote's pro", async () => {
    await renderOver();
    expect(await screen.findByRole("header", { name: "María P." })).toBeTruthy();

    expect(apiGet).toHaveBeenCalledWith(PATH, {
      auth: true,
      signal: expect.any(AbortSignal),
      params: { request_id: REQUEST_ID, quote_id: MARIA.id },
    });
    // The figures read as one sentence; the tags by their names; the icons say nothing.
    expect(screen.getByTestId("pro-profile-figures").props.accessibilityLabel).toBe(
      "Rated 4.8, 23 jobs done, 8 years of experience",
    );
    expect(screen.getByLabelText("Handyman")).toBeTruthy();
    expect(screen.getByLabelText("Painting")).toBeTruthy();
    expect(screen.getByRole("header", { name: "About" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "What they do" })).toBeTruthy();
    expect(screen.queryByTestId(/card/)).toBeNull();
    // One pass, top to bottom: who and since when, the figures, what they say, what they do,
    // what verified means, then the bar.
    expect(texts()).toEqual([
      "Back",
      "María P.",
      "Verified by Jack Fix It",
      "Member since March 2024",
      "4.8 ★",
      "rating",
      "23",
      "jobs done",
      "8",
      "years of experience",
      "About",
      BIO,
      "What they do",
      "Handyman",
      "Painting",
      TRUST,
      "Accept for $250",
      "Back to quotes",
    ]);
  });

  it("singular and plural figures, and a rating still to come", async () => {
    jest.mocked(apiGet).mockResolvedValue({ ...PROFILE, jobs_count: 1, years_of_experience: 1 });
    const { unmount } = await renderOver();
    expect(await screen.findByText("job done")).toBeTruthy();
    expect(screen.getByText("year of experience")).toBeTruthy();
    expect(screen.getByTestId("pro-profile-figures").props.accessibilityLabel).toBe(
      "Rated 4.8, 1 job done, 1 year of experience",
    );
    await unmount();

    // Jobs done but no review yet: the rating's place says so, and no years when none were given.
    jest.mocked(apiGet).mockResolvedValue({
      ...PROFILE,
      rating_avg: null,
      jobs_count: 12,
      years_of_experience: null,
    });
    await renderOver();
    expect(await screen.findByText("no ratings yet")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/of experience/)).toBeNull();
    expect(screen.getByTestId("pro-profile-figures").props.accessibilityLabel).toBe(
      "No ratings yet, 12 jobs done",
    );
  });

  it("a pro with no job done here yet is introduced in words, with the years when given", async () => {
    jest.mocked(apiGet).mockResolvedValue({ ...PROFILE, jobs_count: 0, rating_avg: null });
    const { unmount } = await renderOver();

    expect(
      await screen.findByText(
        "María P. is new to Jack Fix It. They joined in March 2024 and haven't completed a job here yet. Like every pro on Jack Fix It, they were verified before they could send you a quote.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("rating")).toBeNull();
    expect(screen.queryByText(/jobs? done/)).toBeNull();
    expect(screen.getByText("years of experience")).toBeTruthy();
    expect(screen.getByTestId("pro-profile-figures").props.accessibilityLabel).toBe(
      "8 years of experience",
    );
    await unmount();

    // A withheld name, no bio, no years, no categories and no badge leave nothing empty.
    jest.mocked(apiGet).mockResolvedValue({
      ...PROFILE,
      name: null,
      bio: null,
      years_of_experience: null,
      jobs_count: 0,
      rating_avg: null,
      categories: [],
      verified: false,
    });
    await renderOver();
    expect(await screen.findByRole("header", { name: "Jack pro" })).toBeTruthy();
    expect(
      screen.getByText(
        "This pro is new to Jack Fix It. They joined in March 2024 and haven't completed a job here yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("pro-profile-figures")).toBeNull();
    expect(screen.queryByRole("header", { name: "About" })).toBeNull();
    expect(screen.queryByRole("header", { name: "What they do" })).toBeNull();
    expect(screen.queryByText("Verified by Jack Fix It")).toBeNull();
    expect(screen.queryByTestId("pro-profile-trust")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Accept the quote from Jack pro for $250" }),
    ).toBeTruthy();
  });

  it("the copy, the month and the categories follow the app's language", async () => {
    await renderOver();
    expect(await screen.findByText("Member since March 2024")).toBeTruthy();

    await act(() => i18n.changeLanguage("es"));
    expect(screen.getByText("Miembro desde marzo de 2024")).toBeTruthy();
    expect(screen.getByText("calificación")).toBeTruthy();
    expect(screen.getByText("trabajos hechos")).toBeTruthy();
    expect(screen.getByText("años de experiencia")).toBeTruthy();
    expect(screen.getByLabelText("Reparaciones")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Qué hace" })).toBeTruthy();
    expect(screen.getByText("Verificado por Jack Fix It")).toBeTruthy();
    expect(screen.getByText(/^Verificado por Jack Fix It: nuestro equipo/)).toBeTruthy();
    expect(screen.getByText(/^Aceptar por /)).toBeTruthy();
    expect(screen.getByText("Ver presupuestos")).toBeTruthy();
  });

  it("the new-pro note in Spanish is written for a person, not translated word for word", async () => {
    jest.mocked(apiGet).mockResolvedValue({ ...PROFILE, jobs_count: 0 });
    await renderOver();
    await screen.findByRole("header", { name: "María P." });

    await act(() => i18n.changeLanguage("es"));
    expect(
      screen.getByText(
        "María P. acaba de llegar a Jack Fix It. Se unió en marzo de 2024 y todavía no ha completado ningún trabajo aquí. Como todos los profesionales de Jack Fix It, pasó la verificación antes de poder enviarte un presupuesto.",
      ),
    ).toBeTruthy();
  });

  it("Accept opens the confirmation for this quote, once per push; Back to quotes goes back", async () => {
    await renderOver();
    const accept = await screen.findByRole("button", {
      name: "Accept the quote from María P. for $250",
    });
    expect(within(accept).getByText("Accept for $250")).toBeTruthy();

    await fireEvent.press(accept);
    await fireEvent.press(accept);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/accept",
      params: { id: REQUEST_ID, quote: MARIA.id },
    });

    await fireEvent.press(screen.getByRole("button", { name: "Back to quotes" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["accepted", [accepted(MARIA), DAN]],
    ["closed by another acceptance", [MARIA, accepted(DAN)]],
    ["expired on the server", [{ ...MARIA, status: "expired" as const }]],
    ["not on the cached list", [DAN]],
    ["with no list cached", null],
  ])("shows no Accept when the quote is %s, only the way back", async (_, items) => {
    await renderOver(items);

    expect(await screen.findByRole("header", { name: "María P." })).toBeTruthy();
    expect(screen.queryByTestId("pro-profile-accept")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Accept/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to quotes" })).toBeTruthy();
  });

  it("Accept goes away the moment the quote expires on screen", async () => {
    fakeClock();
    const soon = quote(1, {
      id: MARIA.id,
      amount_cents: MARIA.amount_cents,
      expires_at: new Date(NOW + 90_000).toISOString(),
    });
    await renderOver([soon]);
    expect(await screen.findByTestId("pro-profile-accept")).toBeTruthy();

    // One act per label change, as on the device: each timer is armed after the render before it.
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(screen.getByTestId("pro-profile-accept")).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(screen.queryByTestId("pro-profile-accept")).toBeNull();
    expect(screen.getByRole("header", { name: "María P." })).toBeTruthy(); // the profile stays
  });

  it("the skeleton has the loaded rows, and no bar until the profile is on screen", async () => {
    const pending = deferred<ProPublicProfile>();
    jest.mocked(apiGet).mockReturnValue(pending.promise);
    await renderOver();

    expect(screen.getByRole("progressbar", { name: "Loading profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByTestId("pro-profile-bar")).toBeNull();
    const placeholders = lineStyles(screen.getByTestId("pro-profile-loading"));

    await act(async () => pending.resolve(PROFILE));
    await screen.findByRole("header", { name: "María P." });
    expect(screen.queryByRole("progressbar")).toBeNull();
    const loaded = lineStyles(screen.getByTestId("pro-profile-screen")).filter(
      (style) => !style.startsWith("bar:"),
    );
    expect(loaded).toEqual(placeholders);
  });

  it("404 says the quote is gone, offers the way back and invalidates the list", async () => {
    jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
    const { client } = await renderOver();

    expect(
      await screen.findByRole("header", { name: "This quote is no longer available" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("pro-profile-bar")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await waitFor(() =>
      expect(client.getQueryState(quotesQueryKey(REQUEST_ID))?.isInvalidated).toBe(true),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Back to quotes" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledTimes(1); // nothing to ask again
  });

  it("a network error shows a retry that keeps the page up, then the profile", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(true));
    const { client } = await renderOver();

    expect(
      await screen.findByRole("header", { name: "We couldn't load this profile" }),
    ).toBeTruthy();
    expect(screen.getByText("Check your connection and try again.")).toBeTruthy();
    expect(client.getQueryState(quotesQueryKey(REQUEST_ID))?.isInvalidated).toBe(false);

    const retried = deferred<ProPublicProfile>();
    jest.mocked(apiGet).mockReturnValue(retried.promise);
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    // The message stays while the retry runs, its button busy; no skeleton in between.
    await waitFor(() =>
      expect(screen.getByTestId("pro-profile-error-action").props.accessibilityState).toMatchObject(
        { busy: true },
      ),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    await act(async () => retried.resolve(PROFILE));
    expect(await screen.findByRole("header", { name: "María P." })).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("403 shows the generic error and nothing of a profile", async () => {
    jest.mocked(apiGet).mockRejectedValue(new ApiError(403, "forbidden"));
    const { client } = await renderOver();

    expect(
      await screen.findByRole("header", { name: "We couldn't load this profile" }),
    ).toBeTruthy();
    expect(screen.queryByRole("header", { name: "This quote is no longer available" })).toBeNull();
    expect(screen.queryByTestId("pro-profile-hero")).toBeNull();
    expect(screen.queryByTestId("pro-profile-bar")).toBeNull();
    expect(client.getQueryState(quotesQueryKey(REQUEST_ID))?.isInvalidated).toBe(false);
  });
});

type HostNode = {
  type: unknown;
  props: Record<string, unknown>;
  children: readonly (HostNode | string)[];
};

const TYPE_STYLE = /\btext-(?:display|title-1|title-2|headline|body|callout|footnote|caption)\b/;
/** Spacing that shapes the page's height: padding and minimum height always, a gap between 2+ children. */
const PADDING = /(?:^|\s)(p[ytb]?-\d+|min-h-\d+)(?=\s|$)/g;
const GAP = /(?:^|\s)(gap(?:-y)?-\d+)(?=\s|$)/g;

/**
 * The rows of the page, top to bottom: each line of text by its type style and each box's
 * vertical spacing, leaving out button labels. The verified badge is one padded row; the bio and
 * the trust line are one block each ("bio", "trust"), since their line counts come from layout;
 * the bottom bar is reported as "bar" (it has no placeholder).
 */
function lineStyles(root: unknown): string[] {
  const styles: string[] = [];
  const walk = (node: HostNode | string) => {
    if (typeof node === "string" || node.props.accessibilityRole === "button") return;
    const testID = String(node.props.testID ?? "");
    const className = String(node.props.className ?? "");
    if (testID.endsWith("-bar")) {
      styles.push("bar:");
      return;
    }
    if (testID.endsWith("-verified") || testID.endsWith("-badge")) {
      const padded = /\bpy-1\b/.test(className);
      const inner = node.children.flatMap((child) => lineStyles(child)).join("+");
      styles.push(`badge:${padded ? "py-1" : "?"}:${inner}`);
      return;
    }
    if (testID.endsWith("-bio") || testID.endsWith("-trust")) {
      styles.push(testID.endsWith("-bio") ? "bio" : "trust");
      return;
    }
    if (node.type === "Text") {
      styles.push(TYPE_STYLE.exec(className)?.[0] ?? "?");
      return;
    }
    const boxed = [...className.matchAll(PADDING)].map((match) => match[1]);
    if (node.children.filter((child) => typeof child !== "string").length > 1) {
      boxed.push(...[...className.matchAll(GAP)].map((match) => match[1]));
    }
    if (boxed.length > 0) styles.push(`box:${boxed.join(" ")}`);
    node.children.forEach(walk);
  };
  walk(root as HostNode);
  return styles;
}
