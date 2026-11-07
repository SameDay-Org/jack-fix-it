import i18n from "@/i18n";

import { QueryClientProvider } from "@tanstack/react-query";
import { Slot } from "expo-router";
import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { createElement, useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, Text } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Reanimated from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  apiGet,
  apiPost,
  isCurrentGeneration,
  NetworkError,
  sessionGeneration,
  useSession,
  useSessionGeneration,
} from "@/api";
import type { GetResponse } from "@/api";

import { METRICS } from "../../auth/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import type { CustomerJob } from "../../jobs/phase";
import { freezeClock, newQueryClient, NOW } from "../../quotes/__tests__/helpers";
import { ChatScreen } from "../ChatScreen";
import type { ChatMessage, ChatPage } from "../thread";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(),
  apiConfig: { timeoutMs: 15_000 },
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  useSessionGeneration: jest.fn(() => 1),
  setSessionUser: jest.fn(),
  useSession: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
}));

type ProJob = GetResponse<"/v1/pros/me/jobs/{job_id}">;
type Session = ReturnType<typeof useSession>;
type ApiOptions = {
  generation?: number;
  params?: Record<string, string>;
  query?: { cursor?: string };
};
type PostBody = { body?: string; up_to?: string };

const JOB_ID = "9a000000-0000-4000-8000-000000000074";
const REQUEST_ID = "6f1c2a40-0000-4000-8000-000000000074";
const MESSAGES_PATH = "/v1/jobs/{job_id}/messages";
const READ_PATH = "/v1/jobs/{job_id}/messages/read";
const CUSTOMER_JOB_PATH = "/v1/requests/{request_id}/job";
const PRO_JOB_PATH = "/v1/pros/me/jobs/{job_id}";
const CUSTOMER_URL = `/jobs/${JOB_ID}/chat?request=${REQUEST_ID}`;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const FAILED = "Not sent. Tap to try again.";

// Every message body and typed text of this file: none may ever reach the console.
const BODIES = new Set<string>();
const remember = (text: string): string => {
  BODIES.add(text);
  return text;
};

