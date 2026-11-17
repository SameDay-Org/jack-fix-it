import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { SHARING_TASK } from "../sender";

export type Access = "granted" | "askable" | "blocked";
type Permission = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;

/** A permission answer: granted, askable (the system will ask), or refused for good. */
export const permission = (access: Access): Permission =>
  ({
    status: access === "granted" ? "granted" : access === "askable" ? "undetermined" : "denied",
    granted: access === "granted",
    canAskAgain: access !== "blocked",
    expires: "never",
  }) as Permission;

/**
 * Fresh location mocks: the permission reads `access` until the system's prompt answers (a grant
 * unless a test says otherwise, read from then on); the phone's location is on unless `on` is set
 * false (Android's dialog switches it on); and the task runs from a start until a stop, as the
 * system keeps it. `running` can be set to stand for a task the system restored on its own.
 */
export function resetLocation(access: Access = "granted") {
  const task = { running: false, access, on: true };
  jest
    .mocked(Location.hasServicesEnabledAsync)
    .mockReset()
    .mockImplementation(async () => task.on);
  jest
    .mocked(Location.enableNetworkProviderAsync)
    .mockReset()
    .mockImplementation(async () => {
      task.on = true;
    });
  jest
    .mocked(Location.getForegroundPermissionsAsync)
    .mockReset()
    .mockImplementation(async () => permission(task.access));
  jest
    .mocked(Location.requestForegroundPermissionsAsync)
    .mockReset()
    .mockImplementation(async () => {
      task.access = "granted";
      return permission(task.access);
    });
  jest
    .mocked(Location.startLocationUpdatesAsync)
    .mockReset()
    .mockImplementation(async () => {
      task.running = true;
    });
  jest
    .mocked(Location.stopLocationUpdatesAsync)
    .mockReset()
    .mockImplementation(async () => {
      task.running = false;
    });
  jest
    .mocked(Location.hasStartedLocationUpdatesAsync)
    .mockReset()
    .mockImplementation(async () => task.running);
  return task;
}

/** How many times the location task was started (every start uses the one task name). */
export const starts = () => jest.mocked(Location.startLocationUpdatesAsync).mock.calls.length;
export const stops = () => jest.mocked(Location.stopLocationUpdatesAsync).mock.calls.length;

/** Sentinel coordinates: the PUT body may carry them, nothing else may. */
export const LAT = 26.1189;
export const LNG = -80.1365;

export const fix = (timestamp: number, coords: Partial<Location.LocationObjectCoords> = {}) =>
  ({
    coords: {
      latitude: LAT,
      longitude: LNG,
      altitude: null,
      accuracy: 25,
      altitudeAccuracy: null,
      heading: 90,
      speed: 12,
      ...coords,
    },
    timestamp,
  }) as Location.LocationObject;

type TaskBody = Parameters<TaskManager.TaskManagerTaskExecutor>[0];

/** Hands the location task what the system would: fixes, or an error. */
export function deliver(locations: Location.LocationObject[], error: TaskBody["error"] = null) {
  const call = jest
    .mocked(TaskManager.defineTask)
    .mock.calls.find(([name]) => name === SHARING_TASK);
  if (!call) throw new Error("the location task is not defined");
  const body: TaskBody = {
    data: { locations },
    error,
    executionInfo: { eventId: "event", taskName: SHARING_TASK },
  };
  return call[1](body);
}

/** Everything written to the console, as one string. */
export function consoleText(spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((value: unknown) => {
      if (value instanceof Error) return `${value.name} ${value.message} ${value.stack ?? ""}`;
      try {
        return typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join("\n");
}
