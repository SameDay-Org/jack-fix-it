import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";

import { ApiError, apiGet, apiPost, isCurrentGeneration, NetworkError } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { fakeClock, NOW, newQueryClient } from "../../quotes/__tests__/helpers";
import {
  chatHref,
  chatQueryKey,
  chatQueryOptions,
  isChatGone,
  markRead,
  sendMessage,
  useChat,
  useOlderMessages,
} from "../api";
import { chatConfig } from "../config";
import type { ChatMessage, ChatPage, Thread } from "../thread";

type MockStatus = "signedIn" | "signedOut";

/** The session the mocked `@/api` hooks read; a test signs out by changing it and notifying. */
const mockSession = {
  status: "signedIn" as MockStatus,
  generation: 1,
  listeners: new Set<() => void>(),
};
/** The screen's focus as `useIsFocused` and `useFocusEffect` read it. */
const mockFocus = { focused: true, listeners: new Set<() => void>() };

jest.mock("@/api", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  const subscribe = (listener: () => void) => {
    mockSession.listeners.add(listener);
    return () => {
      mockSession.listeners.delete(listener);
    };
  };
  return {
    ...jest.requireActual("../../../api/errors"),
    onSignOut: jest.fn(() => () => undefined),
    apiConfig: { timeoutMs: 15_000 },
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    isCurrentGeneration: jest.fn(),
    sessionGeneration: () => mockSession.generation,
    useSessionGeneration: () => useSyncExternalStore(subscribe, () => mockSession.generation),
    useSession: () => ({
      status: useSyncExternalStore(subscribe, () => mockSession.status),
      user: null,
    }),
    setSessionUser: jest.fn(),
    logout: jest.fn(),
  };
});
jest.mock("expo-router", () => {
  const { useEffect, useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  const subscribe = (listener: () => void) => {
    mockFocus.listeners.add(listener);
    return () => {
      mockFocus.listeners.delete(listener);
    };
  };
  const useFocused = () => useSyncExternalStore(subscribe, () => mockFocus.focused);
  return {
    ...jest.requireActual("../../quotes/__tests__/helpers").routerMock,
    useIsFocused: useFocused,
    // Runs the effect on every focus and cleans it up on blur, as React Navigation does.
    useFocusEffect: (effect: () => void | (() => void)) => {
      const focused = useFocused();
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
  };
});

const JOB = "9a000000-0000-4000-8000-000000000074";
const OTHER_JOB = "9a000000-0000-4000-8000-000000000075";
const MESSAGES_PATH = "/v1/jobs/{job_id}/messages";
const READ_PATH = "/v1/jobs/{job_id}/messages/read";
const MINUTE_MS = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE_MS).toISOString();

/** Every body a fixture carries: none of them may ever reach a logger. */
const BODIES = [
  "Morning, the gate code is behind the blue planter",
  "Thanks, I will park on the left side of the drive",
  "The faucet still drips after the shutoff turns",
  "Bring the long wrench for the supply line nut",
  "Running about ten minutes behind the estimate",
  "No rush at all, the dog is inside today",
  "Is the old cartridge fine to leave in the bin",
  "Text me at ••• when you are out front",
  "One more photo of the valve before I leave",
] as const;

const message = (
  n: number,
  minutes: number,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: `c0000000-0000-4000-8000-00000000000${n}`,
  sender: n % 2 === 0 ? "me" : "pro",
  body: BODIES[n - 1] ?? "",
  redacted: false,
  created_at: at(minutes),
  receipt: null,
  ...overrides,
});

// Newest last in number: m9 is the newest message of the chat.
const M = Array.from({ length: 9 }, (_, index) => message(index + 1, -90 + index * 10));
const m = (n: number): ChatMessage => M[n - 1] as ChatMessage;

const page = (items: ChatMessage[], nextCursor: string | null, unread = 0): ChatPage => ({
  items,
  next_cursor: nextCursor,
  unread_count: unread,
});

const ids = (thread: Thread | undefined) => thread?.messages.map((item) => item.id);

