import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";

import { apiGet, apiPost, isCurrentGeneration, NetworkError } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { NOW, newQueryClient } from "../../quotes/__tests__/helpers";
import { chatQueryKey } from "../api";
import type { ChatMessage, Thread } from "../thread";
import { useReadMarker } from "../useReadMarker";

/** The session generation the mocked `isCurrentGeneration` compares against. */
const mockSession = { generation: 1 };
/** The screen's focus as `useIsFocused` and `useFocusEffect` read it. */
const mockFocus = { focused: true, listeners: new Set<() => void>() };

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(() => () => undefined),
  apiConfig: { timeoutMs: 15_000 },
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn(),
  sessionGeneration: () => mockSession.generation,
  useSessionGeneration: () => mockSession.generation,
  useSession: () => ({ status: "signedIn", user: null }),
  setSessionUser: jest.fn(),
  logout: jest.fn(),
}));
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
const READ_PATH = "/v1/jobs/{job_id}/messages/read";
const MINUTE_MS = 60_000;

/** Every body a fixture carries: none of them may ever reach a logger. */
const BODIES = [
  "The shutoff under the sink turns hard to the right",
  "I can be there before noon if the gate is open",
  "Please bring the spare cartridge for the faucet",
  "Parking is on the street, the driveway is wet",
] as const;

const message = (n: number): ChatMessage => ({
  id: `c0000000-0000-4000-8000-00000000000${n}`,
  sender: n % 2 === 0 ? "me" : "pro",
  body: BODIES[n - 1] ?? "",
  redacted: false,
  created_at: new Date(NOW + n * MINUTE_MS).toISOString(),
});
const m = (n: number): ChatMessage => message(n);

/** A thread whose newest message is m<newest>, the API counting `unread` of them unread. */
const thread = (newest: number, unread: number): Thread => ({
  messages: Array.from({ length: newest }, (_, index) => m(newest - index)),
  olderCursor: null,
  unreadCount: unread,
});

type Post = (path: string, body: unknown, options?: unknown) => Promise<unknown>;
const post = apiPost as unknown as jest.MockedFunction<Post>;
const readPosts = () => post.mock.calls.filter(([path]) => path === READ_PATH);
const markedIds = () => readPosts().map(([, body]) => (body as { up_to: string }).up_to);

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

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

/**
 * `visible`: the newest message the list shows; left out, the newest of the thread (the reader at
 * the bottom of the chat).
 */
type Props = { thread: Thread | undefined; generation: number; visible?: string | null };

/** The hook under a Query cache, re-rendered with a new thread or generation through `rerender`. */
async function renderMarker(
  initial: Props,
  { client = newQueryClient(), onUnread = jest.fn() } = {},
) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = await renderHook(
    ({ thread: held, generation, visible }: Props) =>
      useReadMarker(
        JOB,
        generation,
        held,
        visible === undefined ? held?.messages[0]?.id : (visible ?? undefined),
        onUnread,
      ),
    { initialProps: initial, wrapper: Wrapper },
  );
  return { ...rendered, client, onUnread };
}

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
  mockFocus.listeners.clear();
  mockSession.generation = 1;
  jest
    .mocked(isCurrentGeneration)
    .mockReset()
    .mockImplementation((generation: number) => generation === mockSession.generation);
  jest.mocked(apiGet).mockReset();
  post.mockReset().mockResolvedValue({ unread_count: 0 });
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
  if (ORIGINAL_STATE) Object.defineProperty(AppState, "currentState", ORIGINAL_STATE);
  // No message body ever reaches a logger, whatever the test went through.
  expect(printed.filter((text) => BODIES.some((body) => text.includes(body)))).toEqual([]);
});

