import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { AppState } from "react-native";

import { ApiError, apiGet } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import {
  fakeClock,
  freezeClock,
  navigation,
  newQueryClient,
  NOW,
  renderWithQuery,
  REQUEST_ID,
} from "../../quotes/__tests__/helpers";
import { customerJobQueryKey } from "../api";
import { jobsConfig } from "../config";
import { JobBookedNotice } from "../JobBookedNotice";
import type { CustomerJob, JobTimelineEntry } from "../phase";

jest.mock("@/api", () => {
  const { signedIn } = jest.requireActual<typeof import("../../home/__tests__/helpers")>(
    "../../home/__tests__/helpers",
  );
  return {
    ...jest.requireActual("../../../api/errors"),
    apiGet: jest.fn(),
    useSession: jest.fn(() => signedIn({ role: "customer" })),
    useSessionGeneration: jest.fn(() => 1),
    sessionGeneration: jest.fn(() => 1),
    onSignOut: jest.fn(() => () => undefined),
  };
});
jest.mock("expo-router", () => ({
  ...jest.requireActual<typeof import("../../quotes/__tests__/helpers")>(
    "../../quotes/__tests__/helpers",
  ).routerMock,
  // The request detail under it is on screen.
  useIsFocused: () => true,
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const JOB_PATH = "/v1/requests/{request_id}/job";
const MINUTE_MS = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE_MS).toISOString();
const entry = (type: string, status: JobTimelineEntry["status"], minutes: number) => ({
  type,
  status,
  at: at(minutes),
});

const ON_THE_WAY: CustomerJob = {
  id: "9a000000-0000-4000-8000-000000000064",
  status: "on_the_way",
  customer_status: "customerStatus.professionalOnTheWay",
  scheduled_start_at: at(30),
  pro: {
    id: "00000000-0000-4000-8000-000000000202",
    name: "Dan K.",
    rating_avg: "4.80",
    jobs_count: 12,
    years_of_experience: 8,
    verified: true,
  },
  eta_at: at(12),
  arrival_code: "4821",
  timeline: [entry("created", "scheduled", -120), entry("status_changed", "on_the_way", -5)],
  amount_cents: 18_000,
  tax_cents: 0,
  customer_total_cents: 18_000,
  // The pro's photos (#298): none here; the screen does not show them yet.
  photos: { before: [], after: [], pending: 0 },
  // Chat messages not read yet (#71): none; the screen does not show them yet.
  unread_messages: 0,
};

const jobCalls = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === JOB_PATH);

async function renderNotice(accepted: boolean) {
  const client = newQueryClient();
  await renderWithQuery(<JobBookedNotice requestId={REQUEST_ID} accepted={accepted} />, client);
  return client;
}

beforeEach(() => {
  navigation.reset();
  jest.mocked(apiGet).mockReset();
  jest.mocked(router.push).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
});

afterEach(async () => {
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("JobBookedNotice (#64)", () => {
  it("once the job exists: the booked line, where it stands, and the way to follow it", async () => {
    freezeClock();
    const answer = deferred<CustomerJob>();
    jest.mocked(apiGet).mockReturnValue(answer.promise as ReturnType<typeof apiGet>);
    await renderNotice(true);

    // Nothing while the job is asked for.
    expect(screen.queryByTestId("job-booked")).toBeNull();
    expect(apiGet).toHaveBeenCalledWith(JOB_PATH, {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 1,
      params: { request_id: REQUEST_ID },
    });

    await act(async () => answer.resolve(ON_THE_WAY));

    expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();
    expect(screen.getByText("Dan is on the way")).toBeTruthy();
    // The notice never shows the arrival code: that is the job screen's.
    expect(screen.queryByText(/4821/)).toBeNull();

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Follow your job" })));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/requests/[id]/job",
      params: { id: REQUEST_ID },
    });
  });

  it("a scheduled job shows its start under 'booked', not its headline again", async () => {
    freezeClock();
    const scheduled: CustomerJob = {
      ...ON_THE_WAY,
      status: "scheduled",
      eta_at: null,
      arrival_code: null,
      timeline: [entry("created", "scheduled", -120)],
    };
    jest.mocked(apiGet).mockResolvedValue(scheduled as Awaited<ReturnType<typeof apiGet>>);
    await renderNotice(true);

    expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();
    expect(screen.getByText(/^Scheduled for /)).toBeTruthy();
    expect(screen.queryByText("Dan is booked")).toBeNull();
    expect(screen.getByRole("button", { name: "Follow your job" })).toBeTruthy();
  });

  it.each([
    ["cancelled", "This job was cancelled", "Nothing more is needed from you."],
    ["disputed", "This job needs attention", "A problem was reported on this job."],
    ["confirmed", "Job's done", "Thanks for booking with Jack Fix It."],
  ] as const)(
    "a %s job is not 'booked': the notice says where it ended",
    async (status, title, line) => {
      freezeClock();
      const past: CustomerJob = { ...ON_THE_WAY, status, eta_at: null, arrival_code: null };
      jest.mocked(apiGet).mockResolvedValue(past as Awaited<ReturnType<typeof apiGet>>);
      await renderNotice(true);

      expect(await screen.findByRole("header", { name: title })).toBeTruthy();
      expect(screen.queryByText("Your job is booked")).toBeNull();
      expect(screen.getByText(line)).toBeTruthy();
      await act(async () => fireEvent.press(screen.getByRole("button", { name: "See your job" })));
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/requests/[id]/job",
        params: { id: REQUEST_ID },
      });
    },
  );

  it("before the payment created the job (404) it renders nothing", async () => {
    freezeClock();
    const answer = deferred<CustomerJob>();
    jest.mocked(apiGet).mockReturnValue(answer.promise as ReturnType<typeof apiGet>);
    const client = await renderNotice(true);
    expect(jobCalls()).toHaveLength(1);

    await act(async () => answer.reject(new ApiError(404, "not_found")));
    await waitFor(() =>
      expect(client.getQueryState(customerJobQueryKey(REQUEST_ID, 1))?.status).toBe("error"),
    );

    expect(screen.queryByTestId("job-booked")).toBeNull();
    expect(screen.queryByText("Your job is booked")).toBeNull();
    expect(screen.toJSON()).toBeNull();
  });

  it("on a request with no accepted quote it renders nothing and asks nothing", async () => {
    freezeClock();
    jest.mocked(apiGet).mockResolvedValue(ON_THE_WAY);
    await renderNotice(false);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(screen.toJSON()).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("is never polled from the request detail, even while the job moves", async () => {
    fakeClock();
    jest.mocked(apiGet).mockResolvedValue(ON_THE_WAY);
    await renderNotice(true);
    await waitFor(() => expect(screen.getByText("Dan is on the way")).toBeTruthy());
    expect(jobCalls()).toHaveLength(1);

    for (let step = 0; step < 3; step += 1) {
      await act(async () => jest.advanceTimersByTime(jobsConfig.pollMs));
    }

    expect(jobCalls()).toHaveLength(1);
  });
});
