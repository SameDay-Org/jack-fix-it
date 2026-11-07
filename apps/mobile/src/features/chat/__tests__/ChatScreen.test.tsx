import i18n from "@/i18n";

import { QueryClientProvider } from "@tanstack/react-query";
import { Slot } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor, within } from "expo-router/testing-library";
import { createElement, useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, Text } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Reanimated from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  ApiError,
  apiGet,
  apiPost,
  isCurrentGeneration,
  NetworkError,
  SessionExpiredError,
  sessionGeneration,
  useSession,
  useSessionGeneration,
} from "@/api";
import type { GetResponse } from "@/api";
import { RECEIPT_SEEN } from "@/components/ui";
import { formatTimeOfDay } from "@/features/opportunities/format";
import { formatLocale } from "@/features/quotes/format";

import { deferred } from "../../../api/__tests__/helpers";
import { METRICS } from "../../auth/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import type { CustomerJob, JobStatus } from "../../jobs/phase";
import { freezeClock, newQueryClient, NOW } from "../../quotes/__tests__/helpers";
import { ChatScreen } from "../ChatScreen";
import { MESSAGE_COUNTER_FROM, MESSAGE_MAX_LENGTH } from "../config";
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
const PRO_URL = `/jobs/${JOB_ID}/chat`;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const START = "This is the start of your messages about this job.";
const FAILED = "Not sent. Tap to try again.";
const TOO_FAST = "You're sending messages too fast. Wait a moment, then try again.";
const CLOSED = "This chat is closed";
const REDACTED_NOTE = "We hid contact details. Keep the conversation in Jack Fix It.";

// Every message body and typed text of this file: none may ever reach the console.
const BODIES = new Set<string>();
const remember = (text: string): string => {
  BODIES.add(text);
  return text;
};

// The receipt ticks are decorative (hidden from accessibility); tests reach them anyway.
const HIDDEN = { includeHiddenElements: true };

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
const SIGNED_OUT_SESSION: Session = {
  status: "signedOut",
  user: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
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
function setSession(value: Session, generation: number): void {
  sessionStore.value = value;
  sessionStore.generation = generation;
  sessionStore.listeners.forEach((listener) => listener());
}

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

const getCalls = (path: string) =>
  (jest.mocked(apiGet).mock.calls as unknown as [string, ApiOptions?][]).filter(
    ([called]) => called === path,
  );
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

const timeOf = (stored: ChatMessage) =>
  formatTimeOfDay(Date.parse(stored.created_at), formatLocale());

const sendButton = () => screen.getByTestId("chat-send");
const sendDisabled = () =>
  (sendButton().props.accessibilityState as { disabled?: boolean }).disabled === true;

async function type(text: string): Promise<void> {
  remember(text);
  await act(async () => fireEvent.changeText(screen.getByTestId("chat-input"), text));
}

async function typeAndSend(text: string): Promise<void> {
  await type(text);
  await act(async () => fireEvent.press(sendButton()));
}

type EndReached = (info: { distanceFromEnd: number }) => void;

/** What the list does when it is scrolled near its top (its end, the list being upside down). */
const reachTop = () =>
  act(async () => {
    const onEndReached = screen.getByTestId("chat-list").props.onEndReached as
      EndReached | undefined;
    if (!onEndReached) throw new Error("the chat list has no onEndReached");
    onEndReached({ distanceFromEnd: 0 });
  });

const olderCalls = () => getCalls(MESSAGES_PATH).filter(([, options]) => options?.query);

const announcements = () =>
  jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([said]) => said);

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