describe("useReadMarker", () => {
  it("marks nothing while blurred, then once up to the newest message on focus", async () => {
    mockFocus.focused = false;
    mockSession.generation = 4;
    const { onUnread } = await renderMarker({ thread: thread(3, 2), generation: 4 });
    await flush();
    expect(readPosts()).toHaveLength(0);

    await setFocused(true);
    await flush();

    expect(readPosts()).toHaveLength(1);
    expect(post).toHaveBeenCalledWith(
      READ_PATH,
      { up_to: m(3).id },
      { auth: true, generation: 4, params: { job_id: JOB } },
    );
    expect(apiGet).not.toHaveBeenCalled();
    expect(onUnread).toHaveBeenCalledTimes(1);
    expect(onUnread).toHaveBeenCalledWith(0);
  });

  it("hands onUnread the count the API answers with", async () => {
    post.mockResolvedValueOnce({ unread_count: 2 });
    const { onUnread } = await renderMarker({ thread: thread(3, 5), generation: 1 });

    await waitFor(() => expect(onUnread).toHaveBeenCalledWith(2));
    expect(onUnread).toHaveBeenCalledTimes(1);
  });

  it("marks nothing while the API counts nothing unread", async () => {
    const { rerender } = await renderMarker({ thread: thread(3, 0), generation: 1 });
    await flush();
    await rerender({ thread: thread(4, 0), generation: 1 });
    await flush();
    await setFocused(false);
    await setFocused(true);
    await flush();

    expect(readPosts()).toHaveLength(0);
  });

  it("marks nothing before a thread is held", async () => {
    await renderMarker({ thread: undefined, generation: 1 });
    await flush();

    expect(readPosts()).toHaveLength(0);
  });

  it("marks a newer newest message again while focused, but never repeats the same one", async () => {
    const { rerender, onUnread } = await renderMarker({ thread: thread(2, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    // A poll's answer: the same newest message, the API still counting it unread.
    await rerender({ thread: thread(2, 3), generation: 1 });
    await flush();
    await rerender({ thread: thread(2, 3), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    await rerender({ thread: thread(3, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id, m(3).id]);
    expect(onUnread).toHaveBeenCalledTimes(2);
  });

  it("marks nothing in the background and the newer message on the foreground", async () => {
    const { rerender } = await renderMarker({ thread: thread(2, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    await moveApp("background");
    await rerender({ thread: thread(3, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    await moveApp("active");
    await flush();
    expect(markedIds()).toEqual([m(2).id, m(3).id]);
  });

  it("marks the same newest message again after a refocus while it still counts unread", async () => {
    const { rerender } = await renderMarker({ thread: thread(2, 1), generation: 1 });
    await flush();

    await setFocused(false);
    await rerender({ thread: thread(2, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    await setFocused(true);
    await flush();
    expect(markedIds()).toEqual([m(2).id, m(2).id]);
  });

  it("a failed mark waits: not on the next render, but after a refocus", async () => {
    post.mockRejectedValueOnce(new NetworkError(true));
    const { rerender, onUnread } = await renderMarker({ thread: thread(2, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    await rerender({ thread: thread(2, 1), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);
    expect(onUnread).not.toHaveBeenCalled();

    await setFocused(false);
    await setFocused(true);
    await flush();
    expect(markedIds()).toEqual([m(2).id, m(2).id]);
    expect(onUnread).toHaveBeenCalledWith(0);
  });

  it("a failed mark waits: not on the next render, but for a newer message", async () => {
    post.mockRejectedValueOnce(new NetworkError(false));
    const { rerender } = await renderMarker({ thread: thread(2, 1), generation: 1 });
    await flush();

    await rerender({ thread: thread(2, 2), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id]);

    await rerender({ thread: thread(3, 2), generation: 1 });
    await flush();
    expect(markedIds()).toEqual([m(2).id, m(3).id]);
  });

  it("the answer moves the held thread's unread count for the session that asked", async () => {
    const held = thread(2, 2);
    const client: QueryClient = newQueryClient();
    client.setQueryData(chatQueryKey(JOB, 1), held);
    post.mockResolvedValueOnce({ unread_count: 0 });
    await renderMarker({ thread: held, generation: 1 }, { client });

    await waitFor(() =>
      expect(client.getQueryData<Thread>(chatQueryKey(JOB, 1))?.unreadCount).toBe(0),
    );
  });

  it("an answer for a superseded session never writes the thread it was asked for", async () => {
    const held = thread(2, 2);
    const client: QueryClient = newQueryClient();
    client.setQueryData(chatQueryKey(JOB, 1), held);
    const answer = deferred<{ unread_count: number }>();
    post.mockReturnValueOnce(answer.promise);
    const { onUnread } = await renderMarker({ thread: held, generation: 1 }, { client });
    await flush();
    expect(readPosts()).toHaveLength(1);

    mockSession.generation = 2;
    await act(async () => answer.resolve({ unread_count: 0 }));
    await flush();

    expect(client.getQueryData(chatQueryKey(JOB, 1))).toEqual(held);
    expect(client.getQueryData(chatQueryKey(JOB, 2))).toBeUndefined();
    // The count still reaches onUnread; the chat peer's own generation guard drops it there.
    expect(onUnread).toHaveBeenCalledWith(0);
  });

  describe("up to the newest message on screen (#74 round 1)", () => {
    // thread(3, 1): m3 (theirs, unread), m2 (mine), m1 (theirs, read).

    it("marks nothing while the list shows nothing yet", async () => {
      await renderMarker({ thread: thread(3, 1), generation: 1, visible: null });
      await flush();

      expect(readPosts()).toHaveLength(0);
    });

    it("up in the history, a newer unread message below is not marked", async () => {
      await renderMarker({ thread: thread(3, 1), generation: 1, visible: m(1).id });
      await flush();

      expect(readPosts()).toHaveLength(0);
    });

    it("scrolled down to it, the newer message is marked, once", async () => {
      const { rerender } = await renderMarker({
        thread: thread(3, 1),
        generation: 1,
        visible: m(1).id,
      });
      await flush();

      await rerender({ thread: thread(3, 1), generation: 1, visible: m(3).id });
      await flush();
      await rerender({ thread: thread(3, 1), generation: 1, visible: m(3).id });
      await flush();

      expect(markedIds()).toEqual([m(3).id]);
    });

    it("marks up to an unread message on screen even when a newer one is still below", async () => {
      // thread(4, 2): m4 (mine), m3 (theirs), m2 (mine), m1 (theirs): both of theirs unread.
      await renderMarker({ thread: thread(4, 2), generation: 1, visible: m(2).id });
      await flush();

      expect(markedIds()).toEqual([m(2).id]);
    });

    it("never moves back: scrolling up after a mark asks nothing", async () => {
      const { rerender } = await renderMarker({
        thread: thread(3, 1),
        generation: 1,
        visible: m(3).id,
      });
      await flush();
      expect(markedIds()).toEqual([m(3).id]);

      // A poll still counts one unread (the answer has not landed in the thread yet).
      await rerender({ thread: thread(3, 1), generation: 1, visible: m(1).id });
      await flush();

      expect(markedIds()).toEqual([m(3).id]);
    });

    it("another session's mark never holds back this one's", async () => {
      // The customer marked m3; the pro takes the session over on the same job, with m3 unread
      // for them and on their screen.
      const { rerender } = await renderMarker({ thread: thread(3, 1), generation: 1 });
      await flush();
      expect(markedIds()).toEqual([m(3).id]);

      mockSession.generation = 2;
      await rerender({ thread: thread(3, 1), generation: 2 });
      await flush();

      expect(markedIds()).toEqual([m(3).id, m(3).id]);
      expect(readPosts()[1]?.[2]).toEqual(expect.objectContaining({ generation: 2 }));
    });

    it("a message on screen that is not in this session's thread is never marked", async () => {
      await renderMarker({
        thread: thread(3, 1),
        generation: 1,
        visible: "c0000000-0000-4000-8000-000000000009",
      });
      await flush();

      expect(readPosts()).toHaveLength(0);
    });
  });
});
