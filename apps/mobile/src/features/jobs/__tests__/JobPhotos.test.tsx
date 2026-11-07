import i18n from "@/i18n";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { apiGet } from "@/api";

import { METRICS } from "../../auth/__tests__/helpers";
import {
  fakeClock,
  freezeClock,
  navigation,
  NOW,
  quote,
  renderWithQuery,
} from "../../quotes/__tests__/helpers";
import type { CustomerQuoteList } from "../../quotes/useRequestQuotes";
import { JobPhotos } from "../JobPhotos";
import { JobScreen } from "../JobScreen";
import type { CustomerJob } from "../phase";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  useSession: () => ({ status: "signedIn", user: null }),
  useSessionGeneration: () => 1,
  sessionGeneration: () => 1,
  onSignOut: jest.fn(() => () => undefined),
}));
jest.mock("expo-router", () => jest.requireActual("../../quotes/__tests__/helpers").routerMock);
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => false) };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

type Photos = CustomerJob["photos"];
type Photo = Photos["before"][number];

const MINUTE_MS = 60_000;
const HIDDEN = { includeHiddenElements: true };
const JOB_PATH = "/v1/requests/{request_id}/job";
const QUOTES_PATH = "/v1/requests/{request_id}/quotes";

const at = (minutes: number) => new Date(NOW + minutes * MINUTE_MS).toISOString();

const photo = (name: string, expiresIn = 20, sig = "a"): Photo => ({
  id: `photo-${name}`,
  content_type: "image/jpeg",
  url: `https://media.test.invalid/j/${name}.jpg?sig=${sig}`,
  expires_at: at(expiresIn),
});

const B1 = photo("b1");
const B2 = photo("b22");
const A1 = photo("a333");
const PHOTOS: Photos = { before: [B1, B2], after: [A1], pending: 0 };
const NONE: Photos = { before: [], after: [], pending: 0 };

const image = (testID: string) => screen.queryByTestId(`${testID}-image`, HIDDEN);
const frames = () => screen.queryAllByTestId("media-frame", HIDDEN);

/** One act per minute: the expiry clock re-arms its timer in an effect, which runs between acts. */
async function advanceMinutes(minutes: number): Promise<void> {
  for (let step = 0; step < minutes; step += 1) {
    await act(async () => jest.advanceTimersByTime(MINUTE_MS));
  }
  await act(async () => jest.advanceTimersByTime(1000));
}

/** AppState listeners currently subscribed: a removed one is never called again. */
const appStateListeners = new Set<(state: AppStateStatus) => void>();
async function foreground(): Promise<void> {
  await act(async () => appStateListeners.forEach((listener) => listener("active")));
}

const refetch = jest.fn(() => Promise.resolve());