type Get = (path: string, options?: unknown) => Promise<unknown>;
type Post = (path: string, body: unknown, options?: unknown) => Promise<unknown>;
const get = apiGet as unknown as jest.MockedFunction<Get>;
const post = apiPost as unknown as jest.MockedFunction<Post>;
type SentOptions = { generation?: number };
const generationsUsed = () =>
  [
    ...get.mock.calls.map(([, options]) => options as SentOptions | undefined),
    ...post.mock.calls.map(([, , options]) => options as SentOptions | undefined),
  ].map((options) => options?.generation);

const messageGets = () => get.mock.calls.filter(([path]) => path === MESSAGES_PATH).length;

/** AppState listeners currently subscribed: a removed one is never called again. */
const appStateListeners = new Set<(state: AppStateStatus) => void>();
const ORIGINAL_STATE = Object.getOwnPropertyDescriptor(AppState, "currentState");
const setCurrentState = (state: AppStateStatus) =>
  Object.defineProperty(AppState, "currentState", {
    value: state,
    configurable: true,
    writable: true,
  });

async function moveApp(state: AppStateStatus): Promise<void> {
  await act(async () => {
    setCurrentState(state);
    appStateListeners.forEach((listener) => listener(state));
  });
}

async function setFocused(focused: boolean): Promise<void> {
  await act(async () => {
    mockFocus.focused = focused;
    mockFocus.listeners.forEach((listener) => listener());
  });
}

/** Signs out as the session does: a new generation, the old one no longer current. */
async function signOut(client?: QueryClient): Promise<void> {
  await act(async () => {
    mockSession.status = "signedOut";
    mockSession.generation += 1;
    client?.clear();
    mockSession.listeners.forEach((listener) => listener());
  });
}

const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

