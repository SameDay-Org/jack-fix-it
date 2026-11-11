import "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import {
  AccessibilityInfo,
  AppState,
  Dimensions,
  Linking,
  Platform,
  type AppStateStatus,
} from "react-native";

import { ApiError, apiGet, apiPost, NetworkError, SessionExpiredError, useSession } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { formatTimeOfDay } from "../../opportunities/format";
import { formatLocale } from "../../quotes/format";
import { proJobQueryKey } from "../api";
import type { ProJob } from "../phase";
import { ProJobScreen } from "../ProJobScreen";
import {
  arrived,
  freezeClock,
  JOB_ID,
  minutesFromNow,
  navigation,
  newQueryClient,
  onTheWay,
  proJob,
  renderWithQuery,
  signedIn,
  working,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
// Root manual mock (apps/mobile/__mocks__): named here so the test and the screen share one instance.
jest.mock("expo-haptics");
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the loading skeleton's endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const { mockSession } = jest.requireMock<{ mockSession: { generation: number } }>("@/api");

const JOB = "/v1/pros/me/jobs/{job_id}";
const START = "/v1/pros/me/jobs/{job_id}/start";
const STREET = "1200 Las Olas Blvd, Apt 4";
const CITY = "Fort Lauderdale, FL 33301";
const ADDRESS_QUERY = encodeURIComponent(`${STREET}, ${CITY}`);

const time = (iso: string) => formatTimeOfDay(Date.parse(iso), formatLocale());
const toast = () => toastStore.getState().current;
const actions = () => within(screen.getByTestId("pro-job-actions"));
/** The dock's buttons; a step with no action has no dock at all, so none. */
const actionButtons = () =>
  screen.queryByTestId("pro-job-actions") ? actions().queryAllByRole("button") : [];
const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
const LOCKED_NOTICE =
  "Check-in is locked. Too many codes didn't match, so check-in is locked for this job. " +
  "We've let our team know.";

let dimensions: jest.SpiedFunction<typeof Dimensions.get> | undefined;

/** The text size the device reports from here on (the window keeps its other values). */
function atFontScale(fontScale: number): void {
  const window = Dimensions.get("window");
  dimensions = jest.spyOn(Dimensions, "get").mockReturnValue({ ...window, fontScale });
}

/** Renders the screen and waits for the job's title (the API answered). */
async function open(job: ProJob = proJob()) {
  jest.mocked(apiGet).mockResolvedValue(job);
  const view = await renderWithQuery(<ProJobScreen />);
  await screen.findByTestId("pro-job-title");
  return view;
}

/** The AppState listeners still subscribed (a blur removed the earlier ones), told the app came back. */
function foreground(): void {
  const { calls, results } = jest.mocked(AppState.addEventListener).mock;
  calls.forEach(([type, listener], index) => {
    const subscription = results[index]?.value as { remove: jest.Mock } | undefined;
    if (type !== "change" || subscription?.remove.mock.calls.length) return;
    (listener as (state: AppStateStatus) => void)("active");
  });
}

let announceSpy: jest.SpyInstance;

beforeEach(() => {
  freezeClock();
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  mockSession.generation = 1;
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockReset().mockResolvedValue(proJob());
  jest.mocked(apiPost).mockReset();
  jest.mocked(router.push).mockClear();
  jest.mocked(router.dismissTo).mockClear();
  jest.mocked(Haptics.notificationAsync).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
  announceSpy = jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
  toastStore.setState({ current: null });
});

afterEach(() => {
  announceSpy.mockRestore();
  dimensions?.mockRestore();
  dimensions = undefined;
  dismissToast();
  jest.useRealTimers();
});

describe("ProJobScreen", () => {
  describe("scheduled", () => {
    it("shows when it starts, what the pro receives, the customer and the full address", async () => {
      const job = proJob();
      await open(job);

      expect(apiGet).toHaveBeenCalledWith(JOB, {
        auth: true,
        signal: expect.any(AbortSignal),
        generation: 1,
        params: { job_id: JOB_ID },
      });
      const hero = within(screen.getByTestId("pro-job-time"));
      expect(hero.getByText("Starts")).toBeTruthy();
      expect(hero.getByText(time(job.scheduled_start_at))).toBeTruthy();
      expect(hero.getByText("Today")).toBeTruthy();
      expect(within(screen.getByTestId("pro-job-status")).getByText("Scheduled")).toBeTruthy();
      expect(screen.getByRole("header", { name: "Painting for Maria" })).toBeTruthy();

      const payout = within(screen.getByTestId("pro-job-payout"));
      expect(payout.getByText("You'll receive")).toBeTruthy();
      expect(payout.getByText("$153.00")).toBeTruthy();
      const customer = within(screen.getByTestId("pro-job-customer"));
      expect(customer.getByText("Customer")).toBeTruthy();
      expect(customer.getByText("Maria")).toBeTruthy();

      const address = screen.getByTestId("pro-job-address-text");
      expect(address.props.children).toBe(`${STREET}\n${CITY}`);
      expect(address.props.selectable).toBe(true);
      expect(screen.getByText("Press and hold the address to copy it.")).toBeTruthy();
      expect(screen.getByRole("button", { name: `Open ${STREET}, ${CITY} in Maps` })).toBeTruthy();
      expect(screen.getByTestId("pro-job-description").props.children).toBe(job.description);
    });

    it("offers only I'm on my way, which opens the arrival time sheet", async () => {
      await open();

      expect(
        screen.getByText("When you head out, tap I'm on my way so Maria sees when you'll arrive."),
      ).toBeTruthy();
      expect(actionButtons()?.map((button) => button.props.accessibilityLabel)).toEqual([
        "I'm on my way",
      ]);
      await act(async () => fireEvent.press(screen.getByRole("button", { name: "I'm on my way" })));
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/jobs/[id]/on-the-way",
        params: { id: JOB_ID },
      });
    });

    it("at the default text size, what the pro receives and the customer sit side by side with a divider", async () => {
      atFontScale(1);
      await open();

      const facts = screen.getByTestId("pro-job-facts");
      expect(facts.props.className).toContain("flex-row");
      // Payout, divider, customer.
      expect(facts.children).toHaveLength(3);
      expect(facts.children[0]).toBe(screen.getByTestId("pro-job-payout"));
      expect(facts.children[2]).toBe(screen.getByTestId("pro-job-customer"));
    });

    it("at a larger text size, what the pro receives and the customer stack, with no divider", async () => {
      atFontScale(2);
      await open();

      const facts = screen.getByTestId("pro-job-facts");
      expect(facts.props.className).not.toContain("flex-row");
      expect(facts.children).toHaveLength(2);
      expect(facts.children[0]).toBe(screen.getByTestId("pro-job-payout"));
      expect(facts.children[1]).toBe(screen.getByTestId("pro-job-customer"));
    });

    it("announces nothing when the screen opens", async () => {
      await open();
      await act(async () => undefined);

      expect(announceSpy).not.toHaveBeenCalled();
    });
  });

  describe("on the way", () => {
    it("shows the arrival time, the scheduled time, I've arrived and Update arrival time", async () => {
      const job = onTheWay();
      await open(job);

      const hero = within(screen.getByTestId("pro-job-time"));
      expect(hero.getByText("You'll arrive by")).toBeTruthy();
      expect(hero.getByText(time(job.eta_at ?? ""))).toBeTruthy();
      expect(hero.getByText(`Scheduled for today, ${time(job.scheduled_start_at)}`)).toBeTruthy();
      expect(within(screen.getByTestId("pro-job-status")).getByText("On the way")).toBeTruthy();
      expect(
        screen.getByText(
          "When you get there, ask Maria for the 4-digit arrival code in their app.",
        ),
      ).toBeTruthy();
      expect(actionButtons()?.map((button) => button.props.accessibilityLabel)).toEqual([
        "I've arrived",
        "Update arrival time",
      ]);

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "I've arrived" })));
      expect(router.push).toHaveBeenLastCalledWith({
        pathname: "/jobs/[id]/check-in",
        params: { id: JOB_ID },
      });

      // The router lands that push before the next one opens.
      await act(async () => navigation.setNavigating(true));
      await act(async () => navigation.setNavigating(false));
      await act(async () =>
        fireEvent.press(screen.getByRole("button", { name: "Update arrival time" })),
      );
      expect(router.push).toHaveBeenLastCalledWith({
        pathname: "/jobs/[id]/on-the-way",
        params: { id: JOB_ID },
      });
      expect(router.push).toHaveBeenCalledTimes(2);
    });

    it("a locked check-in shows the danger notice and no action", async () => {
      await open(onTheWay({ arrival_code_locked: true }));

      expect(
        within(screen.getByTestId("pro-job-status")).getByText("Check-in locked"),
      ).toBeTruthy();
      const locked = within(screen.getByTestId("pro-job-locked"));
      expect(locked.getByText("Check-in is locked")).toBeTruthy();
      expect(
        locked.getByText(
          "Too many codes didn't match, so check-in is locked for this job. We've let our team know.",
        ),
      ).toBeTruthy();
      expect(actionButtons()).toEqual([]);
      expect(screen.queryByTestId("pro-job-guide")).toBeNull();
    });

    it("a lock that lands while the screen is up is said once, by its notice", async () => {
      const client = newQueryClient();
      jest.mocked(apiGet).mockResolvedValue(onTheWay());
      await renderWithQuery(<ProJobScreen />, client);
      await screen.findByRole("button", { name: "I've arrived" });
      expect(announceSpy).not.toHaveBeenCalled();

      await act(async () =>
        client.setQueryData(proJobQueryKey(JOB_ID, 1), onTheWay({ arrival_code_locked: true })),
      );
      await screen.findByTestId("pro-job-locked");
      await act(async () => undefined);

      expect(announced()).toEqual([LOCKED_NOTICE]);
    });

    it("without a customer name says the customer and shows no Customer column", async () => {
      await open(onTheWay({ customer_first_name: null }));

      expect(screen.getByRole("header", { name: "Painting" })).toBeTruthy();
      expect(screen.queryByTestId("pro-job-customer")).toBeNull();
      expect(screen.queryByText("Customer")).toBeNull();
      expect(
        screen.getByText(
          "When you get there, ask the customer for the 4-digit arrival code in their app.",
        ),
      ).toBeTruthy();
    });

    // "the customer" never starts a sentence: no copy leads with the name.
    it("without a customer name the scheduled guide reads the customer mid-sentence", async () => {
      await open(proJob({ customer_first_name: null }));

      expect(
        screen.getByText(
          "When you head out, tap I'm on my way so the customer sees when you'll arrive.",
        ),
      ).toBeTruthy();
    });
  });

  describe("arrived", () => {
    it("Start job posts once however fast the taps, then shows Working with Job's done", async () => {
      const answer = deferred<ProJob>();
      jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
      const job = arrived();
      await open(job);

      expect(screen.getByText("Checked in at")).toBeTruthy();
      expect(
        screen.getByText("You're checked in. Start the job when you begin the work."),
      ).toBeTruthy();
      const start = screen.getByTestId("pro-job-start");
      await act(async () => fireEvent.press(start));
      await act(async () => fireEvent.press(start));
      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(apiPost).toHaveBeenCalledWith(START, undefined, {
        auth: true,
        generation: 1,
        params: { job_id: JOB_ID },
      });
      expect(screen.getByTestId("pro-job-start").props.accessibilityState).toMatchObject({
        busy: true,
      });

      await act(async () => answer.resolve(working()));

      await waitFor(() =>
        expect(within(screen.getByTestId("pro-job-status")).getByText("Working")).toBeTruthy(),
      );
      expect(screen.getByText("Started at")).toBeTruthy();
      expect(screen.getByText("When the work is finished, tap Job's done.")).toBeTruthy();
      expect(actionButtons()).toEqual([screen.getByTestId("pro-job-done")]);
      expect(Haptics.notificationAsync).toHaveBeenCalledWith(
        Haptics.NotificationFeedbackType.Success,
      );
      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(toast()).toBeNull();
    });

    it("a step change while focused is announced once (Job started.)", async () => {
      jest.mocked(apiPost).mockResolvedValueOnce(working());
      await open(arrived());
      expect(announceSpy).not.toHaveBeenCalled();

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-start")));

      await waitFor(() => expect(announced()).toContain("Job started."));
      expect(announceSpy).toHaveBeenCalledWith("Job started.", { queue: true });
      expect(announced().filter((message) => message === "Job started.")).toHaveLength(1);
    });

    it("a start refused as check_in_required says the job changed and asks for it again", async () => {
      jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "check_in_required"));
      await open(arrived());
      jest.mocked(apiGet).mockResolvedValue(onTheWay());

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-start")));

      await waitFor(() =>
        expect(toast()).toMatchObject({
          message: "This job changed. Here's where it stands now.",
          tone: "danger",
        }),
      );
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("button", { name: "I've arrived" })).toBeTruthy();
      expect(screen.queryByTestId("pro-job-start")).toBeNull();
    });

    it("offline says so and leaves Start job usable again", async () => {
      jest
        .mocked(apiPost)
        .mockRejectedValueOnce(new NetworkError(true))
        .mockResolvedValueOnce(working());
      await open(arrived());

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-start")));

      await waitFor(() =>
        expect(toast()?.message).toBe(
          "We couldn't reach Jack Fix It. Check your connection and try again.",
        ),
      );
      expect(apiGet).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(screen.getByTestId("pro-job-start").props.accessibilityState).toMatchObject({
          disabled: false,
          busy: false,
        }),
      );

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-start")));
      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(await screen.findByTestId("pro-job-done")).toBeTruthy();
    });

    it("a start whose session ended shows nothing and asks for nothing", async () => {
      jest.mocked(apiPost).mockRejectedValueOnce(new SessionExpiredError("superseded"));
      await open(arrived());

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-start")));
      await act(async () => undefined);

      expect(toast()).toBeNull();
      expect(apiGet).toHaveBeenCalledTimes(1);
      expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    });
  });

  describe("working, done and closed", () => {
    it("working asks for an after photo and holds Job's done closed until one is on the job", async () => {
      await open(working());

      expect(within(screen.getByTestId("pro-job-status")).getByText("Working")).toBeTruthy();
      expect(screen.getByText("When the work is finished, tap Job's done.")).toBeTruthy();
      expect(actionButtons()).toEqual([screen.getByTestId("pro-job-done")]);
      expect(screen.getByTestId("pro-job-done").props.accessibilityState).toMatchObject({
        disabled: true,
      });
      expect(actions().getByText("Add at least one after photo first.")).toBeTruthy();
    });

    it("done and waiting says who confirms it next, with no button", async () => {
      await open(working({ status: "completed", completed_at: minutesFromNow(-1) }));

      expect(within(screen.getByTestId("pro-job-status")).getByText("Done")).toBeTruthy();
      expect(screen.getByText("Marked done at")).toBeTruthy();
      expect(screen.getByText("Job's done. Waiting for Maria to confirm.")).toBeTruthy();
      expect(actionButtons()).toEqual([]);
    });

    it("done and confirmed says it was marked done, with no button", async () => {
      await open(working({ status: "confirmed", completed_at: minutesFromNow(-1) }));

      expect(screen.getByText("You marked this job done.")).toBeTruthy();
      expect(actionButtons()).toEqual([]);
    });

    it("closed says it was cancelled and that the address is no longer shown", async () => {
      await open(proJob({ status: "cancelled", address: null }));

      expect(within(screen.getByTestId("pro-job-status")).getByText("Cancelled")).toBeTruthy();
      expect(screen.getByText("Was scheduled for")).toBeTruthy();
      expect(screen.getByText("This job was cancelled.")).toBeTruthy();
      expect(screen.getByText("The address is no longer shown for this job.")).toBeTruthy();
      expect(screen.queryByTestId("pro-job-address-text")).toBeNull();
      expect(screen.queryByTestId("pro-job-open-maps")).toBeNull();
      expect(actionButtons()).toEqual([]);
    });
  });

  describe("Open in Maps", () => {
    it("opens Apple Maps with the address on iOS, the default Jest platform", async () => {
      expect(Platform.OS).toBe("ios");
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
      await open();

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-open-maps")));

      expect(openURL).toHaveBeenCalledWith(`https://maps.apple.com/?q=${ADDRESS_QUERY}`);
      expect(toast()).toBeNull();
      openURL.mockRestore();
    });

    it("opens the geo: chooser with the address on Android", async () => {
      const os = jest.replaceProperty(Platform, "OS", "android");
      const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
      await open();

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-open-maps")));

      expect(openURL).toHaveBeenCalledWith(`geo:0,0?q=${ADDRESS_QUERY}`);
      openURL.mockRestore();
      os.restore();
    });

    it("says so when no maps app opens", async () => {
      const openURL = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no handler"));
      await open();

      await act(async () => fireEvent.press(screen.getByTestId("pro-job-open-maps")));

      await waitFor(() =>
        expect(toast()).toMatchObject({
          message: "We couldn't open your maps app.",
          tone: "danger",
        }),
      );
      openURL.mockRestore();
    });
  });

  describe("loading, not found and errors", () => {
    it("shows the skeleton while the job loads, then the job", async () => {
      const answer = deferred<ProJob>();
      jest.mocked(apiGet).mockReturnValueOnce(answer.promise as ReturnType<typeof apiGet>);
      await renderWithQuery(<ProJobScreen />);

      expect(screen.getByRole("progressbar", { name: "Loading your job" })).toBeTruthy();
      expect(screen.queryByTestId("pro-job-actions")).toBeNull();

      await act(async () => answer.resolve(proJob()));

      expect(await screen.findByRole("header", { name: "Painting for Maria" })).toBeTruthy();
      expect(screen.queryByTestId("pro-job-loading")).toBeNull();
    });

    it("404 says the job is not found and offers home", async () => {
      jest.mocked(apiGet).mockRejectedValue(new ApiError(404, "not_found"));
      await renderWithQuery(<ProJobScreen />);

      expect(await screen.findByText("We couldn't find this job")).toBeTruthy();
      expect(
        screen.getByText("It may have been cancelled, or it belongs to another account."),
      ).toBeTruthy();
      expect(screen.queryByTestId("pro-job-actions")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Go to home" })));
      expect(router.dismissTo).toHaveBeenCalledWith("/");
    });

    it("an id that is not a UUID asks nothing and reads as not found", async () => {
      navigation.setParams({ id: "job-63" });
      await renderWithQuery(<ProJobScreen />);

      expect(screen.getByText("We couldn't find this job")).toBeTruthy();
      await act(async () => undefined);
      expect(apiGet).not.toHaveBeenCalled();
    });

    it.each([
      ["a network error", new NetworkError(false)],
      ["a 503", new ApiError(503, undefined)],
    ])("a first load that fails with %s offers Try again, which loads it", async (_, error) => {
      jest.mocked(apiGet).mockRejectedValueOnce(error).mockResolvedValue(proJob());
      await renderWithQuery(<ProJobScreen />);

      expect(await screen.findByText("We couldn't load this job")).toBeTruthy();
      expect(screen.getByText("Check your connection and try again.")).toBeTruthy();
      expect(screen.queryByTestId("pro-job-actions")).toBeNull();

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));

      expect(await screen.findByRole("header", { name: "Painting for Maria" })).toBeTruthy();
      expect(apiGet).toHaveBeenCalledTimes(2);
    });

    it("a refresh that fails keeps the job on screen and offers a retry", async () => {
      await open();
      jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));

      await act(async () => navigation.setFocused(false));
      await act(async () => navigation.setFocused(true));

      expect(await screen.findByText("We couldn't refresh this job.")).toBeTruthy();
      expect(screen.getByRole("header", { name: "Painting for Maria" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "I'm on my way" })).toBeTruthy();

      await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));

      await waitFor(() => expect(screen.queryByText("We couldn't refresh this job.")).toBeNull());
      expect(apiGet).toHaveBeenCalledTimes(3);
    });
  });

  describe("freshness", () => {
    it("asks for the job again when the screen comes back into focus and to the foreground", async () => {
      await open();
      expect(apiGet).toHaveBeenCalledTimes(1);
      jest.mocked(apiGet).mockResolvedValue(onTheWay());

      await act(async () => navigation.setFocused(false));
      await act(async () => navigation.setFocused(true));

      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("button", { name: "I've arrived" })).toBeTruthy();

      await act(async () => foreground());
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    });

    it("a step reached while blurred is announced once, when focus returns", async () => {
      const client = newQueryClient();
      jest.mocked(apiGet).mockResolvedValue(onTheWay());
      await renderWithQuery(<ProJobScreen />, client);
      await screen.findByRole("button", { name: "I've arrived" });

      // The check-in sheet over the screen answers: the job is checked in under it.
      await act(async () => navigation.setFocused(false));
      await act(async () => client.setQueryData(proJobQueryKey(JOB_ID, 1), arrived()));
      await screen.findByTestId("pro-job-start");
      expect(announceSpy).not.toHaveBeenCalled();

      // The refetch on return is held, so its answer lands inside an act.
      const refetched = deferred<ProJob>();
      jest.mocked(apiGet).mockReturnValueOnce(refetched.promise as ReturnType<typeof apiGet>);
      await act(async () => navigation.setFocused(true));

      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(announced()).toEqual(["Checked in. You can start the job."]);
      await act(async () => {
        refetched.resolve(arrived());
        await settle();
      });
      expect(announced()).toEqual(["Checked in. You can start the job."]);
    });

    it("an answer that lands after a sign-out and another sign-in is never shown", async () => {
      const late = deferred<ProJob>();
      jest
        .mocked(apiGet)
        .mockReturnValueOnce(late.promise as ReturnType<typeof apiGet>)
        .mockRejectedValue(new ApiError(404, "not_found"));
      await renderWithQuery(<ProJobScreen />);
      expect(apiGet).toHaveBeenCalledTimes(1);

      // Signed out, then another account signed in: the session generation moved on.
      mockSession.generation += 1;
      await act(async () => screen.rerender(<ProJobScreen />));

      expect(await screen.findByText("We couldn't find this job")).toBeTruthy();
      expect(jest.mocked(apiGet).mock.calls[1]?.[1]).toMatchObject({ generation: 2 });

      await act(async () => late.resolve(proJob()));
      await act(async () => undefined);

      expect(screen.queryByTestId("pro-job-title")).toBeNull();
      expect(screen.queryByText("Painting for Maria")).toBeNull();
      expect(screen.queryByTestId("pro-job-actions")).toBeNull();
      expect(screen.getByText("We couldn't find this job")).toBeTruthy();
    });

    it("an answer that lands after a sign-out renders nothing of the job", async () => {
      const late = deferred<ProJob>();
      jest.mocked(apiGet).mockReturnValueOnce(late.promise as ReturnType<typeof apiGet>);
      await renderWithQuery(<ProJobScreen />);

      mockSession.generation += 1;
      jest.mocked(useSession).mockReturnValue({ ...signedIn(), status: "signedOut", user: null });
      await act(async () => screen.rerender(<ProJobScreen />));
      await act(async () => late.resolve(proJob()));
      await act(async () => undefined);

      expect(apiGet).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pro-job-title")).toBeNull();
      expect(screen.queryByTestId("pro-job-actions")).toBeNull();
    });
  });
});

describe("the chat with the customer (#74)", () => {
  it("offers a message to the customer by first name, with their unread count", async () => {
    await open(proJob({ customer_first_name: "Jamie", unread_messages: 2 }));

    const entry = screen.getByTestId("chat-entry");
    expect(within(entry).getByText("Message Jamie")).toBeTruthy();
    expect(within(entry).getByTestId("chat-entry-badge")).toBeTruthy();
    expect(entry.props.accessibilityLabel).toBe("Message Jamie, 2 unread messages");

    await act(async () => fireEvent.press(entry));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/jobs/[id]/chat",
      params: { id: JOB_ID },
    });
  });

  it("says 'your customer' when the API withholds the name, and no badge with nothing unread", async () => {
    await open(proJob({ customer_first_name: null, unread_messages: 0 }));

    const entry = screen.getByTestId("chat-entry");
    expect(entry.props.accessibilityLabel).toBe("Message your customer");
    expect(screen.queryByTestId("chat-entry-badge")).toBeNull();
  });

  it("only offers to read the messages once the job is cancelled", async () => {
    await open(proJob({ status: "cancelled", address: null }));

    expect(screen.getByTestId("chat-entry").props.accessibilityLabel).toBe("View messages");
  });
});
