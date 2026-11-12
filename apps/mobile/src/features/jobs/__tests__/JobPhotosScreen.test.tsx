import i18n from "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { Dimensions } from "react-native";

import { apiGet } from "@/api";

import {
  fakeClock,
  freezeClock,
  navigation,
  newQueryClient,
  renderWithQuery,
} from "../../pro-jobs/__tests__/helpers";
import { REQUEST_ID } from "../../quotes/__tests__/helpers";
import { customerJobQueryKey } from "../api";
import { JobPhotosScreen } from "../JobPhotosScreen";
import type { CustomerJob } from "../phase";

import { afterPhoto, at, confirmedJob, customerJob } from "./helpers";

jest.mock("@/api", () => jest.requireActual("../../pro-jobs/__tests__/helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("../../pro-jobs/__tests__/helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const JOB_PATH = "/v1/requests/{request_id}/job";
const MINUTE_MS = 60_000;
const HIDDEN = { includeHiddenElements: true };
const THREE = customerJob({
  photos: { before: [], after: [afterPhoto(1), afterPhoto(2), afterPhoto(3)], pending: 0 },
});
const { width } = Dimensions.get("window");

const session = () =>
  jest.requireMock<{ mockSession: { generation: number } }>("@/api").mockSession;
const jobReads = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === JOB_PATH).length;
const count = () => screen.getByTestId("job-photos-count", HIDDEN).props.children as string;
const pages = () => screen.getByTestId("job-photos-pages");

/** Opens the photos at `index` over the job the screen under them holds. */
async function open(job: CustomerJob | null = THREE, index?: string): Promise<QueryClient> {
  navigation.setParams(index === undefined ? { id: REQUEST_ID } : { id: REQUEST_ID, index });
  const client = newQueryClient();
  if (job) client.setQueryData(customerJobQueryKey(REQUEST_ID, 1), job);
  await renderWithQuery(<JobPhotosScreen />, client);
  return client;
}

beforeEach(() => {
  freezeClock();
  navigation.reset();
  session().generation = 1;
  jest.mocked(apiGet).mockReset().mockResolvedValue(THREE);
  jest.mocked(router.back).mockClear();
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("JobPhotosScreen (#66)", () => {
  it("shows every after photo, each named, from the one tapped", async () => {
    await open(THREE, "1");

    const named = screen
      .getAllByRole("image")
      .map((photo) => photo.props.accessibilityLabel as string);
    expect(named).toEqual([
      "Photo of the finished work, 1 of 3",
      "Photo of the finished work, 2 of 3",
      "Photo of the finished work, 3 of 3",
    ]);
    expect(pages().props.contentOffset).toEqual({ x: width, y: 0 });
    expect(count()).toBe("2 of 3");
    // The count is for the eye: each photo already says where it is.
    expect(screen.queryByText("2 of 3")).toBeNull();
    expect(jobReads()).toBe(0);
  });

  it("a swipe moves the count", async () => {
    await open(THREE, "0");

    await act(async () =>
      fireEvent(pages(), "momentumScrollEnd", {
        nativeEvent: { contentOffset: { x: width * 2, y: 0 } },
      }),
    );
    expect(count()).toBe("3 of 3");
  });

  it.each([
    ["past the last photo", "9", width * 2],
    ["not a number", "two", 0],
    ["missing", undefined, 0],
  ])("a link whose photo is %s opens on a photo there is", async (_name, index, x) => {
    await open(THREE, index);
    expect(pages().props.contentOffset).toEqual({ x, y: 0 });
  });

  it("one photo shows no count", async () => {
    await open(confirmedJob({ photos: { before: [], after: [afterPhoto(1)], pending: 0 } }));
    expect(screen.queryByTestId("job-photos-count", HIDDEN)).toBeNull();
  });

  it("Close goes back to the job", async () => {
    await open();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Close photos" })));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no job on screen (a stale link)", null],
    ["a job with no after photo", customerJob({ photos: { before: [], after: [], pending: 0 } })],
  ])("with %s it draws nothing and closes", async (_name, job) => {
    await open(job);

    expect(screen.queryByTestId("job-photos-screen")).toBeNull();
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(jobReads()).toBe(0);
  });

  it("a link that expires shows a quiet frame and asks for the job again, for this session only", async () => {
    fakeClock();
    const expiring = customerJob({
      photos: { before: [], after: [afterPhoto(1, { expires_at: at(1) })], pending: 0 },
    });
    await open(expiring);
    expect(screen.getByTestId("job-photos-page-0-image")).toBeTruthy();

    await act(async () => jest.advanceTimersByTime(MINUTE_MS));

    expect(screen.getByTestId("job-photos-page-0-frame")).toBeTruthy();
    expect(jobReads()).toBe(1);
    expect(jest.mocked(apiGet).mock.calls[0][1]).toMatchObject({ generation: 1 });
  });

  it("after a sign-out an expired link asks for nothing", async () => {
    fakeClock();
    const expiring = customerJob({
      photos: { before: [], after: [afterPhoto(1, { expires_at: at(1) })], pending: 0 },
    });
    await open(expiring);
    session().generation = 2;

    await act(async () => jest.advanceTimersByTime(MINUTE_MS));

    expect(jobReads()).toBe(0);
  });

  it("speaks Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    await open(THREE, "2");

    expect(screen.getAllByRole("image")[0].props.accessibilityLabel).toBe(
      "Foto del trabajo terminado, 1 de 3",
    );
    expect(count()).toBe("3 de 3");
    expect(screen.getByRole("button", { name: "Cerrar fotos" })).toBeTruthy();
  });
});
