import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { Text } from "react-native";

import { apiGet, NetworkError, useSession } from "@/api";

import {
  freezeClock,
  jobN,
  jobPage,
  navigation,
  renderWithQuery,
  signedIn,
} from "../../pro-jobs/__tests__/helpers";
import { ProJobList } from "../ProJobList";

jest.mock("@/api", () => jest.requireActual("../../pro-jobs/__tests__/helpers").apiMock());
jest.mock("expo-router", () => ({
  ...jest.requireActual("../../opportunities/__tests__/helpers").routerMock,
  useScrollToTop: jest.fn(),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// The row placeholder pulses forever otherwise; Reduce Motion draws it still.
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return { __esModule: true, ...actual, useReducedMotion: jest.fn(() => true) };
});

const LIST = "/v1/pros/me/jobs";
const HIDDEN = { includeHiddenElements: true };
const listCalls = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === LIST);
const rowIds = () =>
  screen
    .queryAllByTestId(/^pro-job-[0-9a-f-]{36}$/)
    .map((row) => (row.props.testID as string).slice("pro-job-".length));

const DONE = jobN(1, { status: "confirmed" });
const REPORTED = jobN(2, { status: "disputed" });
const UPCOMING = jobN(3, { status: "scheduled" });

const list = () => <ProJobList header={<Text>Your jobs</Text>} empty={<Text>No jobs yet</Text>} />;

beforeEach(() => {
  freezeClock();
  navigation.reset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
  jest.mocked(apiGet).mockReset();
  jest.mocked(router.push).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("ProJobList (#467)", () => {
  it("lists every job as the API pages them, the finished and the reported too, each opening its screen", async () => {
    jest.mocked(apiGet).mockResolvedValue(jobPage([UPCOMING, REPORTED, DONE]));
    await renderWithQuery(list());

    await screen.findByTestId(`pro-job-${REPORTED.id}`);
    expect(rowIds()).toEqual([UPCOMING.id, REPORTED.id, DONE.id]);
    // Every job, not only the active ones: no `active` filter.
    expect(listCalls()[0]?.[1]).toMatchObject({ query: { limit: 20, cursor: undefined } });
    // A reported job reads "Under review" (#469), not "Done".
    expect(screen.getByTestId(`pro-job-${REPORTED.id}-status`, HIDDEN)).toHaveTextContent(
      "Under review",
    );
    expect(screen.getByTestId(`pro-job-${DONE.id}-status`, HIDDEN)).toHaveTextContent("Done");

    await act(async () => fireEvent.press(screen.getByTestId(`pro-job-${REPORTED.id}`)));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/jobs/[id]",
      params: { id: REPORTED.id },
    });
  });

  it("shows the empty state when the pro has no job", async () => {
    jest.mocked(apiGet).mockResolvedValue(jobPage([]));
    await renderWithQuery(list());

    expect(await screen.findByText("No jobs yet")).toBeTruthy();
  });

  it("says a failed first page plainly, and the retry asks again", async () => {
    jest
      .mocked(apiGet)
      .mockRejectedValueOnce(new NetworkError(false))
      .mockResolvedValue(jobPage([DONE]));
    await renderWithQuery(list());

    expect(await screen.findByText("We couldn't load your jobs")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId("pro-job-list-error-action")));
    await screen.findByTestId(`pro-job-${DONE.id}`);
    expect(listCalls()).toHaveLength(2);
  });

  it("loads the next page near the end, after the cursor the last page gave", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(jobPage([UPCOMING, REPORTED], "next-1"))
      .mockResolvedValueOnce(jobPage([DONE]));
    await renderWithQuery(list());
    await screen.findByTestId(`pro-job-${REPORTED.id}`);

    await act(async () => fireEvent(screen.getByTestId("pro-job-list"), "onEndReached"));

    await waitFor(() => expect(rowIds()).toEqual([UPCOMING.id, REPORTED.id, DONE.id]));
    expect(listCalls()[1]?.[1]).toMatchObject({ query: { cursor: "next-1" } });
  });
});
