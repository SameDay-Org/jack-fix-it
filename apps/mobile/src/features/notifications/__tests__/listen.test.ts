import type { NotificationResponse } from "expo-notifications";

import { listenForPushTaps } from "../listen";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

const mockNotifications = {
  listener: null as ((response: NotificationResponse) => void) | null,
  last: null as NotificationResponse | null,
  remove: jest.fn(),
  clear: jest.fn(),
};

jest.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: (listener: (response: NotificationResponse) => void) => {
    mockNotifications.listener = listener;
    return { remove: mockNotifications.remove };
  },
  getLastNotificationResponse: () => mockNotifications.last,
  clearLastNotificationResponse: () => {
    mockNotifications.clear();
    mockNotifications.last = null;
  },
}));

const mockReceive = jest.fn();
jest.mock("../pushTaps", () => ({ receivePushTap: (url: unknown) => mockReceive(url) }));

let next = 0;
function response(data: Record<string, unknown>, action = DEFAULT_ACTION): NotificationResponse {
  next += 1;
  return {
    actionIdentifier: action,
    notification: { request: { identifier: `push-${next}`, content: { data } } },
  } as unknown as NotificationResponse;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  mockNotifications.listener = null;
  mockNotifications.last = null;
  jest.clearAllMocks();
});

afterEach(() => stop?.());

describe("listenForPushTaps", () => {
  it("hands over the push that launched the app once, and forgets it", () => {
    const launch = response({ url: "/jobs/a" });
    mockNotifications.last = launch;
    stop = listenForPushTaps();
    expect(mockReceive).toHaveBeenCalledWith("/jobs/a");
    expect(mockNotifications.clear).toHaveBeenCalledTimes(1);

    // The listener can deliver the launch tap too: it opens once.
    mockNotifications.listener?.(launch);
    expect(mockReceive).toHaveBeenCalledTimes(1);
  });

  it("hands over each tap while the app runs", () => {
    stop = listenForPushTaps();
    expect(mockReceive).not.toHaveBeenCalled();
    mockNotifications.listener?.(response({ url: "/requests/a" }));
    mockNotifications.listener?.(response({ url: "/requests/b/job" }));
    expect(mockReceive.mock.calls).toEqual([["/requests/a"], ["/requests/b/job"]]);
  });

  it("hands over a tap without a url as it is: the app opens Home", () => {
    stop = listenForPushTaps();
    mockNotifications.listener?.(response({}));
    expect(mockReceive).toHaveBeenCalledWith(undefined);
  });

  it("ignores a dismissal or another action", () => {
    stop = listenForPushTaps();
    mockNotifications.listener?.(
      response({ url: "/jobs/a" }, "expo.modules.notifications.actions.DISMISSED"),
    );
    expect(mockReceive).not.toHaveBeenCalled();
  });

  it("stops listening", () => {
    listenForPushTaps()();
    expect(mockNotifications.remove).toHaveBeenCalledTimes(1);
  });
});