function wrapper(client: QueryClient) {
  return function ChatWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

/** Every chat thread the cache holds data for, under any job or generation. */
const chatData = (client: QueryClient) =>
  client
    .getQueriesData<Thread>({ queryKey: ["chat"] })
    .filter(([, data]) => data !== undefined)
    .map(([key]) => key);

const seeded = (thread: Thread, generation = 1): QueryClient => {
  const client = newQueryClient();
  client.setQueryData(chatQueryKey(JOB, generation), thread);
  return client;
};

const LOG_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let consoleSpies: jest.SpyInstance[] = [];

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name} ${value.message} ${value.stack ?? ""}`;
  try {
    return `${JSON.stringify(value)} ${String(value)}`;
  } catch {
    return String(value);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  consoleSpies = LOG_METHODS.map((method) => jest.spyOn(console, method));
  mockFocus.focused = true;
  mockSession.status = "signedIn";
  mockSession.generation = 1;
  jest
    .mocked(isCurrentGeneration)
    .mockReset()
    .mockImplementation((generation: number) => generation === mockSession.generation);
  get.mockReset().mockResolvedValue(page([m(9), m(8)], "cursor-8", 1));
  post.mockReset();
  appStateListeners.clear();
  setCurrentState("active");
  jest
    .mocked(AppState.addEventListener)
    .mockReset()
    .mockImplementation((_type, listener): NativeEventSubscription => {
      appStateListeners.add(listener);
      return {
        remove: () => {
          appStateListeners.delete(listener);
        },
      };
    });
});

afterEach(() => {
  const printed = consoleSpies.flatMap((spy) => spy.mock.calls.flat()).map(stringify);
  consoleSpies.forEach((spy) => spy.mockRestore());
  jest.useRealTimers();
  if (ORIGINAL_STATE) Object.defineProperty(AppState, "currentState", ORIGINAL_STATE);
  // No message body ever reaches a logger, whatever the test went through.
  expect(printed.filter((text) => BODIES.some((body) => text.includes(body)))).toEqual([]);
});

describe("chatHref and chatQueryKey", () => {
  it("opens the job's chat, with the request only when one is given", () => {
    expect(chatHref(JOB)).toEqual({ pathname: "/jobs/[id]/chat", params: { id: JOB } });
    expect(chatHref(JOB, "req-1")).toEqual({
      pathname: "/jobs/[id]/chat",
      params: { id: JOB, request: "req-1" },
    });
  });

  it("keys a thread by job and session generation", () => {
    expect(chatQueryKey(JOB, 3)).toEqual(["chat", JOB, 3]);
    expect(chatQueryKey(JOB, 3)).not.toEqual(chatQueryKey(JOB, 4));
    expect(chatQueryKey(JOB, 3)).not.toEqual(chatQueryKey(OTHER_JOB, 3));
  });
});

describe("chatQueryOptions", () => {
  it("asks the newest page, pinned to the generation, with the API's own page size", async () => {
    const client = newQueryClient();
    const thread = await client.fetchQuery(chatQueryOptions(client, JOB, 4));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(MESSAGES_PATH, {
      auth: true,
      generation: 4,
      params: { job_id: JOB },
      signal: expect.any(AbortSignal),
    });
    expect(thread).toEqual({ messages: [m(9), m(8)], olderCursor: "cursor-8", unreadCount: 1 });
  });

  it("folds the next answer into the thread it holds", async () => {
    const client = newQueryClient();
    get.mockResolvedValueOnce(page([m(7), m(6)], "cursor-6", 2));
    await client.fetchQuery(chatQueryOptions(client, JOB, 1));

    get.mockResolvedValueOnce(page([m(9), m(8), m(7)], "cursor-7", 1));
    const thread = await client.fetchQuery({ ...chatQueryOptions(client, JOB, 1), staleTime: 0 });

    expect(ids(thread)).toEqual([m(9), m(8), m(7), m(6)].map((item) => item.id));
    // The held thread's cursor still points behind its oldest message.
    expect(thread.olderCursor).toBe("cursor-6");
    expect(thread.unreadCount).toBe(1);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(thread);
  });

  it("starts the thread over when the newest page does not reach what it holds", async () => {
    const client = newQueryClient();
    get.mockResolvedValueOnce(page([m(2), m(1)], "cursor-1", 0));
    await client.fetchQuery(chatQueryOptions(client, JOB, 1));

    get.mockResolvedValueOnce(page([m(9), m(8)], "cursor-8", 2));
    const thread = await client.fetchQuery({ ...chatQueryOptions(client, JOB, 1), staleTime: 0 });

    expect(thread).toEqual({ messages: [m(9), m(8)], olderCursor: "cursor-8", unreadCount: 2 });
  });
});

describe("useChat", () => {
  const renderChat = (client: QueryClient, options?: { enabled?: boolean }) =>
    renderHook(() => useChat(JOB, options), { wrapper: wrapper(client) });

  it("asks once on open and again every poll interval while focused in the foreground", async () => {
    fakeClock();
    const client = newQueryClient();
    const { result } = await renderChat(client);
    await waitFor(() => expect(result.current.data?.messages).toHaveLength(2));
    expect(messageGets()).toBe(1);
    expect(result.current.generation).toBe(1);

    await advance(chatConfig.pollMs / 2);
    expect(messageGets()).toBe(1);
    await advance(chatConfig.pollMs / 2);
    await waitFor(() => expect(messageGets()).toBe(2));
    await advance(chatConfig.pollMs);
    await waitFor(() => expect(messageGets()).toBe(3));
  });

  it("a blur stops the polling; focus again asks at once and polling resumes", async () => {
    fakeClock();
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await setFocused(false);
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    expect(messageGets()).toBe(1);

    await setFocused(true);
    await waitFor(() => expect(messageGets()).toBe(2));
    await advance(chatConfig.pollMs);
    await waitFor(() => expect(messageGets()).toBe(3));
  });

  it("the background stops the polling; the foreground asks at once and polling resumes", async () => {
    fakeClock();
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await moveApp("background");
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    expect(messageGets()).toBe(1);

    await moveApp("active");
    await waitFor(() => expect(messageGets()).toBe(2));
    await advance(chatConfig.pollMs);
    await waitFor(() => expect(messageGets()).toBe(3));
  });

  it("asks nothing at all for a signed-out session", async () => {
    fakeClock();
    mockSession.status = "signedOut";
    const { result } = await renderChat(newQueryClient());
    await flush();
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await moveApp("background");
    await moveApp("active");

    expect(get).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("asks nothing when the caller disables it", async () => {
    fakeClock();
    const { result } = await renderChat(newQueryClient(), { enabled: false });
    await flush();
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await setFocused(false);
    await setFocused(true);
    await moveApp("background");
    await moveApp("active");

    expect(get).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("a sign-out stops the polling", async () => {
    fakeClock();
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await signOut();
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await moveApp("background");
    await moveApp("active");

    expect(messageGets()).toBe(1);
    expect(result.current.data).toBeUndefined();
  });

  it("its refetch asks nothing for a signed-out session", async () => {
    mockSession.status = "signedOut";
    const { result } = await renderChat(newQueryClient());

    await act(async () => {
      await result.current.refetch();
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("its refetch asks the newest page for a signed-in session", async () => {
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.refetch();
    });
    expect(messageGets()).toBe(2);
  });

  it("a late answer after a sign-out lands under no chat key", async () => {
    const held = deferred<ChatPage>();
    get.mockReturnValueOnce(held.promise);
    const client = newQueryClient();
    const { result } = await renderChat(client);
    expect(result.current.data).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);

    await signOut(client);
    await act(async () => held.resolve(page([m(9), m(8)], "cursor-8", 1)));
    await flush();

    expect(chatData(client)).toEqual([]);
    expect(result.current.data).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("a stale answer stays under the old generation's key and never shows", async () => {
    const held = deferred<ChatPage>();
    get.mockReturnValueOnce(held.promise);
    const client = newQueryClient();
    const { result } = await renderChat(client);

    await signOut();
    await act(async () => held.resolve(page([m(9)], null, 0)));
    await flush();

    expect(result.current.generation).toBe(2);
    expect(result.current.data).toBeUndefined();
    expect(client.getQueryData(chatQueryKey(JOB, 2))).toBeUndefined();
  });
});

describe("isChatGone", () => {
  it.each([
    ["a 404", new ApiError(404, "not_found"), true],
    ["a 403", new ApiError(403, "forbidden"), false],
    ["a 500", new ApiError(500, "internal_error"), false],
    ["no network", new NetworkError(false), false],
    ["a timeout", new NetworkError(true), false],
    ["no error", undefined, false],
    ["a plain error", new Error("not_found"), false],
  ])("reads %s as %p", (_name, error, gone) => {
    expect(isChatGone(error)).toBe(gone);
  });
});

describe("useChat after the chat is gone", () => {
  const renderChat = (client: QueryClient) =>
    renderHook(() => useChat(JOB), { wrapper: wrapper(client) });

  it("a 404 stops the polling: nothing more on poll intervals, refocus or the foreground", async () => {
    fakeClock();
    const gone = new ApiError(404, "not_found");
    get.mockReset().mockRejectedValue(gone);
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.error).toBe(gone));
    expect(messageGets()).toBe(1);

    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await flush();
    expect(messageGets()).toBe(1);

    await setFocused(false);
    await setFocused(true);
    await flush();
    await advance(chatConfig.pollMs);
    expect(messageGets()).toBe(1);

    await moveApp("background");
    await moveApp("active");
    await flush();
    await advance(chatConfig.pollMs);
    expect(messageGets()).toBe(1);

    // The screen's own refetch asks nothing either.
    await act(async () => {
      await result.current.refetch();
    });
    expect(messageGets()).toBe(1);
    expect(isChatGone(result.current.error)).toBe(true);
  });

  it("a 404 after a first answer stops the polling too", async () => {
    fakeClock();
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    get.mockRejectedValue(new ApiError(404, "not_found"));
    await advance(chatConfig.pollMs);
    await waitFor(() => expect(isChatGone(result.current.error)).toBe(true));
    expect(messageGets()).toBe(2);

    await advance(chatConfig.pollMs);
    await advance(chatConfig.pollMs);
    await setFocused(false);
    await setFocused(true);
    await moveApp("background");
    await moveApp("active");
    await flush();
    expect(messageGets()).toBe(2);
  });

  it.each([
    ["a 500", new ApiError(500, "internal_error")],
    ["a 403", new ApiError(403, "forbidden")],
    ["no network", new NetworkError(false)],
  ])("%s keeps polling and asks again on return", async (_name, error) => {
    fakeClock();
    get.mockReset().mockRejectedValue(error);
    const { result } = await renderChat(newQueryClient());
    await waitFor(() => expect(result.current.error).toBe(error));
    expect(messageGets()).toBe(1);

    await advance(chatConfig.pollMs);
    await waitFor(() => expect(messageGets()).toBe(2));
    await advance(chatConfig.pollMs);
    await waitFor(() => expect(messageGets()).toBe(3));

    await moveApp("background");
    await moveApp("active");
    await waitFor(() => expect(messageGets()).toBe(4));

    // It answers again: the thread shows and polling goes on.
    get.mockResolvedValue(page([m(9), m(8)], "cursor-8", 1));
    await advance(chatConfig.pollMs);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(ids(result.current.data)).toEqual([m(9).id, m(8).id]);
  });
});

describe("useOlderMessages", () => {
  const HELD: Thread = { messages: [m(9), m(8)], olderCursor: "cursor-8", unreadCount: 2 };
  const renderOlder = (client: QueryClient, generation = 1) =>
    renderHook(() => useOlderMessages(JOB, generation), { wrapper: wrapper(client) });

  it("asks nothing once the first message is loaded (no cursor)", async () => {
    const client = seeded({ ...HELD, olderCursor: null });
    const { result } = await renderOlder(client);

    await act(() => result.current.load());
    expect(get).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it("asks nothing when no thread is held", async () => {
    const { result } = await renderOlder(newQueryClient());

    await act(() => result.current.load());
    expect(get).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it("asks the page behind the cursor and appends it, moving the cursor on", async () => {
    const client = seeded(HELD);
    const held = deferred<ChatPage>();
    get.mockReturnValueOnce(held.promise);
    const { result } = await renderOlder(client);

    await act(async () => {
      void result.current.load();
    });
    expect(result.current.state).toBe("loading");
    expect(get).toHaveBeenCalledWith(MESSAGES_PATH, {
      auth: true,
      generation: 1,
      params: { job_id: JOB },
      query: { cursor: "cursor-8" },
    });

    await act(async () => held.resolve(page([m(7), m(6)], "cursor-6", 9)));
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual({
      messages: [m(9), m(8), m(7), m(6)],
      olderCursor: "cursor-6",
      // An older page leaves the unread count of the newest answer alone.
      unreadCount: 2,
    });
  });

  it("a second load while one is in flight asks nothing more", async () => {
    const client = seeded(HELD);
    const held = deferred<ChatPage>();
    get.mockReturnValueOnce(held.promise);
    const { result } = await renderOlder(client);

    await act(async () => {
      void result.current.load();
      void result.current.load();
    });
    await act(async () => {
      void result.current.load();
    });
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => held.resolve(page([m(7)], null, 0)));
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(client.getQueryData<Thread>(chatQueryKey(JOB, 1))?.olderCursor).toBeNull();
  });

  it("a failure reads as failed, the thread stays, and a later load asks again", async () => {
    const client = seeded(HELD);
    get.mockRejectedValueOnce(new NetworkError(true));
    const { result } = await renderOlder(client);

    await act(() => result.current.load());
    expect(result.current.state).toBe("failed");
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(HELD);

    get.mockResolvedValueOnce(page([m(7)], "cursor-7", 0));
    await act(() => result.current.load());
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("idle");
    expect(ids(client.getQueryData(chatQueryKey(JOB, 1)))).toEqual(
      [m(9), m(8), m(7)].map((item) => item.id),
    );
  });

  it("drops the page when the session it was asked for is gone", async () => {
    const client = seeded(HELD);
    const held = deferred<ChatPage>();
    get.mockReturnValueOnce(held.promise);
    const { result } = await renderOlder(client);

    await act(async () => {
      void result.current.load();
    });
    mockSession.generation = 2;
    await act(async () => held.resolve(page([m(7), m(6)], "cursor-6", 0)));
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(HELD);
  });

  it("drops the page when a poll started the thread over meanwhile", async () => {
    const client = seeded(HELD);
    const held = deferred<ChatPage>();
    get.mockReturnValueOnce(held.promise);
    const { result } = await renderOlder(client);

    await act(async () => {
      void result.current.load();
    });
    const restarted: Thread = { messages: [m(9)], olderCursor: "cursor-9", unreadCount: 0 };
    client.setQueryData(chatQueryKey(JOB, 1), restarted);
    await act(async () => held.resolve(page([m(7), m(6)], "cursor-6", 0)));
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(restarted);
  });
});

describe("sendMessage", () => {
  const SENT = message(2, 1, { id: "c0000000-0000-4000-8000-0000000000aa" });
  const HELD: Thread = { messages: [m(9), m(8)], olderCursor: "cursor-8", unreadCount: 1 };

  it("posts the body pinned to the generation and adds the stored message at once", async () => {
    const client = seeded(HELD);
    post.mockResolvedValueOnce(SENT);

    await expect(sendMessage(client, JOB, SENT.body, 1)).resolves.toEqual(SENT);
    expect(post).toHaveBeenCalledWith(
      MESSAGES_PATH,
      { body: SENT.body },
      { auth: true, generation: 1, params: { job_id: JOB } },
    );
    expect(ids(client.getQueryData(chatQueryKey(JOB, 1)))).toEqual([SENT.id, m(9).id, m(8).id]);
  });

  it("a poll in flight never draws over the sent message", async () => {
    // The chat opened on its two oldest messages; seven more arrived since.
    get.mockResolvedValueOnce(page([m(2), m(1)], "cursor-1", 0));
    const client = newQueryClient();
    const { result } = await renderHook(() => useChat(JOB), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const poll = deferred<ChatPage>();
    get.mockReturnValueOnce(poll.promise);
    await act(async () => {
      void result.current.refetch();
    });
    expect(messageGets()).toBe(2);

    post.mockResolvedValueOnce(SENT);
    await act(async () => {
      await sendMessage(client, JOB, SENT.body, 1);
    });
    // Asked before the message was stored, and too far ahead to join what is held: had it landed,
    // the thread would have started over from it without the sent message.
    await act(async () => poll.resolve(page([m(9), m(8)], "cursor-8", 0)));
    await flush();

    const expected = [SENT.id, m(2).id, m(1).id];
    expect(ids(client.getQueryData(chatQueryKey(JOB, 1)))).toEqual(expected);
    // The hook hears of the cache on Query's next notify tick.
    await waitFor(() => expect(ids(result.current.data)).toEqual(expected));
    expect(result.current.isFetching).toBe(false);
  });

  it("leaves the thread untouched when the session is gone by the answer", async () => {
    const client = seeded(HELD);
    const answer = deferred<ChatMessage>();
    post.mockReturnValueOnce(answer.promise);

    const sent = sendMessage(client, JOB, SENT.body, 1);
    mockSession.generation = 2;
    answer.resolve(SENT);

    await expect(sent).resolves.toEqual(SENT);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(HELD);
    expect(client.getQueryData(chatQueryKey(JOB, 2))).toBeUndefined();
  });

  it("holds no thread after a send when none was held", async () => {
    const client = newQueryClient();
    post.mockResolvedValueOnce(SENT);

    await sendMessage(client, JOB, SENT.body, 1);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toBeUndefined();
  });

  it.each([
    ["a 429", new ApiError(429, "rate_limited")],
    ["a closed chat", new ApiError(409, "chat_closed")],
    ["no network", new NetworkError(false)],
  ])("a refused send (%s) rejects and leaves the thread as it was", async (_name, error) => {
    const client = seeded(HELD);
    post.mockRejectedValueOnce(error);

    await expect(sendMessage(client, JOB, BODIES[7], 1)).rejects.toBe(error);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(HELD);
  });
});

describe("markRead", () => {
  const HELD: Thread = { messages: [m(9), m(8)], olderCursor: "cursor-8", unreadCount: 3 };

  it("moves the read marker, pinned, and the thread takes the new unread count", async () => {
    const client = seeded(HELD);
    post.mockResolvedValueOnce({ unread_count: 0 });

    await expect(markRead(client, JOB, m(9).id, 1)).resolves.toBe(0);
    expect(post).toHaveBeenCalledWith(
      READ_PATH,
      { up_to: m(9).id },
      { auth: true, generation: 1, params: { job_id: JOB } },
    );
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual({ ...HELD, unreadCount: 0 });
  });

  it("leaves the thread untouched when the session is gone by the answer", async () => {
    const client = seeded(HELD);
    const answer = deferred<{ unread_count: number }>();
    post.mockReturnValueOnce(answer.promise);

    const read = markRead(client, JOB, m(9).id, 1);
    mockSession.generation = 2;
    answer.resolve({ unread_count: 0 });

    await expect(read).resolves.toBe(0);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(HELD);
  });

  it("holds no thread after a read when none was held", async () => {
    const client = newQueryClient();
    post.mockResolvedValueOnce({ unread_count: 0 });

    await markRead(client, JOB, m(9).id, 1);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toBeUndefined();
  });

  it("a failed read rejects and leaves the unread count as it was", async () => {
    const client = seeded(HELD);
    const error = new NetworkError(true);
    post.mockRejectedValueOnce(error);

    await expect(markRead(client, JOB, m(9).id, 1)).rejects.toBe(error);
    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(HELD);
  });
});

describe("the session pin", () => {
  it("every call of a chat session carries that session's generation", async () => {
    mockSession.generation = 7;
    const client = newQueryClient();
    const { result } = await renderHook(
      () => {
        const chat = useChat(JOB);
        const older = useOlderMessages(JOB, chat.generation);
        return { chat, older };
      },
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.chat.isSuccess).toBe(true));
    expect(result.current.chat.generation).toBe(7);

    get.mockResolvedValueOnce(page([m(7), m(6)], "cursor-6", 0));
    await act(() => result.current.older.load());
    get.mockRejectedValueOnce(new NetworkError(false));
    await act(() => result.current.older.load());
    expect(result.current.older.state).toBe("failed");

    post.mockResolvedValueOnce(message(2, 1, { id: "c0000000-0000-4000-8000-0000000000bb" }));
    await act(async () => {
      await sendMessage(client, JOB, BODIES[1], result.current.chat.generation);
    });
    post.mockRejectedValueOnce(new ApiError(429, "rate_limited"));
    await act(async () => {
      await expect(
        sendMessage(client, JOB, BODIES[3], result.current.chat.generation),
      ).rejects.toBeInstanceOf(ApiError);
    });
    post.mockResolvedValueOnce({ unread_count: 0 });
    await act(async () => {
      await markRead(client, JOB, m(9).id, result.current.chat.generation);
    });
    post.mockRejectedValueOnce(new NetworkError(true));
    await act(async () => {
      await expect(
        markRead(client, JOB, m(9).id, result.current.chat.generation),
      ).rejects.toBeInstanceOf(NetworkError);
    });
    await act(async () => {
      await result.current.chat.refetch();
    });

    expect(get.mock.calls.length).toBe(4);
    expect(post.mock.calls.length).toBe(4);
    expect(generationsUsed()).toEqual(Array.from({ length: 8 }, () => 7));
  });
});
