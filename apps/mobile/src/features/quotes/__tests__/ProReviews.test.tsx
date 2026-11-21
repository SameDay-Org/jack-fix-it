import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { ApiError, apiGet, NetworkError, useSession } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { formatReviewDay, ProReviews } from "../ProReviews";
import { PRO_REVIEWS_PAGE_SIZE, type PublicReview, type PublicReviewPage } from "../useProReviews";
import { renderWithQuery } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  useSession: jest.fn(() => ({ status: "signedIn" })),
  useSessionGeneration: () => 1,
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const PRO_ID = "0b9e5f8e-6a3c-4c1e-9d2f-1a2b3c4d5e6f";
const PATH = "/v1/pros/{pro_id}/reviews";

const review = (overrides: Partial<PublicReview> = {}): PublicReview => ({
  rating: 5,
  comment: "Fixed both doors in an hour. Tidy and on time.",
  reviewer: "Jamie C.",
  created_on: "2026-11-12",
  ...overrides,
});
const page = (items: PublicReview[], next_cursor: string | null = null): PublicReviewPage => ({
  items,
  next_cursor,
});

const FIRST = page(
  [review(), review({ rating: 3, comment: null, reviewer: null, created_on: "2025-12-30" })],
  "cursor-2",
);
const SECOND = page([review({ rating: 4, comment: "Good work.", reviewer: "Ana R." })]);

/** What the reviews read answers, page by cursor; an Error rejects. */
let answers: Map<string | undefined, PublicReviewPage | Error | Promise<PublicReviewPage>>;

const calls = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === PATH);
const cursorOf = (index: number) =>
  (calls()[index]?.[1] as { query: { cursor?: string } }).query.cursor;

beforeEach(() => {
  answers = new Map([[undefined, FIRST]]);
  jest.mocked(useSession).mockReturnValue({ status: "signedIn" } as ReturnType<typeof useSession>);
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async (_path: string, options: { query: { cursor?: string } }) => {
      const answer = answers.get(options.query.cursor);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error("no answer for this cursor");
      return answer;
    }) as unknown as typeof apiGet);
});

afterEach(async () => {
  await act(() => i18n.changeLanguage("en"));
});

async function renderReviews() {
  await renderWithQuery(<ProReviews proId={PRO_ID} />);
}