describe("the job chat screen (#74)", () => {
  describe("header", () => {
    it("shows the pro's first name, initials and role to the customer", async () => {
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      await renderChat();
      await screen.findByTestId("chat-list");

      const bar = await screen.findByTestId("chat-top-bar");
      await waitFor(() =>
        expect(within(bar).getByTestId("chat-peer-name").props.children).toBe("Dan"),
      );
      expect(within(bar).getByText("Your pro on this job")).toBeTruthy();
      // The avatar is decorative (the name beside it says who): hidden, but drawn with initials.
      expect(within(bar).getByText("DR", HIDDEN)).toBeTruthy();
      expect(within(bar).getByLabelText("Dan R.", HIDDEN)).toBeTruthy();
      expect(within(bar).queryByLabelText("Dan R.")).toBeNull();
      expect(getCalls(CUSTOMER_JOB_PATH)[0]?.[1]?.params).toEqual({ request_id: REQUEST_ID });
      expect(getCalls(PRO_JOB_PATH)).toHaveLength(0);
    });

    it("shows the customer's first name and role to a pro", async () => {
      setSession(signedIn({ role: "pro" }), 1);
      mockApi.messages = () => Promise.resolve(page([message(1, { sender: "customer" })]));
      await renderChat(PRO_URL);
      await screen.findByTestId("chat-list");

      const bar = screen.getByTestId("chat-top-bar");
      await waitFor(() =>
        expect(within(bar).getByTestId("chat-peer-name").props.children).toBe("Jamie"),
      );
      expect(within(bar).getByText("Your customer on this job")).toBeTruthy();
      expect(within(bar).getByText("J", HIDDEN)).toBeTruthy();
      expect(getCalls(PRO_JOB_PATH)[0]?.[1]?.params).toEqual({ job_id: JOB_ID });
      expect(getCalls(CUSTOMER_JOB_PATH)).toHaveLength(0);
    });

    it("falls back to 'Your pro' when the API withholds the pro's name", async () => {
      mockApi.customerJob = customerJob({ pro: { ...customerJob().pro, name: null } });
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      await renderChat();
      await screen.findByTestId("chat-list");

      await waitFor(() =>
        expect(screen.getByTestId("chat-peer-name").props.children).toBe("Your pro"),
      );
      expect(screen.getByText("Your pro on this job")).toBeTruthy();
    });

    it("draws no initials for a withheld name, never the fallback's", async () => {
      mockApi.customerJob = customerJob({ pro: { ...customerJob().pro, name: null } });
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      await renderChat();
      await screen.findByTestId("chat-list");
      await waitFor(() =>
        expect(screen.getByTestId("chat-peer-name").props.children).toBe("Your pro"),
      );

      const bar = screen.getByTestId("chat-top-bar");
      expect(within(bar).queryByText("YP", HIDDEN)).toBeNull();
      expect(within(bar).queryByText("Y", HIDDEN)).toBeNull();
      expect(within(bar).queryByLabelText("Your pro", HIDDEN)).toBeNull();
    });

    it("the empty state draws no initials for a withheld name either", async () => {
      mockApi.customerJob = customerJob({ pro: { ...customerJob().pro, name: null } });
      await renderChat();
      const empty = await screen.findByTestId("chat-empty");
      await waitFor(() => expect(within(empty).getByText("Say hello to your pro")).toBeTruthy());

      expect(within(empty).queryByText("YP", HIDDEN)).toBeNull();
      expect(within(empty).queryByText("Y", HIDDEN)).toBeNull();
      expect(screen.getByTestId("chat-peer-name").props.children).toBe("Your pro");
    });
  });

  describe("loading and empty", () => {
    it("shows the skeleton while the first page is on its way, then the list", async () => {
      const held = deferred<ChatPage>();
      mockApi.messages = () => held.promise;
      await renderChat();

      expect(screen.getByTestId("chat-loading")).toBeTruthy();
      expect(screen.queryByTestId("chat-list")).toBeNull();
      expect(screen.queryByTestId("chat-input")).toBeNull();

      const first = message(1);
      await act(async () => held.resolve(page([first])));
      await flush();

      expect(await screen.findByTestId("chat-list")).toBeTruthy();
      expect(screen.queryByTestId("chat-loading")).toBeNull();
      expect(screen.getByText(first.body)).toBeTruthy();
      expect(screen.getByTestId("chat-input")).toBeTruthy();
    });

    it("an empty thread says hello to the pro", async () => {
      await renderChat();

      const empty = await screen.findByTestId("chat-empty");
      await waitFor(() => expect(within(empty).getByText("Say hello to Dan")).toBeTruthy());
      expect(screen.queryByTestId("chat-list")).toBeNull();
      expect(screen.getByTestId("chat-input")).toBeTruthy();
    });

    it("an empty thread on a closed job says nothing was sent, with no hello", async () => {
      mockApi.customerJob = customerJob({ status: "confirmed" });
      await renderChat();

      expect(await screen.findByTestId("chat-closed")).toBeTruthy();
      const empty = screen.getByTestId("chat-empty");
      expect(within(empty).getByText("No messages here")).toBeTruthy();
      expect(
        within(empty).getByText("Nothing was sent in this chat before it closed."),
      ).toBeTruthy();
      expect(screen.queryByText("Say hello to Dan")).toBeNull();
      expect(screen.queryByTestId("chat-input")).toBeNull();
    });
  });

  describe("bubbles", () => {
    it("draws theirs and mine with who, when and what, under Today and Yesterday", async () => {
      const theirs = message(1, {
        sender: "pro",
        body: remember("The part arrives tomorrow morning."),
        created_at: iso(-DAY_MS),
      });
      const mine = message(2, {
        sender: "me",
        body: remember("Great, see you then."),
        created_at: iso(-MINUTE_MS),
      });
      mockApi.messages = () => Promise.resolve(page([mine, theirs]));
      await renderChat();
      await screen.findByTestId("chat-list");
      await waitFor(() => expect(screen.getByTestId("chat-peer-name")).toBeTruthy());

      const theirsBubble = screen.getByTestId(`chat-message-${theirs.id}`);
      const mineBubble = screen.getByTestId(`chat-message-${mine.id}`);
      expect(within(theirsBubble).getByText(theirs.body)).toBeTruthy();
      expect(within(mineBubble).getByText(mine.body)).toBeTruthy();
      expect(theirsBubble.props.accessibilityLabel).toBe(`Dan, ${timeOf(theirs)}: ${theirs.body}`);
      // Without a receipt from the API yet (#331), a stored message of mine reads as sent.
      expect(mineBubble.props.accessibilityLabel).toBe(`You, ${timeOf(mine)}: ${mine.body}. Sent`);
      expect(within(mineBubble).getAllByTestId("chat-receipt-tick", HIDDEN)).toHaveLength(1);
      // Theirs carries its time, never a receipt.
      expect(within(theirsBubble).getByTestId("chat-time").props.children).toBe(timeOf(theirs));
      expect(within(theirsBubble).queryByTestId("chat-receipt", HIDDEN)).toBeNull();
      expect(screen.getByText("Today")).toBeTruthy();
      expect(screen.getByText("Yesterday")).toBeTruthy();
      expect(screen.getByText(START)).toBeTruthy();
    });

    it.each([
      ["sent", "Sent", 1, false],
      ["delivered", "Delivered", 2, false],
      ["seen", "Seen", 2, true],
    ] as const)(
      "marks my message %s: says %s, draws %i tick(s), light blue only when seen",
      async (receipt, spoken, ticks, blue) => {
        // The receipt field arrives with #331; the fixture carries it ahead of the contract.
        const mine = { ...message(1, { sender: "me" }), receipt } as ChatMessage;
        mockApi.messages = () => Promise.resolve(page([mine]));
        await renderChat();
        await screen.findByTestId("chat-list");

        const bubble = screen.getByTestId(`chat-message-${mine.id}`);
        expect(bubble.props.accessibilityLabel).toBe(
          `You, ${timeOf(mine)}: ${mine.body}. ${spoken}`,
        );
        expect(within(bubble).getAllByTestId("chat-receipt-tick", HIDDEN)).toHaveLength(ticks);
        const stroke = within(bubble).getByTestId("chat-receipt", HIDDEN).props.stroke as string;
        expect(stroke === RECEIPT_SEEN).toBe(blue);
      },
    );

    it("every bubble carries its own time, each bubble of one run too", async () => {
      const newerTheirs = message(1, { sender: "pro" });
      const olderTheirs = message(2, { sender: "pro" });
      const mine = message(7, { sender: "me" });
      mockApi.messages = () => Promise.resolve(page([newerTheirs, olderTheirs, mine]));
      await renderChat();
      await screen.findByTestId("chat-list");

      expect(screen.getAllByTestId("chat-time")).toHaveLength(3);
      for (const stored of [newerTheirs, olderTheirs, mine]) {
        const bubble = screen.getByTestId(`chat-message-${stored.id}`);
        expect(within(bubble).getAllByTestId("chat-time")).toHaveLength(1);
        expect(within(bubble).getByTestId("chat-time").props.children).toBe(timeOf(stored));
      }
      // One run (a minute apart): two different times, one per bubble.
      expect(timeOf(newerTheirs)).not.toBe(timeOf(olderTheirs));
    });

    it("theirs never shows a receipt, even when the answer carries one", async () => {
      const theirs = { ...message(1, { sender: "pro" }), receipt: "seen" } as ChatMessage;
      mockApi.messages = () => Promise.resolve(page([theirs]));
      await renderChat();
      await screen.findByTestId("chat-list");
      await waitFor(() => expect(screen.getByTestId("chat-peer-name")).toBeTruthy());

      const bubble = screen.getByTestId(`chat-message-${theirs.id}`);
      expect(within(bubble).queryByTestId("chat-receipt", HIDDEN)).toBeNull();
      expect(bubble.props.accessibilityLabel).toBe(`Dan, ${timeOf(theirs)}: ${theirs.body}`);
    });

    it("an unknown receipt reads as sent", async () => {
      const mine = { ...message(1, { sender: "me" }), receipt: "read" } as ChatMessage;
      mockApi.messages = () => Promise.resolve(page([mine]));
      await renderChat();
      await screen.findByTestId("chat-list");

      const bubble = screen.getByTestId(`chat-message-${mine.id}`);
      expect(bubble.props.accessibilityLabel).toBe(`You, ${timeOf(mine)}: ${mine.body}. Sent`);
      expect(within(bubble).getAllByTestId("chat-receipt-tick", HIDDEN)).toHaveLength(1);
    });

    it("notes the masking under my redacted message only", async () => {
      const mineRedacted = message(1, {
        sender: "me",
        body: remember("Call me at •••"),
        redacted: true,
      });
      const theirsRedacted = message(2, {
        sender: "pro",
        body: remember("Text me at •••"),
        redacted: true,
      });
      const mineClean = message(3, { sender: "me", body: remember("Thanks for the update.") });
      mockApi.messages = () => Promise.resolve(page([mineRedacted, theirsRedacted, mineClean]));
      await renderChat();
      await screen.findByTestId("chat-list");

      expect(screen.getAllByTestId("chat-redacted-note")).toHaveLength(1);
      const redactedBubble = screen.getByTestId(`chat-message-${mineRedacted.id}`);
      expect(within(redactedBubble).getByTestId("chat-redacted-note").props.children).toBe(
        REDACTED_NOTE,
      );
      expect(redactedBubble.props.accessibilityLabel).toContain(REDACTED_NOTE);
      for (const other of [theirsRedacted, mineClean]) {
        const bubble = screen.getByTestId(`chat-message-${other.id}`);
        expect(within(bubble).queryByTestId("chat-redacted-note")).toBeNull();
        expect(bubble.props.accessibilityLabel).not.toContain(REDACTED_NOTE);
      }
    });
  });

  describe("older messages", () => {
    it("loads the page before the oldest one through the cursor", async () => {
      const newest = message(1);
      const older = message(90, { body: remember("An older message from the start.") });
      mockApi.messages = (options) =>
        Promise.resolve(
          options.query?.cursor === "cursor-1"
            ? page([older])
            : page([newest], { next_cursor: "cursor-1" }),
        );
      await renderChat();
      await screen.findByTestId("chat-list");

      const load = screen.getByTestId("chat-older-load");
      expect(load.props.accessibilityLabel).toBe("Load older messages");
      expect(screen.queryByText(START)).toBeNull();

      await act(async () => fireEvent.press(load));
      await flush();

      const olderCalls = getCalls(MESSAGES_PATH).filter(([, options]) => options?.query);
      expect(olderCalls).toHaveLength(1);
      expect(olderCalls[0]?.[1]?.query).toEqual({ cursor: "cursor-1" });
      expect(olderCalls[0]?.[1]?.params).toEqual({ job_id: JOB_ID });
      expect(await screen.findByTestId(`chat-message-${older.id}`)).toBeTruthy();
      expect(screen.getByTestId(`chat-message-${newest.id}`)).toBeTruthy();
      expect(screen.getByText(START)).toBeTruthy();
      expect(screen.queryByTestId("chat-older-load")).toBeNull();
    });

    it("reaching the top at rest asks for the older page once", async () => {
      const newest = message(1);
      const older = message(91, { body: remember("An older message about the shutoff valve.") });
      mockApi.messages = (options) =>
        Promise.resolve(
          options.query?.cursor === "cursor-1"
            ? page([older])
            : page([newest], { next_cursor: "cursor-1" }),
        );
      await renderChat();
      await screen.findByTestId("chat-list");
      expect(olderCalls()).toHaveLength(0);

      await reachTop();
      await flush();

      expect(olderCalls()).toHaveLength(1);
      expect(olderCalls()[0]?.[1]?.query).toEqual({ cursor: "cursor-1" });
      expect(await screen.findByTestId(`chat-message-${older.id}`)).toBeTruthy();
    });

    it("after a failed page only the button asks again: reaching the top asks nothing", async () => {
      const newest = message(1);
      const older = message(92, { body: remember("An older message about the water heater.") });
      let olderAsks = 0;
      mockApi.messages = (options) => {
        if (options.query?.cursor !== "cursor-1") {
          return Promise.resolve(page([newest], { next_cursor: "cursor-1" }));
        }
        olderAsks += 1;
        return olderAsks === 1
          ? Promise.reject(new NetworkError(false))
          : Promise.resolve(page([older]));
      };
      await renderChat();
      await screen.findByTestId("chat-list");

      await reachTop();
      await flush();

      expect(olderCalls()).toHaveLength(1);
      const footer = screen.getByTestId("chat-older");
      expect(within(footer).getByText("We couldn't load older messages.")).toBeTruthy();
      expect(screen.getByTestId("chat-older-load").props.accessibilityLabel).toBe("Try again");

      await reachTop();
      await flush();
      expect(olderCalls()).toHaveLength(1);
      expect(screen.getByTestId("chat-older-load").props.accessibilityLabel).toBe("Try again");

      await act(async () => fireEvent.press(screen.getByTestId("chat-older-load")));
      await flush();

      expect(olderCalls()).toHaveLength(2);
      expect(olderCalls()[1]?.[1]?.query).toEqual({ cursor: "cursor-1" });
      expect(await screen.findByTestId(`chat-message-${older.id}`)).toBeTruthy();
      expect(screen.queryByText("We couldn't load older messages.")).toBeNull();
      expect(screen.getByText(START)).toBeTruthy();
    });

    it("says where the conversation starts when there is no cursor", async () => {
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      await renderChat();
      await screen.findByTestId("chat-list");

      expect(screen.getByText(START)).toBeTruthy();
      expect(screen.queryByTestId("chat-older-load")).toBeNull();
    });
  });

  describe("composer", () => {
    beforeEach(() => {
      mockApi.messages = () => Promise.resolve(page([message(1)]));
    });

    it("sends only once the field holds something", async () => {
      await renderChat();
      await screen.findByTestId("chat-input");

      expect(sendDisabled()).toBe(true);
      await type("   ");
      expect(sendDisabled()).toBe(true);
      await type("Hi");
      expect(sendDisabled()).toBe(false);
    });

    it("counts down near the limit and refuses a message over it", async () => {
      await renderChat();
      await screen.findByTestId("chat-input");

      await type("a".repeat(MESSAGE_MAX_LENGTH - MESSAGE_COUNTER_FROM - 1));
      expect(screen.queryByTestId("chat-counter")).toBeNull();
      expect(sendDisabled()).toBe(false);

      await type("a".repeat(MESSAGE_MAX_LENGTH - MESSAGE_COUNTER_FROM));
      expect(screen.getByTestId("chat-counter").props.children).toBe(
        `${MESSAGE_COUNTER_FROM} characters left`,
      );
      expect(sendDisabled()).toBe(false);

      await type("a".repeat(MESSAGE_MAX_LENGTH + 3));
      expect(screen.getByTestId("chat-counter").props.children).toBe("3 characters over the limit");
      expect(sendDisabled()).toBe(true);
    });

    it("counts an emoji as one character, as the API does", async () => {
      await renderChat();
      await screen.findByTestId("chat-input");

      await type("😀".repeat(MESSAGE_MAX_LENGTH));
      expect(screen.getByTestId("chat-counter").props.children).toBe("0 characters left");
      expect(sendDisabled()).toBe(false);
    });

    it("sends the text trimmed, for this job and session", async () => {
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend("  Hello there  ");
      await flush();

      const sent = postCalls(MESSAGES_PATH);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.[1]).toEqual({ body: "Hello there" });
      expect(sent[0]?.[2]).toEqual(
        expect.objectContaining({ generation: 1, params: { job_id: JOB_ID } }),
      );
    });
  });

  describe("sending", () => {
    beforeEach(() => {
      mockApi.messages = () => Promise.resolve(page([message(5)]));
    });

    it("shows the message at once, then the stored (masked) one", async () => {
      const held = deferred<ChatMessage>();
      mockApi.send = () => held.promise;
      await renderChat();
      await screen.findByTestId("chat-input");

      const typed = "Call me at 555 123 4567";
      await typeAndSend(typed);

      // On its way: the faded bubble with a small clock where its time and ticks will be.
      const pendingBubble = screen.getByTestId(/^chat-pending-/);
      expect(within(pendingBubble).getByTestId("chat-receipt-clock", HIDDEN)).toBeTruthy();
      expect(pendingBubble.props.accessibilityLabel).toBe(`You, sending: ${typed}`);
      expect(screen.queryByTestId("chat-pending-status")).toBeNull();
      expect(screen.getByText(typed)).toBeTruthy();
      expect(screen.getByTestId("chat-input").props.value).toBe("");
      // The next message waits for this one, even with text in the field.
      await type("And one more thing");
      expect(sendDisabled()).toBe(true);

      const stored = message(901, {
        sender: "me",
        body: remember("Call me at •••"),
        redacted: true,
        created_at: iso(0),
      });
      await act(async () => held.resolve(stored));
      await flush();

      const bubble = await screen.findByTestId(`chat-message-${stored.id}`);
      expect(within(bubble).getByText(stored.body)).toBeTruthy();
      expect(within(bubble).getByTestId("chat-redacted-note")).toBeTruthy();
      expect(screen.queryByTestId("chat-pending-status")).toBeNull();
      expect(screen.queryByText(typed)).toBeNull();
      expect(sendDisabled()).toBe(false);
      expect(announcements()).toEqual(["Message sent"]);
    });

    it("offline: the bubble says it was not sent, and a tap sends it again", async () => {
      const typed = "Running ten minutes late";
      const stored = message(902, { sender: "me", body: typed, created_at: iso(0) });
      let attempts = 0;
      mockApi.send = () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new NetworkError(false)) : Promise.resolve(stored);
      };
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend(typed);
      await flush();

      expect(screen.getByTestId("chat-pending-status").props.children).toBe(FAILED);
      expect(announcements()).toEqual(["Message not sent"]);
      expect(screen.queryByTestId("chat-too-fast")).toBeNull();

      const failed = screen.getByRole("button", { name: new RegExp(typed) });
      expect(failed.props.accessibilityHint).toBe("Sends it again");
      await act(async () => fireEvent.press(failed));
      await flush();

      expect(postCalls(MESSAGES_PATH)).toHaveLength(2);
      expect(postCalls(MESSAGES_PATH)[1]?.[1]).toEqual({ body: typed });
      expect(await screen.findByTestId(`chat-message-${stored.id}`)).toBeTruthy();
      expect(screen.queryByTestId("chat-pending-status")).toBeNull();
      expect(announcements()).toEqual(["Message not sent", "Message sent"]);
    });

    it("too fast (429): the bubble can be tried again and the composer says why", async () => {
      mockApi.send = () => Promise.reject(new ApiError(429, "rate_limited"));
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend("Are you on your way?");
      await flush();

      expect(screen.getByTestId("chat-pending-status").props.children).toBe(FAILED);
      expect(screen.getByTestId("chat-too-fast").props.children).toBe(TOO_FAST);
      expect(screen.getByText(TOO_FAST)).toBeTruthy();
      expect(announcements()).toEqual([TOO_FAST]);
    });

    it("a bubble on its way shows the clock and no tick", async () => {
      const held = deferred<ChatMessage>();
      mockApi.send = () => held.promise;
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend("Leaving the shop now");

      const pendingBubble = screen.getByTestId(/^chat-pending-/);
      expect(within(pendingBubble).getAllByTestId("chat-receipt-clock", HIDDEN)).toHaveLength(1);
      expect(within(pendingBubble).queryAllByTestId("chat-receipt-tick", HIDDEN)).toHaveLength(0);
      expect(within(pendingBubble).queryByTestId("chat-time")).toBeNull();
      expect(screen.queryByText("Sending…")).toBeNull();

      await act(async () => held.reject(new NetworkError(false)));
      await flush();
    });

    it("server trouble (500): the bubble says not sent, and a tap sends it again", async () => {
      const typed = "Is the part in stock";
      const stored = message(903, { sender: "me", body: typed, created_at: iso(0) });
      let attempts = 0;
      mockApi.send = () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError(500, "internal"))
          : Promise.resolve(stored);
      };
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend(typed);
      await flush();

      expect(screen.getByTestId("chat-pending-status").props.children).toBe(FAILED);
      expect(screen.queryByTestId("chat-too-fast")).toBeNull();
      expect(announcements()).toEqual(["Message not sent"]);

      const failed = screen.getByRole("button", { name: `You, not sent: ${typed}` });
      await act(async () => fireEvent.press(failed));
      await flush();

      expect(postCalls(MESSAGES_PATH)).toHaveLength(2);
      expect(postCalls(MESSAGES_PATH)[1]?.[1]).toEqual({ body: typed });
      expect(await screen.findByTestId(`chat-message-${stored.id}`)).toBeTruthy();
      expect(screen.queryByTestId("chat-pending-status")).toBeNull();
      expect(announcements()).toEqual(["Message not sent", "Message sent"]);
    });

    it("too fast, then a tap that goes through: the notice leaves", async () => {
      const typed = "Can you come earlier";
      const stored = message(904, { sender: "me", body: typed, created_at: iso(0) });
      let attempts = 0;
      mockApi.send = () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError(429, "rate_limited"))
          : Promise.resolve(stored);
      };
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend(typed);
      await flush();
      expect(screen.getByTestId("chat-too-fast")).toBeTruthy();

      await act(async () =>
        fireEvent.press(screen.getByRole("button", { name: `You, not sent: ${typed}` })),
      );
      await flush();

      expect(screen.queryByTestId("chat-too-fast")).toBeNull();
      expect(await screen.findByTestId(`chat-message-${stored.id}`)).toBeTruthy();
      expect(screen.queryByTestId("chat-pending-status")).toBeNull();
      expect(announcements()).toEqual([TOO_FAST, "Message sent"]);
    });

    it("too fast, then offline on the retry: the notice leaves, the retry stays", async () => {
      const typed = "Should I turn off the water";
      let attempts = 0;
      mockApi.send = () => {
        attempts += 1;
        return Promise.reject(
          attempts === 1 ? new ApiError(429, "rate_limited") : new NetworkError(false),
        );
      };
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend(typed);
      await flush();
      expect(screen.getByTestId("chat-too-fast")).toBeTruthy();

      await act(async () =>
        fireEvent.press(screen.getByRole("button", { name: `You, not sent: ${typed}` })),
      );
      await flush();

      expect(postCalls(MESSAGES_PATH)).toHaveLength(2);
      expect(screen.queryByTestId("chat-too-fast")).toBeNull();
      expect(screen.getByTestId("chat-pending-status").props.children).toBe(FAILED);
      expect(screen.getByRole("button", { name: `You, not sent: ${typed}` })).toBeTruthy();
      expect(announcements()).toEqual([TOO_FAST, "Message not sent"]);
    });

    it("a failed bubble stops offering a retry once a later send finds the chat closed", async () => {
      const first = "Do you need the gate code";
      let attempts = 0;
      mockApi.send = () => {
        attempts += 1;
        return Promise.reject(
          attempts === 1 ? new NetworkError(false) : new ApiError(409, "chat_closed"),
        );
      };
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend(first);
      await flush();
      expect(screen.getByRole("button", { name: `You, not sent: ${first}` })).toBeTruthy();

      await typeAndSend("One more question");
      await flush();

      expect(await screen.findByTestId("chat-closed")).toBeTruthy();
      expect(screen.queryByRole("button", { name: `You, not sent: ${first}` })).toBeNull();
      expect(
        screen.getAllByTestId("chat-pending-status").map((status) => status.props.children),
      ).toEqual(["Not sent", "Not sent"]);
      // Pressing where the retry was sends nothing.
      await act(async () => fireEvent.press(screen.getByLabelText(`You, not sent: ${first}`)));
      await flush();
      expect(postCalls(MESSAGES_PATH)).toHaveLength(2);
      expect(announcements()).toEqual(["Message not sent", CLOSED]);
    });

    it("a send answered after sign-out draws and says nothing", async () => {
      const held = deferred<ChatMessage>();
      mockApi.send = () => held.promise;
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend("See you at nine");
      expect(screen.getByTestId(/^chat-pending-/)).toBeTruthy();

      await act(async () => setSession(SIGNED_OUT_SESSION, 2));
      await act(async () => held.reject(new SessionExpiredError("superseded")));
      await flush();

      expect(announcements()).toEqual([]);
      expect(screen.queryByTestId("chat-pending-status", HIDDEN)).toBeNull();
      expect(screen.queryByTestId("chat-too-fast", HIDDEN)).toBeNull();
      expect(screen.getByTestId("chat-screen")).toBeTruthy();
      expect(client.getQueryData(["chat", JOB_ID, 2])).toBeUndefined();
    });

    it("refused (422): the bubble says not sent and a tap does not send it again", async () => {
      mockApi.send = () => Promise.reject(new ApiError(422, "validation_error"));
      await renderChat();
      await screen.findByTestId("chat-input");

      const typed = "This text is refused";
      await typeAndSend(typed);
      await flush();

      const status = screen.getByTestId("chat-pending-status");
      expect(status.props.children).toBe("Not sent");
      expect(screen.queryByRole("button", { name: new RegExp(typed) })).toBeNull();
      await act(async () => fireEvent.press(status));
      await flush();
      expect(postCalls(MESSAGES_PATH)).toHaveLength(1);
      expect(screen.queryByTestId("chat-too-fast")).toBeNull();
      expect(announcements()).toEqual(["Message not sent"]);
    });

    it("closed (409 chat_closed): the composer gives way to the closed note", async () => {
      mockApi.send = () => Promise.reject(new ApiError(409, "chat_closed"));
      await renderChat();
      await screen.findByTestId("chat-input");

      await typeAndSend("One last question");
      await flush();

      const closed = await screen.findByTestId("chat-closed");
      expect(within(closed).getByText("This chat is closed")).toBeTruthy();
      expect(screen.queryByTestId("chat-input")).toBeNull();
      expect(screen.queryByTestId("chat-send")).toBeNull();
      expect(screen.getByTestId("chat-pending-status").props.children).toBe("Not sent");
      expect(announcements()).toEqual([CLOSED]);
    });
  });

  describe("closed from the job view", () => {
    it.each(["confirmed", "paid_out", "refunded", "cancelled"] as const)(
      "the customer's %s job shows the chat closed",
      async (status: JobStatus) => {
        mockApi.customerJob = customerJob({ status });
        mockApi.messages = () => Promise.resolve(page([message(1)]));
        await renderChat();

        expect(await screen.findByTestId("chat-closed")).toBeTruthy();
        expect(screen.getByText("This chat is closed")).toBeTruthy();
        expect(screen.queryByTestId("chat-input")).toBeNull();
        expect(screen.getByTestId("chat-list")).toBeTruthy();
      },
    );

    it("a pro's cancelled job shows the chat closed", async () => {
      setSession(signedIn({ role: "pro" }), 1);
      mockApi.proJob = proJob({ status: "cancelled" });
      mockApi.messages = () => Promise.resolve(page([message(1, { sender: "customer" })]));
      await renderChat(PRO_URL);

      expect(await screen.findByTestId("chat-closed")).toBeTruthy();
      expect(screen.queryByTestId("chat-input")).toBeNull();
    });

    it("a failed bubble stops offering a retry once the job view says the chat closed", async () => {
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      mockApi.send = () => Promise.reject(new NetworkError(false));
      await renderChat();
      await screen.findByTestId("chat-input");
      await waitFor(() => expect(screen.getByTestId("chat-peer-name")).toBeTruthy());

      const typed = "I left the side door open";
      await typeAndSend(typed);
      await flush();
      expect(screen.getByRole("button", { name: `You, not sent: ${typed}` })).toBeTruthy();

      mockApi.customerJob = customerJob({ status: "confirmed" });
      await act(async () => client.invalidateQueries({ queryKey: ["job", REQUEST_ID, 1] }));
      await flush();

      expect(await screen.findByTestId("chat-closed")).toBeTruthy();
      expect(screen.queryByRole("button", { name: `You, not sent: ${typed}` })).toBeNull();
      expect(screen.getByTestId("chat-pending-status").props.children).toBe("Not sent");
      expect(screen.getByLabelText(`You, not sent: ${typed}`)).toBeTruthy();
    });

    it("a job still in progress keeps the composer", async () => {
      mockApi.customerJob = customerJob({ status: "in_progress" });
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      await renderChat();
      await screen.findByTestId("chat-list");
      await waitFor(() => expect(screen.getByTestId("chat-peer-name")).toBeTruthy());

      expect(screen.getByTestId("chat-input")).toBeTruthy();
      expect(screen.queryByTestId("chat-closed")).toBeNull();
    });
  });

  describe("read marker", () => {
    it("marks the chat read up to the newest message, once, and the job view takes the count", async () => {
      mockApi.customerJob = customerJob({ unread_messages: 2 });
      const newest = message(1);
      mockApi.messages = () => Promise.resolve(page([newest, message(2)], { unread_count: 2 }));
      mockApi.read = () => Promise.resolve({ unread_count: 0 });
      await renderChat();
      await screen.findByTestId("chat-list");
      await waitFor(() => expect(screen.getByTestId("chat-peer-name")).toBeTruthy());

      await waitFor(() => expect(postCalls(READ_PATH)).toHaveLength(1));
      await flush();
      const [, body, options] = postCalls(READ_PATH)[0] ?? [];
      expect(body).toEqual({ up_to: newest.id });
      expect(options).toEqual(
        expect.objectContaining({ generation: 1, params: { job_id: JOB_ID } }),
      );
      expect(client.getQueryData<CustomerJob>(["job", REQUEST_ID, 1])?.unread_messages).toBe(0);
      expect(postCalls(READ_PATH)).toHaveLength(1);
    });

    it("a pro's mark updates the job screen's answer and the job's row in Your jobs", async () => {
      setSession(signedIn({ role: "pro" }), 1);
      mockApi.proJob = proJob({ unread_messages: 2 });
      client.setQueryData(["pro-jobs", "active", 1], [proJob({ unread_messages: 2 })]);
      const newest = message(1, { sender: "customer" });
      mockApi.messages = () =>
        Promise.resolve(page([newest, message(2, { sender: "customer" })], { unread_count: 2 }));
      mockApi.read = () => Promise.resolve({ unread_count: 0 });
      await renderChat(PRO_URL);
      await screen.findByTestId("chat-list");
      await waitFor(() =>
        expect(screen.getByTestId("chat-peer-name").props.children).toBe("Jamie"),
      );

      await waitFor(() => expect(postCalls(READ_PATH)).toHaveLength(1));
      await flush();

      expect(postCalls(READ_PATH)[0]?.[1]).toEqual({ up_to: newest.id });
      expect(client.getQueryData<ProJob>(["pro-jobs", "job", JOB_ID, 1])?.unread_messages).toBe(0);
      expect(
        client.getQueryData<ProJob[]>(["pro-jobs", "active", 1])?.map((job) => job.unread_messages),
      ).toEqual([0]);
    });

    it("does not mark a chat with nothing unread", async () => {
      mockApi.messages = () => Promise.resolve(page([message(1)], { unread_count: 0 }));
      await renderChat();
      await screen.findByTestId("chat-list");
      await flush();

      expect(postCalls(READ_PATH)).toHaveLength(0);
    });
  });

  describe("not found and errors", () => {
    it("a malformed id is not found, and nothing is asked", async () => {
      await renderChat(`/jobs/not-a-uuid/chat?request=${REQUEST_ID}`);
      await flush();

      expect(screen.getByTestId("chat-not-found")).toBeTruthy();
      expect(screen.getByText("This conversation isn't available")).toBeTruthy();
      expect(getCalls(MESSAGES_PATH)).toHaveLength(0);
      expect(getCalls(CUSTOMER_JOB_PATH)).toHaveLength(0);
      expect(getCalls(PRO_JOB_PATH)).toHaveLength(0);
      expect(screen.queryByTestId("chat-input")).toBeNull();
    });

    it("a pro's malformed id is not found, and nothing is asked", async () => {
      setSession(signedIn({ role: "pro" }), 1);
      await renderChat("/jobs/not-a-uuid/chat");
      await flush();

      expect(screen.getByTestId("chat-not-found")).toBeTruthy();
      expect(getCalls(MESSAGES_PATH)).toHaveLength(0);
      expect(getCalls(PRO_JOB_PATH)).toHaveLength(0);
      expect(getCalls(CUSTOMER_JOB_PATH)).toHaveLength(0);
      expect(screen.queryByTestId("chat-input")).toBeNull();
    });

    it("a malformed request asks for no job, and the header says 'Your pro'", async () => {
      mockApi.messages = () => Promise.resolve(page([message(1)]));
      await renderChat(`/jobs/${JOB_ID}/chat?request=garbage`);
      await screen.findByTestId("chat-list");
      await flush();

      expect(screen.getByTestId("chat-peer-name").props.children).toBe("Your pro");
      expect(getCalls(CUSTOMER_JOB_PATH)).toHaveLength(0);
      expect(getCalls(PRO_JOB_PATH)).toHaveLength(0);
      expect(getCalls(MESSAGES_PATH)).toHaveLength(1);
      expect(screen.getByTestId("chat-input")).toBeTruthy();
    });

    it("a 404 on the messages is not found", async () => {
      mockApi.messages = () => Promise.reject(new ApiError(404, "not_found"));
      await renderChat();

      expect(await screen.findByTestId("chat-not-found")).toBeTruthy();
      expect(screen.queryByTestId("chat-error")).toBeNull();
      expect(screen.queryByTestId("chat-input")).toBeNull();
    });

    it("another error offers a retry that asks again", async () => {
      const first = message(1);
      let asks = 0;
      mockApi.messages = () => {
        asks += 1;
        return asks === 1
          ? Promise.reject(new ApiError(500, "internal"))
          : Promise.resolve(page([first]));
      };
      await renderChat();

      const error = await screen.findByTestId("chat-error");
      expect(within(error).getByText("We couldn't load your messages")).toBeTruthy();
      expect(screen.queryByTestId("chat-not-found")).toBeNull();

      await act(async () => fireEvent.press(screen.getByTestId("chat-error-action")));
      await flush();

      expect(getCalls(MESSAGES_PATH)).toHaveLength(2);
      expect(await screen.findByTestId("chat-list")).toBeTruthy();
      expect(screen.getByText(first.body)).toBeTruthy();
      expect(screen.queryByTestId("chat-error")).toBeNull();
    });
  });

  describe("sign-out", () => {
    it("a late answer after sign-out draws nothing", async () => {
      const held = deferred<ChatPage>();
      mockApi.messages = () => held.promise;
      await renderChat();
      expect(screen.getByTestId("chat-loading")).toBeTruthy();

      await act(async () => setSession(SIGNED_OUT_SESSION, 2));
      const late = message(1, { body: remember("A message for the old session.") });
      await act(async () => held.resolve(page([late], { unread_count: 1 })));
      await flush();

      expect(screen.queryByText(late.body, { includeHiddenElements: true })).toBeNull();
      expect(screen.queryByTestId(`chat-message-${late.id}`)).toBeNull();
      expect(screen.queryByTestId("chat-list")).toBeNull();
      expect(client.getQueryData(["chat", JOB_ID, 2])).toBeUndefined();
      // Nothing is asked or marked for the signed-out session.
      expect(getCalls(MESSAGES_PATH)).toHaveLength(1);
      expect(postCalls(READ_PATH)).toHaveLength(0);
    });
  });
});
