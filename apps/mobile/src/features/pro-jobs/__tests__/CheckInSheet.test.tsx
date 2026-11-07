import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { router } from "expo-router";
import { AccessibilityInfo, AppState, Linking, Platform, type AppStateStatus } from "react-native";

import { ApiError, apiPost, NetworkError, type ErrorHeaders } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import { deferred } from "../../../api/__tests__/helpers";
import { proJobQueryKey } from "../api";
import { CheckInSheet } from "../CheckInSheet";
import { proJobsConfig } from "../config";
import type { ProJob } from "../phase";

import {
  ARRIVAL_CODE,
  arrived,
  fakeClock,
  freezeClock,
  JOB_ID,
  navigation,
  newQueryClient,
  onTheWay,
  renderWithQuery,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-haptics");
jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  enableNetworkProviderAsync: jest.fn(),
  Accuracy: { Balanced: 3, High: 4 },
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const CHECK_IN = "/v1/pros/me/jobs/{job_id}/check-in";
const PINNED = { auth: true, generation: 1, params: { job_id: JOB_ID } };
const LAT = 26.1189;
const LNG = -80.1365;
const SENT = { arrival_code: ARRIVAL_CODE, lat: LAT, lng: LNG };
const OFFLINE = "We couldn't reach Jack Fix It. Check your connection and try again.";

type Permission = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;
type Position = Awaited<ReturnType<typeof Location.getCurrentPositionAsync>>;

/** A permission answer: granted, askable (the system will ask), or refused for good. */
const permission = (access: "granted" | "askable" | "blocked"): Permission =>
  ({
    status: access === "granted" ? "granted" : access === "askable" ? "undetermined" : "denied",
    granted: access === "granted",
    canAskAgain: access !== "blocked",
    expires: "never",
  }) as Permission;

const POSITION = {
  coords: {
    latitude: LAT,
    longitude: LNG,
    altitude: null,
    accuracy: 20,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: 0,
} as Position;

/** The error expo-location 58 rejects with: a CodedException carrying `code`. */
const locationError = (code: string) => Object.assign(new Error(code), { code });

/** The headers of an error answer, read case-insensitively as `Headers` does. */
const headers = (values: Record<string, string>): ErrorHeaders => ({
  get: (name: string) =>
    Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null,
});
const wrongCode = (triesLeft?: string) =>
  new ApiError(
    422,
    "arrival_code_invalid",
    triesLeft === undefined ? undefined : headers({ "Arrival-Code-Attempts-Remaining": triesLeft }),
  );

const announced = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([m]) => m);
const codeField = () => screen.getByTestId("check-in-code");
const isDisabled = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityState?.disabled === true;

const press = async (testID: string) => {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(testID));
  });
};
const type = async (digits: string) => {
  await act(async () => {
    await fireEvent.changeText(codeField(), digits);
  });
};

/** The app comes back to the foreground: every listener the sheet registered hears it. */
const foreground = async () => {
  const listeners = jest
    .mocked(AppState.addEventListener)
    .mock.calls.filter(([event]) => event === "change")
    .map(([, listener]) => listener as (state: AppStateStatus) => void);
  await act(async () => listeners.forEach((listener) => listener("active")));
};

/** Opens the sheet over the job the screen under it holds, once the permission was read. */
async function open(job: ProJob = onTheWay()) {
  const client = newQueryClient();
  client.setQueryData(proJobQueryKey(JOB_ID, 1), job);
  await renderWithQuery(<CheckInSheet />, client);
  await act(async () => undefined);
  return client;
}

/** Types the whole code and taps Check in. */
async function submit(code: string = ARRIVAL_CODE) {
  await type(code);
  await press("check-in-submit");
}

let openSettings: jest.SpiedFunction<typeof Linking.openSettings>;
let platform: jest.ReplaceProperty<typeof Platform.OS> | undefined;

/** Runs the rest of the test on that platform (Jest's default is iOS); restored after it. */
const onPlatform = (os: typeof Platform.OS) => {
  platform = jest.replaceProperty(Platform, "OS", os);
};