const messageId = (n: number) => `7c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A stored message, `n` minutes before NOW unless the test says when. */
const message = (n: number, overrides: Partial<ChatMessage> = {}): ChatMessage => {
  const built: ChatMessage = {
    id: messageId(n),
    sender: "pro",
    body: `Message number ${n} about the faucet`,
    redacted: false,
    created_at: iso(-n * MINUTE_MS),
    ...overrides,
  };
  remember(built.body);
  return built;
};

const page = (items: ChatMessage[], overrides: Partial<ChatPage> = {}): ChatPage => ({
  items,
  next_cursor: null,
  unread_count: 0,
  ...overrides,
});

const customerJob = (overrides: Partial<CustomerJob> = {}): CustomerJob => ({
  id: JOB_ID,
  status: "scheduled",
  customer_status: "customerStatus.scheduled",
  scheduled_start_at: iso(DAY_MS),
  pro: {
    id: "00000000-0000-4000-8000-000000000202",
    name: "Dan R.",
    rating_avg: "4.80",
    jobs_count: 12,
    years_of_experience: 8,
    verified: true,
  },
  eta_at: null,
  arrival_code: null,
  timeline: [{ type: "created", status: "scheduled", at: iso(-2 * 60 * MINUTE_MS) }],
  amount_cents: 18_000,
  tax_cents: 0,
  customer_total_cents: 18_000,
  photos: { before: [], after: [], pending: 0 },
  // The confirmation window (#66): not open on these jobs.
  confirm_by: null,
  unread_messages: 0,
  ...overrides,
});

const proJob = (overrides: Partial<ProJob> = {}): ProJob => ({
  id: JOB_ID,
  status: "scheduled",
  scheduled_start_at: iso(DAY_MS),
  category: null,
  description: "Replace the kitchen faucet.",
  address: null,
  customer_first_name: "Jamie",
  eta_at: null,
  checked_in_at: null,
  arrival_code_locked: false,
  started_at: null,
  completed_at: null,
  photos: { before: [], after: [] },
  pro_payout_cents: 15_300,
  unread_messages: 0,
  ...overrides,
});

// What the mocked API answers, per test.
const mockApi = {
  customerJob: customerJob(),
  proJob: proJob(),
  messages: (_options: ApiOptions): Promise<ChatPage> => Promise.resolve(page([])),
  send: (body: string): Promise<ChatMessage> =>
    Promise.resolve(message(900, { sender: "me", body, created_at: iso(0) })),
  read: (_upTo: string): Promise<{ unread_count: number }> => Promise.resolve({ unread_count: 0 }),
};

// The session as a store, as the real one is: switching it re-renders every reader.
const sessionStore = {
  value: signedIn({ role: "customer" }) as Session,
  generation: 1,
  listeners: new Set<() => void>(),
};
const subscribeSession = (listener: () => void) => {
  sessionStore.listeners.add(listener);
  return () => {
    sessionStore.listeners.delete(listener);
  };
};

let client = newQueryClient();

function Root() {
  return createElement(
    GestureHandlerRootView,
    { style: { flex: 1 } },
    createElement(
      SafeAreaProvider,
      { initialMetrics: METRICS },
      createElement(QueryClientProvider, { client }, createElement(Slot)),
    ),
  );
}

function HomeStub() {
  return <Text testID="home-stub">home</Text>;
}

const routes = {
  _layout: Root,
  index: HomeStub,
  "jobs/[id]/chat": ChatScreen,
};

const postCalls = (path: string) =>
  (jest.mocked(apiPost).mock.calls as unknown as [string, PostBody, ApiOptions?][]).filter(
    ([called]) => called === path,
  );

/** Lets every queued promise run (renderRouter's timers are fake: no real wait settles it). */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

const renderChat = (initialUrl = CUSTOMER_URL) => renderRouter(routes, { initialUrl });

const sendButton = () => screen.getByTestId("chat-send");

async function type(text: string): Promise<void> {
  remember(text);
  await act(async () => fireEvent.changeText(screen.getByTestId("chat-input"), text));
}

async function typeAndSend(text: string): Promise<void> {
  await type(text);
  await act(async () => fireEvent.press(sendButton()));
}

type SeenToken = { item: unknown; key: string; index: number; isViewable: boolean };
type SeenPairs = {
  onViewableItemsChanged: (info: { viewableItems: SeenToken[]; changed: SeenToken[] }) => void;
}[];

/**
 * What the list reports once these stored messages are on screen, through every rule it was
 * given (no layout runs under Jest, so the list never measures what it shows on its own).
 */
const see = (...shown: ChatMessage[]) =>
  act(async () => {
    const pairs = screen.getByTestId("chat-list").props.viewabilityConfigCallbackPairs as
      SeenPairs | undefined;
    if (!pairs) throw new Error("the chat list reports nothing it shows");
    const tokens = shown.map((stored, index) => ({
      item: { kind: "message", key: stored.id, message: stored },
      key: stored.id,
      index,
      isViewable: true,
    }));
    for (const pair of pairs)
      pair.onViewableItemsChanged({ viewableItems: tokens, changed: tokens });
  });

/** Everything a console call could print: objects as JSON too, errors with message and stack. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name} ${value.message} ${value.stack ?? ""}`;
  try {
    return `${JSON.stringify(value)} ${String(value)}`;
  } catch {
    return String(value);
  }
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
const consoleSpies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method));