function renderPhotos(photos: Photos, updatedAt = NOW) {
  return render(<JobPhotos photos={photos} updatedAt={updatedAt} refetch={refetch} />, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={METRICS}>{children}</SafeAreaProvider>
    ),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  freezeClock();
  navigation.reset();
  appStateListeners.clear();
  jest
    .mocked(AppState.addEventListener)
    .mockReset()
    .mockImplementation((_type, listener): NativeEventSubscription => {
      appStateListeners.add(listener);
      return {
        remove: () => {
          appStateListeners.delete(listener);
        },
      };
    });
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("JobPhotos", () => {
  it("draws nothing while the pro has no photos and none is being prepared", async () => {
    await renderPhotos(NONE);

    expect(screen.queryByTestId("job-photos")).toBeNull();
    expect(screen.queryByText("Photos")).toBeNull();
    expect(screen.toJSON()).toBeNull();
  });

  it("shows a Before and an After row, each tile an image named by its place in the row", async () => {
    await renderPhotos(PHOTOS);

    const section = screen.getByTestId("job-photos");
    expect(within(section).getByRole("header", { name: "Photos" })).toBeTruthy();
    expect(within(section).getByText("Before")).toBeTruthy();
    expect(within(section).getByText("After")).toBeTruthy();

    expect(screen.getByTestId("job-photos-before-0").props.accessibilityLabel).toBe(
      "Before photo 1 of 2",
    );
    expect(screen.getByTestId("job-photos-before-1").props.accessibilityLabel).toBe(
      "Before photo 2 of 2",
    );
    expect(screen.getByTestId("job-photos-after-0").props.accessibilityLabel).toBe(
      "After photo 1 of 1",
    );
    expect(screen.getByRole("image", { name: "After photo 1 of 1" })).toBeTruthy();
    expect(screen.queryByTestId("job-photos-before-2")).toBeNull();

    expect(image("job-photos-before-0")?.props.source).toEqual({ uri: B1.url });
    expect(image("job-photos-before-1")?.props.source).toEqual({ uri: B2.url });
    expect(image("job-photos-after-0")?.props.source).toEqual({ uri: A1.url });
    expect(frames()).toHaveLength(0);
    expect(screen.queryByTestId("job-photos-pending")).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("shows only the rows that have photos", async () => {
    await renderPhotos({ before: [], after: [A1], pending: 0 });

    expect(screen.queryByText("Before")).toBeNull();
    expect(screen.queryByTestId("job-photos-before")).toBeNull();
    expect(screen.getByText("After")).toBeTruthy();
    expect(screen.getByTestId("job-photos-after-0").props.accessibilityLabel).toBe(
      "After photo 1 of 1",
    );

    await screen.rerender(
      <JobPhotos
        photos={{ before: [B1], after: [], pending: 0 }}
        updatedAt={NOW}
        refetch={refetch}
      />,
    );
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.queryByText("After")).toBeNull();
    expect(screen.queryByTestId("job-photos-after")).toBeNull();
    expect(screen.getByTestId("job-photos-before-0").props.accessibilityLabel).toBe(
      "Before photo 1 of 1",
    );
  });

  it("with no photo listed yet, says how many are being prepared (one)", async () => {
    await renderPhotos({ before: [], after: [], pending: 1 });

    expect(screen.getByRole("header", { name: "Photos" })).toBeTruthy();
    expect(screen.queryByText("Before")).toBeNull();
    expect(screen.queryByText("After")).toBeNull();
    expect(screen.getByTestId("job-photos-pending").props.children).toBe(
      "1 photo is being prepared.",
    );
  });

  it("says how many more are being prepared under the rows (several)", async () => {
    await renderPhotos({ ...PHOTOS, pending: 3 });

    expect(screen.getByTestId("job-photos-before")).toBeTruthy();
    expect(screen.getByTestId("job-photos-pending").props.children).toBe(
      "3 more photos are being prepared.",
    );
  });

  it("a photo that fails to load shows the frame, not a broken image, and keeps its name", async () => {
    await renderPhotos(PHOTOS);

    const broken = image("job-photos-before-1");
    if (broken === null) throw new Error("the second before photo has no image");
    await act(async () => fireEvent(broken, "error"));

    expect(image("job-photos-before-1")).toBeNull();
    const tile = screen.getByTestId("job-photos-before-1");
    expect(within(tile).getByTestId("media-frame", HIDDEN)).toBeTruthy();
    expect(tile.props.accessibilityLabel).toBe("Before photo 2 of 2");
    expect(frames()).toHaveLength(1);
    expect(image("job-photos-before-0")).toBeTruthy();
    expect(image("job-photos-after-0")).toBeTruthy();
    // A load error is not an expiry: the job is not asked for again.
    expect(refetch).not.toHaveBeenCalled();
  });

  it("the moment a URL expires on a focused screen, it shows the frame and asks for the job again", async () => {
    fakeClock();
    await renderPhotos({ before: [B1], after: [photo("soon", 5)], pending: 0 });
    expect(frames()).toHaveLength(0);

    await advanceMinutes(5);

    expect(image("job-photos-after-0")).toBeNull();
    expect(
      within(screen.getByTestId("job-photos-after-0")).getByTestId("media-frame", HIDDEN),
    ).toBeTruthy();
    expect(image("job-photos-before-0")).toBeTruthy();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a URL that expires while the screen is away is asked for on focus and on foreground", async () => {
    fakeClock();
    await renderPhotos({ before: [photo("soon", 5)], after: [], pending: 0 });

    await act(async () => navigation.setFocused(false));
    await advanceMinutes(5);
    expect(frames()).toHaveLength(1);
    expect(refetch).not.toHaveBeenCalled();

    await act(async () => navigation.setFocused(true));
    expect(refetch).toHaveBeenCalledTimes(1);

    await foreground();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("an answer whose URL had already expired when it arrived is not asked for again", async () => {
    fakeClock();
    await renderPhotos({ before: [photo("late", -1)], after: [A1], pending: 0 });

    expect(image("job-photos-before-0")).toBeNull();
    expect(frames()).toHaveLength(1);
    expect(image("job-photos-after-0")).toBeTruthy();

    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await foreground();
    await advanceMinutes(2);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("a fresh URL after the refetch draws the photo again", async () => {
    fakeClock();
    const soon = photo("soon", 5);
    await renderPhotos({ before: [soon], after: [], pending: 0 });
    await advanceMinutes(5);
    expect(frames()).toHaveLength(1);
    expect(refetch).toHaveBeenCalledTimes(1);

    const fresh = photo("soon", 25, "fresh");
    await screen.rerender(
      <JobPhotos
        photos={{ before: [fresh], after: [], pending: 0 }}
        updatedAt={Date.now()}
        refetch={refetch}
      />,
    );

    expect(frames()).toHaveLength(0);
    expect(image("job-photos-before-0")?.props.source).toEqual({ uri: fresh.url });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("reads in Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderPhotos({ ...PHOTOS, pending: 2 });

    expect(screen.getByRole("header", { name: "Fotos" })).toBeTruthy();
    expect(screen.getByText("Antes")).toBeTruthy();
    expect(screen.getByText("Después")).toBeTruthy();
    expect(screen.getByTestId("job-photos-before-0").props.accessibilityLabel).toBe(
      "Foto de antes 1 de 2",
    );
    expect(screen.getByTestId("job-photos-after-0").props.accessibilityLabel).toBe(
      "Foto de después 1 de 1",
    );
    expect(screen.getByTestId("job-photos-pending").props.children).toBe(
      "Estamos preparando 2 fotos más.",
    );
  });
});

describe("JobPhotos on the customer's JobScreen", () => {
  const QUOTE_LIST: CustomerQuoteList = { items: [quote(1), quote(2, { status: "accepted" })] };
  const COMPLETED: CustomerJob = {
    id: "6f1c2a40-0000-4000-8000-000000000640",
    status: "completed",
    customer_status: "customerStatus.completed",
    scheduled_start_at: at(-180),
    pro: {
      id: "00000000-0000-4000-8000-000000000202",
      name: "Dan K.",
      rating_avg: "4.80",
      jobs_count: 12,
      years_of_experience: 8,
      verified: true,
    },
    eta_at: null,
    arrival_code: null,
    confirm_by: null,
    timeline: [
      { type: "created", status: "scheduled", at: at(-240) },
      { type: "status_changed", status: "completed", at: at(-10) },
    ],
    amount_cents: 18_000,
    tax_cents: 1_485,
    customer_total_cents: 19_485,
    photos: { before: [B1], after: [photo("done", 5)], pending: 1 },
    unread_messages: 0,
  };
  const FRESH: CustomerJob = {
    ...COMPLETED,
    photos: { before: [B1], after: [photo("done", 25, "fresh")], pending: 0 },
  };

  type Get = (path: string, options?: unknown) => Promise<unknown>;
  const get = apiGet as unknown as jest.MockedFunction<Get>;
  const jobCalls = () => get.mock.calls.filter(([path]) => path === JOB_PATH).length;

  beforeEach(() => {
    let answer: CustomerJob = COMPLETED;
    get.mockImplementation((path) => {
      if (path === JOB_PATH) {
        const current = answer;
        answer = FRESH;
        return Promise.resolve(current);
      }
      if (path === QUOTES_PATH) return Promise.resolve(QUOTE_LIST);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  });

  // The finished screen (#66) leads with the after photos: the section holds the rest.
  it("shows the job's photos on the finished job and asks for the job again when one expires", async () => {
    fakeClock();
    await renderWithQuery(<JobScreen />);
    await screen.findByRole("header", { name: "Dan marked the job done" });

    const sheet = screen.getByTestId("job-sheet");
    const section = within(sheet).getByTestId("job-photos");
    expect(within(section).getByRole("header", { name: "Photos" })).toBeTruthy();
    expect(screen.getByTestId("job-photos-before-0").props.accessibilityLabel).toBe(
      "Before photo 1 of 1",
    );
    expect(screen.queryByTestId("job-photos-after")).toBeNull();
    expect(screen.getByTestId("job-photo-hero-0").props.accessibilityLabel).toBe(
      "Photo of the finished work, 1 of 1",
    );
    expect(screen.getByTestId("job-photos-pending").props.children).toBe(
      "1 more photo is being prepared.",
    );
    expect(jobCalls()).toBe(1);

    // A completed job is not polled: only the after photo's expiry asks for it again.
    await advanceMinutes(5);
    await waitFor(() => expect(jobCalls()).toBe(2));
    await waitFor(() =>
      expect(image("job-photo-hero-0")?.props.source).toEqual({
        uri: FRESH.photos.after[0]?.url,
      }),
    );
    expect(frames()).toHaveLength(0);
    expect(screen.queryByTestId("job-photos-pending")).toBeNull();

    await advanceMinutes(2);
    expect(jobCalls()).toBe(2);
  });

  it("the confirmed job keeps its before photos under the after ones", async () => {
    const confirmed: CustomerJob = {
      ...COMPLETED,
      status: "confirmed",
      customer_status: "customerStatus.confirmed",
    };
    get.mockImplementation((path) =>
      path === JOB_PATH
        ? Promise.resolve(confirmed)
        : Promise.reject(new Error(`unexpected GET ${path}`)),
    );
    await renderWithQuery(<JobScreen />);
    await screen.findByRole("header", { name: "Job confirmed" });

    const section = within(screen.getByTestId("job-sheet")).getByTestId("job-photos");
    expect(within(section).getByTestId("job-photos-before-0")).toBeTruthy();
    expect(screen.queryByTestId("job-photos-after")).toBeNull();
    expect(screen.getByTestId("job-photo-thumb-0")).toBeTruthy();
  });
});