beforeEach(() => {
  freezeClock();
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  jest.requireMock<{ mockSession: { generation: number } }>("@/api").mockSession.generation = 1;
  jest.mocked(apiPost).mockReset();
  jest
    .mocked(Location.getForegroundPermissionsAsync)
    .mockReset()
    .mockResolvedValue(permission("granted"));
  jest
    .mocked(Location.requestForegroundPermissionsAsync)
    .mockReset()
    .mockResolvedValue(permission("granted"));
  jest.mocked(Location.getCurrentPositionAsync).mockReset().mockResolvedValue(POSITION);
  jest.mocked(Location.hasServicesEnabledAsync).mockReset().mockResolvedValue(true);
  jest.mocked(Location.enableNetworkProviderAsync).mockReset().mockResolvedValue(undefined);
  jest.mocked(router.back).mockClear();
  jest.mocked(Haptics.notificationAsync).mockClear();
  jest.mocked(AppState.addEventListener).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
  openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
  toastStore.getState().current = null;
});

afterEach(() => {
  platform?.restore();
  platform = undefined;
  openSettings.mockRestore();
  dismissToast(); // a shown toast arms its own dismiss timer
  jest.useRealTimers();
});

describe("CheckInSheet", () => {
  it("asks for the 4-digit arrival code and Check in waits for all four digits", async () => {
    await open();

    // The title, and the button's label.
    expect(screen.getAllByText("Check in")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Check in" })).toBe(
      screen.getByTestId("check-in-submit"),
    );
    expect(screen.getByTestId("check-in-body").props.children).toBe(
      "Ask Maria for the 4-digit arrival code in their app.",
    );
    expect(screen.getByLabelText("Arrival code")).toBe(codeField());
    expect(
      screen.getAllByTestId(/^check-in-code-cell-\d$/, { includeHiddenElements: true }),
    ).toHaveLength(4);
    expect(screen.getByTestId("check-in-note").props.children).toBe(
      "We'll also check your location, only for this check-in.",
    );
    expect(isDisabled("check-in-submit")).toBe(true);

    await type("482");
    expect(isDisabled("check-in-submit")).toBe(true);
    await press("check-in-submit");
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();

    await type(ARRIVAL_CODE);
    expect(codeField().props.value).toBe(ARRIVAL_CODE);
    expect(isDisabled("check-in-submit")).toBe(false);
  });

  it("with the location allowed, it finds the position, posts the code with it pinned to the session and closes once", async () => {
    const client = await open();
    const answer = deferred<ProJob>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);

    await submit();

    expect(Location.hasServicesEnabledAsync).toHaveBeenCalledTimes(1);
    expect(Location.enableNetworkProviderAsync).not.toHaveBeenCalled();
    // A street-level fix, with no settings dialog of its own under the running timer.
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledWith({
      accuracy: Location.Accuracy.High,
      mayShowUserSettingsDialog: false,
    });
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(CHECK_IN, SENT, PINNED);
    // The code left the field (and state) as the request went out.
    expect(codeField().props.value).toBe("");
    expect(screen.getByTestId("check-in-submit").props.accessibilityState).toMatchObject({
      busy: true,
    });

    await act(async () => answer.resolve(arrived()));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
    // The job under the sheet is now checked in: the sheet does not close a second time.
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(arrived());
    await act(async () => undefined);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["3", "Code didn't match. 3 tries left."],
    ["1", "Code didn't match. 1 try left."],
    [undefined, "Code didn't match. Check it with Maria and try again."],
  ])("a wrong code with %s tries left says so under an empty field", async (left, message) => {
    await open();
    jest.mocked(apiPost).mockRejectedValueOnce(wrongCode(left));

    await submit();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(codeField().props.value).toBe("");
    expect(codeField().props.accessibilityHint).toBe(message);
    expect(announced()).toContain(message);
    expect(router.back).not.toHaveBeenCalled();
    expect(isDisabled("check-in-submit")).toBe(true);

    // Typing again clears the message.
    await type("1");
    expect(screen.queryByText(message)).toBeNull();
  });

  it("a locked check-in (423) says it is locked for this job, that the team knows, and offers only Close", async () => {
    await open();
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(423, "arrival_code_locked"));

    await submit();

    expect(await screen.findByTestId("check-in-locked")).toBeTruthy();
    expect(screen.getByText("Check-in is locked")).toBeTruthy();
    expect(
      screen.getByText(
        "Too many codes didn't match, so check-in is locked for this job. We've let our team know.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("check-in-submit")).toBeNull();
    expect(screen.queryByTestId("check-in-cancel")).toBeNull();
    expect(screen.queryByTestId("check-in-code")).toBeNull();
    expect(router.back).not.toHaveBeenCalled();

    await press("check-in-close");
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("with the permission never answered, it explains first and asks the system only on Continue", async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("askable"));
    await open();
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());

    await submit();

    expect(screen.getByText("Share your location to check in")).toBeTruthy();
    expect(screen.getByTestId("check-in-ask").props.children).toBe(
      "Jack Fix It checks your location once, when you check in, so Maria knows you've arrived. " +
        "It's used only for this check-in.",
    );
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();

    await press("check-in-allow");

    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(CHECK_IN, SENT, PINNED));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
  });

  it("the location explanation is said aloud as it shows, once", async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("askable"));
    await open();

    await submit();

    const explanation =
      "Share your location to check in. Jack Fix It checks your location once, when you check " +
      "in, so Maria knows you've arrived. It's used only for this check-in.";
    expect(announced()).toEqual([explanation]);
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      explanation,
      { queue: true },
    );
  });

  it("Not now on the explanation goes back to the code as it was typed", async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("askable"));
    await open();

    await submit();
    await press("check-in-cancel");

    expect(codeField().props.value).toBe(ARRIVAL_CODE);
    expect(router.back).not.toHaveBeenCalled();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("a refusal for good explains why and opens Settings, with no check-in", async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("askable"));
    jest
      .mocked(Location.requestForegroundPermissionsAsync)
      .mockResolvedValue(permission("blocked"));
    await open();

    await submit();
    await press("check-in-allow");

    expect(await screen.findByTestId("check-in-blocked")).toBeTruthy();
    expect(screen.getByText("Location is off for Jack Fix It")).toBeTruthy();
    expect(
      screen.getByText(
        "Checking in needs your location so Maria knows you've arrived. Turn it on in Settings, " +
          "then come back here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("check-in-submit")).toBeNull();

    await press("check-in-settings");
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("refused for good already, Check in goes straight to the Settings notice", async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("blocked"));
    await open();

    await submit();

    expect(screen.getByTestId("check-in-blocked")).toBeTruthy();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("back from Settings with the location allowed, the code entry returns with the code still typed", async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("blocked"));
    await open();
    await submit();
    expect(screen.getByTestId("check-in-blocked")).toBeTruthy();

    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission("granted"));
    await foreground();

    await waitFor(() => expect(screen.queryByTestId("check-in-blocked")).toBeNull());
    expect(codeField().props.value).toBe(ARRIVAL_CODE);
    expect(isDisabled("check-in-submit")).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("no position in time says so calmly, and Try again finds it and checks in", async () => {
    jest.useRealTimers();
    fakeClock();
    jest.mocked(Location.getCurrentPositionAsync).mockReturnValue(new Promise(() => undefined));
    await open();

    await submit();
    expect(screen.getByTestId("check-in-note").props.children).toBe("Finding your location…");
    expect(screen.queryByTestId("check-in-timeout")).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(proJobsConfig.locationTimeoutMs + 1);
    });

    expect(screen.getByTestId("check-in-timeout")).toBeTruthy();
    expect(screen.getByText("We couldn't find your location yet")).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();

    jest.mocked(Location.getCurrentPositionAsync).mockResolvedValue(POSITION);
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());
    await press("check-in-retry");

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(CHECK_IN, SENT, PINNED));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
  });

  it("the phone's location switched off says so, with no check-in", async () => {
    jest
      .mocked(Location.getCurrentPositionAsync)
      .mockRejectedValue(locationError("ERR_LOCATION_SERVICES_DISABLED"));
    await open();

    await submit();

    expect(await screen.findByTestId("check-in-off")).toBeTruthy();
    expect(screen.getByText("Your phone's location is off")).toBeTruthy();
    expect(screen.getByTestId("check-in-retry")).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each([
    ["ERR_LOCATION_SERVICES_DISABLED", "check-in-off"],
    ["ERR_LOCATION_SETTINGS_UNSATISFIED", "check-in-off"],
    ["ERR_LOCATION_UNAUTHORIZED", "check-in-blocked"],
    ["ERR_DENIED_FOREGROUND_LOCATION_PERMISSION", "check-in-blocked"],
    ["ERR_CURRENT_LOCATION_IS_UNAVAILABLE", "check-in-timeout"],
  ])("a position refused with %s shows %s, with no check-in", async (code, notice) => {
    jest.mocked(Location.getCurrentPositionAsync).mockRejectedValue(locationError(code));
    await open();

    await submit();

    expect(await screen.findByTestId(notice)).toBeTruthy();
    expect(screen.queryByTestId("check-in-submit")).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("on Android with the location switched off, the system's dialog turns it on and the check-in goes", async () => {
    onPlatform("android");
    jest.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(false);
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());
    await open();

    await submit();

    expect(Location.enableNetworkProviderAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(CHECK_IN, SENT, PINNED));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
  });

  it("on Android, declining the dialog shows the location-off notice and asks for no position", async () => {
    onPlatform("android");
    jest.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(false);
    jest
      .mocked(Location.enableNetworkProviderAsync)
      .mockRejectedValue(locationError("ERR_CANCELED"));
    await open();

    await submit();

    expect(await screen.findByTestId("check-in-off")).toBeTruthy();
    expect(Location.enableNetworkProviderAsync).toHaveBeenCalledTimes(1);
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("on iOS with the location switched off, it shows the location-off notice with no dialog", async () => {
    onPlatform("ios");
    jest.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(false);
    await open();

    await submit();

    expect(await screen.findByTestId("check-in-off")).toBeTruthy();
    expect(Location.enableNetworkProviderAsync).not.toHaveBeenCalled();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("when the location switch cannot be read, it asks for the position anyway and checks in", async () => {
    jest.mocked(Location.hasServicesEnabledAsync).mockRejectedValue(new Error("unavailable"));
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());
    await open();

    await submit();

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(CHECK_IN, SENT, PINNED));
    expect(Location.enableNetworkProviderAsync).not.toHaveBeenCalled();
  });

  it("the time limit does not run while Android's turn-on-location dialog is open", async () => {
    jest.useRealTimers();
    fakeClock();
    onPlatform("android");
    jest.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(false);
    const dialog = deferred<void>();
    jest.mocked(Location.enableNetworkProviderAsync).mockReturnValue(dialog.promise);
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());
    await open();

    await submit();
    await act(async () => {
      jest.advanceTimersByTime(proJobsConfig.locationTimeoutMs * 2);
    });

    expect(screen.queryByTestId("check-in-timeout")).toBeNull();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();

    await act(async () => dialog.resolve());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(CHECK_IN, SENT, PINNED));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("check-in-timeout")).toBeNull();
  });

  it("closing the sheet while the position is found sends nothing", async () => {
    const found = deferred<Position>();
    jest.mocked(Location.getCurrentPositionAsync).mockReturnValue(found.promise);
    await open();

    await submit();
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await act(async () => found.resolve(POSITION));

    expect(apiPost).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("offline, the reason shows under the code and the sheet stays", async () => {
    await open();
    jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(true));

    await submit();

    expect(await screen.findByText(OFFLINE)).toBeTruthy();
    expect(codeField().props.accessibilityHint).toBe(OFFLINE);
    expect(router.back).not.toHaveBeenCalled();
    expect(toastStore.getState().current).toBeNull();
  });

  it("the code never reaches a log, the query cache or a mutation", async () => {
    const levels = ["log", "info", "warn", "error", "debug"] as const;
    const spies = levels.map((level) => jest.spyOn(console, level));
    try {
      const client = await open();
      jest
        .mocked(apiPost)
        .mockRejectedValueOnce(wrongCode("2"))
        .mockRejectedValueOnce(new ApiError(500, "internal_error"))
        .mockResolvedValueOnce(arrived());

      await submit();
      expect(await screen.findByText("Code didn't match. 2 tries left.")).toBeTruthy();
      await submit();
      expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
      await submit();
      await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
      expect(apiPost).toHaveBeenCalledTimes(3);

      const mentions = (value: unknown): boolean => {
        if (value instanceof Error) return `${value.message} ${value.stack}`.includes(ARRIVAL_CODE);
        try {
          return (JSON.stringify(value) ?? String(value)).includes(ARRIVAL_CODE);
        } catch {
          return String(value).includes(ARRIVAL_CODE);
        }
      };
      for (const spy of spies) {
        expect(spy.mock.calls.filter((args) => args.some(mentions))).toEqual([]);
      }
      expect(client.getMutationCache().getAll()).toEqual([]);
      const cached = JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      );
      expect(cached).not.toContain(ARRIVAL_CODE);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