describe("ProReviews", () => {
  it("lists the first page newest first: stars, who and when, and their words", async () => {
    await renderReviews();
    expect(await screen.findAllByTestId("pro-profile-review")).toHaveLength(2);
    expect(screen.getByRole("header", { name: "Reviews" })).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(PATH, {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 1,
      params: { pro_id: PRO_ID },
      query: { limit: PRO_REVIEWS_PAGE_SIZE, cursor: undefined },
    });
    const [first, second] = screen.getAllByTestId("pro-profile-review");
    // Read as one sentence each; a review with no words reads without them.
    expect(first!.props.accessibilityLabel).toBe(
      "Jamie C., 5 out of 5, Nov 12, 2026. Fixed both doors in an hour. Tidy and on time.",
    );
    expect(second!.props.accessibilityLabel).toBe("A customer, 3 out of 5, Dec 30, 2025");
    expect(screen.getByText("Jamie C. · Nov 12, 2026")).toBeTruthy();
    expect(screen.getByText("Fixed both doors in an hour. Tidy and on time.")).toBeTruthy();
    expect(screen.getByText("A customer · Dec 30, 2025")).toBeTruthy();
    // The stars: as many filled as the rating, the rest muted.
    const stars = screen.getAllByTestId("pro-profile-review-stars");
    expect(stars[1]).toHaveTextContent("★★★★★");
    expect(stars[1]!.props.children[0].props.children).toBe("★★★");
  });

  it("shows more on request with the API's cursor, and no more once the last page is in", async () => {
    answers.set("cursor-2", SECOND);
    await renderReviews();
    await fireEvent.press(await screen.findByTestId("pro-profile-reviews-more"));
    await waitFor(() => expect(screen.getAllByTestId("pro-profile-review")).toHaveLength(3));
    expect(cursorOf(1)).toBe("cursor-2");
    expect(screen.getByText("Ana R. · Nov 12, 2026")).toBeTruthy();
    expect(screen.queryByTestId("pro-profile-reviews-more")).toBeNull();
  });

  it("the more button is named for screen readers, and reads short on screen", async () => {
    await renderReviews();
    const more = await screen.findByTestId("pro-profile-reviews-more");
    expect(more.props.accessibilityLabel).toBe("Show more reviews");
    expect(more).toHaveTextContent("Show more");
  });

  it("no review yet says so, with no button", async () => {
    answers.set(undefined, page([]));
    await renderReviews();
    expect(await screen.findByTestId("pro-profile-reviews-empty")).toHaveTextContent(
      "No reviews yet.",
    );
    expect(screen.queryByTestId("pro-profile-reviews-more")).toBeNull();
  });

  it("a first page that failed says so with a retry, which reads it again", async () => {
    answers.set(undefined, new NetworkError(false));
    await renderReviews();
    expect(await screen.findByTestId("pro-profile-reviews-failed-message")).toHaveTextContent(
      "We couldn't load the reviews.",
    );
    answers.set(undefined, FIRST);
    await fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findAllByTestId("pro-profile-review")).toHaveLength(2);
  });

  it("a next page that failed keeps the reviews shown, and retries that page", async () => {
    answers.set("cursor-2", new ApiError(429, "rate_limited"));
    await renderReviews();
    await fireEvent.press(await screen.findByTestId("pro-profile-reviews-more"));
    expect(await screen.findByTestId("pro-profile-reviews-more-failed-message")).toHaveTextContent(
      "We couldn't load more reviews.",
    );
    expect(screen.getAllByTestId("pro-profile-review")).toHaveLength(2);
    expect(screen.queryByText("rate_limited")).toBeNull();
    answers.set("cursor-2", SECOND);
    await fireEvent.press(screen.getByText("Try again"));
    await waitFor(() => expect(screen.getAllByTestId("pro-profile-review")).toHaveLength(3));
    expect(cursorOf(2)).toBe("cursor-2");
  });

  it("a pro the API no longer shows (404) leaves no section", async () => {
    answers.set(undefined, new ApiError(404, "not_found"));
    await renderReviews();
    // The section is there while the first page loads, then goes once the API said 404.
    expect(screen.getByTestId("pro-profile-reviews-loading")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("pro-profile-reviews")).toBeNull());
    expect(calls()).toHaveLength(1);
  });

  it("placeholder rows while the first page loads, read as loading", async () => {
    const pending = deferred<PublicReviewPage>();
    answers.set(undefined, pending.promise);
    await renderReviews();
    expect(screen.getByTestId("pro-profile-reviews-loading").props.accessibilityLabel).toBe(
      "Loading reviews",
    );
    await act(async () => pending.resolve(FIRST));
    expect(await screen.findAllByTestId("pro-profile-review")).toHaveLength(2);
    expect(screen.queryByTestId("pro-profile-reviews-loading")).toBeNull();
  });

  it("asks nothing for a session that is not signed in", async () => {
    jest
      .mocked(useSession)
      .mockReturnValue({ status: "signedOut" } as ReturnType<typeof useSession>);
    await renderReviews();
    expect(calls()).toHaveLength(0);
  });

  it("speaks Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderReviews();
    const [first, second] = await screen.findAllByTestId("pro-profile-review");
    expect(screen.getByRole("header", { name: "Reseñas" })).toBeTruthy();
    expect(first!.props.accessibilityLabel).toBe(
      `Jamie C., 5 de 5, ${formatReviewDay("2026-11-12", "es")}. Fixed both doors in an hour. Tidy and on time.`,
    );
    expect(second!.props.accessibilityLabel).toBe(
      `Un cliente, 3 de 5, ${formatReviewDay("2025-12-30", "es")}`,
    );
    expect(screen.getByTestId("pro-profile-reviews-more")).toHaveTextContent("Ver más");
  });
});

describe("formatReviewDay", () => {
  it("writes a calendar day with its year, on that day whatever the time zone", () => {
    expect(formatReviewDay("2026-11-12", "en-US")).toBe("Nov 12, 2026");
    expect(formatReviewDay("2026-01-01", "en-US")).toBe("Jan 1, 2026");
  });

  it("leaves anything else as it came", () => {
    expect(formatReviewDay("soon", "en-US")).toBe("soon");
  });
});