beforeEach(() => {
  jest.clearAllMocks();
  freezeClock();
  client = newQueryClient();
  jest.mocked(AppState.addEventListener).mockClear();
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  // The loading skeleton's pulse never settles under fake timers.
  jest.spyOn(Reanimated, "useReducedMotion").mockReturnValue(true);

  sessionStore.value = signedIn({ role: "customer" });
  sessionStore.generation = 1;
  sessionStore.listeners.clear();
  jest
    .mocked(useSession)
    .mockImplementation(() => useSyncExternalStore(subscribeSession, () => sessionStore.value));
  jest
    .mocked(useSessionGeneration)
    .mockImplementation(() =>
      useSyncExternalStore(subscribeSession, () => sessionStore.generation),
    );
  jest.mocked(sessionGeneration).mockImplementation(() => sessionStore.generation);
  jest
    .mocked(isCurrentGeneration)
    .mockImplementation((generation: number) => generation === sessionStore.generation);

  mockApi.customerJob = customerJob();
  mockApi.proJob = proJob();
  mockApi.messages = () => Promise.resolve(page([]));
  mockApi.send = (body) =>
    Promise.resolve(message(900, { sender: "me", body, created_at: iso(0) }));
  mockApi.read = () => Promise.resolve({ unread_count: 0 });

  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation((async (path: string, options?: ApiOptions) => {
      if (path === MESSAGES_PATH) return mockApi.messages(options ?? {});
      if (path === CUSTOMER_JOB_PATH) return mockApi.customerJob;
      if (path === PRO_JOB_PATH) return mockApi.proJob;
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as typeof apiGet);
  jest
    .mocked(apiPost)
    .mockReset()
    .mockImplementation((async (path: string, body: PostBody) => {
      if (path === MESSAGES_PATH) return mockApi.send(body.body ?? "");
      if (path === READ_PATH) return mockApi.read(body.up_to ?? "");
      throw new Error(`unexpected POST ${path}`);
    }) as unknown as typeof apiPost);
});

afterEach(async () => {
  // No message body, stored or typed, is ever written to the console.
  for (const spy of consoleSpies) {
    for (const args of spy.mock.calls) {
      const written = args.map(stringify).join(" ");
      for (const body of BODIES) expect(written).not.toContain(body);
    }
  }
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("Vault: a viewport completely consumed by the keyboard/composer", () => {
  it.each([0, 8, 16, 400])(
    "only marks a visible reply with the measured viewport at %i dp",
    async (height) => {
      const previous = [message(1)];
      mockApi.messages = () => Promise.resolve(page(previous));
      await renderChat();
      await screen.findByTestId("chat-list");
      await type(Array.from({ length: 5 }, (_, i) => `Unsent composer line ${i}`).join("\n"));
      await act(async () => {
        fireEvent(screen.getByTestId("chat-list"), "layout", {
          nativeEvent: { layout: { x: 0, y: 0, width: 320, height } },
        });
      });
      await see(); // the native list reports no visible message
      const reply = message(940, { created_at: iso(MINUTE_MS) });
      await act(async () =>
        client.setQueryData(["chat", JOB_ID, 1], {
          messages: [reply, ...previous],
          olderCursor: null,
          unreadCount: 1,
        }),
      );
      await screen.findByTestId(`chat-message-${reply.id}`);
      await see();
      await flush();
      const beforeVisible = postCalls(READ_PATH).filter(
        ([, body]) => body.up_to === reply.id,
      ).length;
      await act(async () => {
        fireEvent(screen.getByTestId("chat-list"), "layout", {
          nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } },
        });
      });
      await see(reply);
      await flush();
      const afterVisible = postCalls(READ_PATH).filter(
        ([, body]) => body.up_to === reply.id,
      ).length;
      expect({ beforeVisible, afterVisible }).toEqual({
        beforeVisible: height === 400 ? 1 : 0,
        afterVisible: 1,
      });
    },
  );

  it.each([0, 400])(
    "requires visible pixels even with measured local rows at viewport %i dp",
    async (height) => {
      const previous = [message(1)];
      mockApi.messages = () => Promise.resolve(page(previous));
      mockApi.send = () => Promise.reject(new NetworkError(false));
      await renderChat();
      await screen.findByTestId("chat-input");
      await typeAndSend("A failed message below the future reply");
      await screen.findByText(FAILED);
      await see();
      const reply = message(941, { created_at: iso(MINUTE_MS) });
      await act(async () =>
        client.setQueryData(["chat", JOB_ID, 1], {
          messages: [reply, ...previous],
          olderCursor: null,
          unreadCount: 1,
        }),
      );
      await screen.findByTestId(`chat-message-${reply.id}`);
      await act(async () => {
        for (const [testID, rowHeight] of [
          ["chat-list", height],
          ["chat-row-local-1-1", 80],
          [`chat-row-${reply.id}`, 60],
        ] as const) {
          fireEvent(screen.getByTestId(testID), "layout", {
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: rowHeight } },
          });
        }
      });
      await see();
      await flush();
      expect(postCalls(READ_PATH).filter(([, body]) => body.up_to === reply.id)).toHaveLength(
        height === 400 ? 1 : 0,
      );
    },
  );
});
