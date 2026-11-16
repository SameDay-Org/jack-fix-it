import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { router } from "expo-router";

import { apiGet, apiPost, useSession } from "@/api";

import {
  arrived,
  JOB_ID,
  navigation,
  newQueryClient,
  onTheWay,
  proJob,
  renderWithQuery,
  signedIn,
} from "../../__tests__/helpers";
import { proJobQueryKey } from "../../api";
import { OnTheWaySheet } from "../../OnTheWaySheet";
import { ProJobScreen } from "../../ProJobScreen";
import { followJob, startSharing, stopSharing } from "../sender";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../__tests__/helpers").apiMock(),
  apiPut: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("../../__tests__/helpers").routerMock);
jest.mock("expo-haptics");
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  Accuracy: { Balanced: 3, High: 4 },
}));
jest.mock("expo-task-manager", () => ({ defineTask: jest.fn() }));
// The build without the flag (EXPO_PUBLIC_PRO_LOCATION_SHARING unset or anything but "on").
jest.mock("../config", () => ({
  ...jest.requireActual("../config"),
  sharingConfig: { enabled: false, intervalMs: 10_000 },
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const { mockSignOut } = jest.requireMock<{ mockSignOut: () => void }>("@/api");

/** Every call this build made into the location module. */
const locationCalls = () =>
  [
    Location.getForegroundPermissionsAsync,
    Location.requestForegroundPermissionsAsync,
    Location.startLocationUpdatesAsync,
    Location.stopLocationUpdatesAsync,
    Location.hasStartedLocationUpdatesAsync,
  ].reduce((sum, fn) => sum + jest.mocked(fn).mock.calls.length, 0);

const press = async (testID: string) => {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(testID));
  });
};

beforeEach(() => {
  navigation.reset();
  navigation.setParams({ id: JOB_ID });
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockReset();
  jest.mocked(apiPost).mockReset();
  jest.mocked(router.back).mockClear();
});

describe("sharing off (the flag is not 'on')", () => {
  it("defines no location task", () => {
    expect(TaskManager.defineTask).not.toHaveBeenCalled();
  });

  it("On my way works as today: nothing about the location is read, asked or started", async () => {
    const client = newQueryClient();
    client.setQueryData(proJobQueryKey(JOB_ID, 1), proJob());
    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());
    await renderWithQuery(<OnTheWaySheet />, client);

    await press("on-the-way-preset-20");
    await press("on-the-way-send");
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("share-location-sheet")).toBeNull();
    expect(locationCalls()).toBe(0);
  });

  it("the job screen on the way shows no line about the location and reads no permission", async () => {
    jest.mocked(apiGet).mockResolvedValue(onTheWay());
    await renderWithQuery(<ProJobScreen />);
    await screen.findByTestId("pro-job-title");

    expect(screen.queryByTestId("pro-job-sharing-note")).toBeNull();
    expect(screen.getByTestId("pro-job-arrived")).toBeTruthy();
    expect(locationCalls()).toBe(0);
  });

  it("starting, stopping, a job's answer and a sign-out ask the system nothing", async () => {
    await startSharing(JOB_ID, 1);
    await followJob(arrived());
    await stopSharing();
    mockSignOut();
    await act(async () => undefined);

    expect(locationCalls()).toBe(0);
  });
});
