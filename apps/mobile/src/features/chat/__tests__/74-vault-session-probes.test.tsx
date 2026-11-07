import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";

import {
  attachQueryClient,
  login,
  logout,
  restoreSession,
  sessionGeneration,
  sessionStore,
  useSessionGeneration,
} from "../../../api/session";
import {
  authResponse,
  callBody,
  callHeader,
  callPath,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  secureStoreMock,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { chatQueryKey, chatQueryOptions, markRead } from "../api";
import { useSendQueue } from "../useSendQueue";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-router", () => ({ useIsFocused: () => true, useFocusEffect: jest.fn() }));

const A = "9a000000-0000-4000-8000-000000000074";
const B = "9a000000-0000-4000-8000-000000000075";
const MESSAGE = "7c000000-0000-4000-8000-000000000999";
const SECRET = "vault private unsent message at example.invalid";
let client: QueryClient;
let fetchMock: FetchMock;
let logs: jest.SpyInstance[];
const listeners = { onClosed: jest.fn(), onDone: jest.fn() };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  });
const stored = (body: string) => ({
  id: MESSAGE,
  body,
  sender: "me",
  redacted: false,
  warning: null,
  created_at: "2026-11-07T12:00:00Z",
});
const sends = () =>
  fetchMock.mock.calls.filter(
    (call) => call[1]?.method === "POST" && callPath(call).endsWith("/messages"),
  );
async function signIn(n = 1) {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, {
      ...authResponse(n),
      user: { ...user, id: n === 1 ? user.id : B, role: n === 1 ? "customer" : "pro" },
    }),
  );
  await act(async () =>
    login({ email: "fixture@example.invalid", password: "fixture password only" }),
  );
  fetchMock.mockClear();
}
async function renderQueue(job = A) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ jobId }: { jobId: string }) => useSendQueue(jobId, useSessionGeneration(), listeners),
    {
      initialProps: { jobId: job },
      wrapper: Wrapper,
    },
  );
}
beforeEach(async () => {
  fetchMock = installFetchMock();
  resetSecureStore();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  sessionStore.setState({
    status: "signedOut",
    user: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    cleanupPending: false,
    restoreFailure: null,
    onboardingUserId: null,
  });
  listeners.onDone.mockClear();
  listeners.onClosed.mockClear();
  logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(),
  );
  await signIn();
});
afterEach(() => {
  const written = JSON.stringify(logs.flatMap((log) => log.mock.calls));
  expect(written).not.toContain(SECRET);
  expect(JSON.stringify(secureStoreMock.setItemAsync.mock.calls)).not.toContain(SECRET);
  logs.forEach((log) => log.mockRestore());
  client.clear();
});

it("real account replacement drops a failed body and refuses a captured old retry", async () => {
  const queue = await renderQueue();
  fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
  await act(async () => queue.result.current.send(SECRET));
  await flush();
  const [failed] = queue.result.current.pending;
  expect(failed?.state).toBe("failed");
  const retry = queue.result.current.retry;
  await signIn(2);
  expect(queue.result.current.pending).toEqual([]);
  await act(async () => retry(failed!.localId));
  await flush();
  expect(sends()).toHaveLength(0);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});

it("changing jobs in the same session drops the old queue and never retargets its retry", async () => {
  const queue = await renderQueue();
  fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
  await act(async () => queue.result.current.send(SECRET));
  await flush();
  const failed = queue.result.current.pending[0]!;
  const retry = queue.result.current.retry;
  await queue.rerender({ jobId: B });
  expect(queue.result.current.pending).toEqual([]);
  fetchMock.mockClear();
  await act(async () => retry(failed.localId));
  await flush();
  expect(sends()).toHaveLength(0);
  fetchMock.mockResolvedValueOnce(jsonResponse(201, stored("new job message")));
  await act(async () => queue.result.current.send("new job message"));
  await flush();
  expect(sends()).toHaveLength(1);
  expect(callPath(sends()[0]!)).toBe(`/v1/jobs/${B}/messages`);
  expect(callBody(sends()[0]!)).toEqual({ body: "new job message" });
});

it("expired access plus rejected refresh drops the pending text without a send retry", async () => {
  const queue = await renderQueue();
  fetchMock.mockResolvedValueOnce(errorResponse(401, "invalid_token"));
  fetchMock.mockResolvedValueOnce(errorResponse(401, "invalid_token"));
  await act(async () => queue.result.current.send(SECRET));
  await flush();
  expect(sessionStore.getState().status).toBe("signedOut");
  expect(queue.result.current.pending).toEqual([]);
  expect(sends()).toHaveLength(1);
  expect(listeners.onDone).not.toHaveBeenCalled();
});

it("a queued second body is never posted after logout and another login", async () => {
  const queue = await renderQueue();
  const held = deferred<Response>();
  fetchMock.mockImplementation(() => held.promise);
  await act(async () => {
    queue.result.current.send("first message");
    queue.result.current.send(SECRET);
  });
  await flush();
  expect(sends()).toHaveLength(1);
  fetchMock.mockReset().mockResolvedValueOnce(jsonResponse(204));
  await act(async () => logout());
  await signIn(2);
  await act(async () => held.resolve(jsonResponse(201, stored("first message"))));
  await flush();
  expect(sends()).toHaveLength(0);
  expect(queue.result.current.pending).toEqual([]);
  expect(listeners.onDone).not.toHaveBeenCalled();
});

it("a read marker from a departed account sends no HTTP request", async () => {
  const old = sessionGeneration();
  await signIn(2);
  await expect(markRead(client, A, MESSAGE, old)).rejects.toMatchObject({
    name: "SessionExpiredError",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("a late read answer for job A cannot change job B's unread count", async () => {
  const gen = sessionGeneration();
  client.setQueryData(chatQueryKey(B, gen), { messages: [], olderCursor: null, unreadCount: 5 });
  const held = deferred<Response>();
  fetchMock.mockReturnValueOnce(held.promise);
  const read = markRead(client, A, MESSAGE, gen);
  await flush();
  expect(callPath(fetchMock.mock.calls[0]!)).toBe(`/v1/jobs/${A}/messages/read`);
  expect(callHeader(fetchMock.mock.calls[0]!, "Authorization")).toBe("Bearer access-1");
  held.resolve(jsonResponse(200, { unread_count: 0 }));
  await read;
  expect(client.getQueryData(chatQueryKey(B, gen))).toMatchObject({ unreadCount: 5 });
});

it("another account's deep-link 404 cannot reuse the former account's cached chat", async () => {
  const old = sessionGeneration();
  client.setQueryData(chatQueryKey(A, old), {
    messages: [stored(SECRET)],
    olderCursor: null,
    unreadCount: 0,
  });
  await signIn(2);
  fetchMock.mockResolvedValueOnce(errorResponse(404, "not_found"));
  await expect(
    client.fetchQuery(chatQueryOptions(client, A, sessionGeneration())),
  ).rejects.toMatchObject({ status: 404 });
  expect(client.getQueryData(chatQueryKey(A, old))).toBeUndefined();
  expect(client.getQueryData(chatQueryKey(A, sessionGeneration()))).toBeUndefined();
});

it("a fresh screen and cache after session restoration do not restore unsent text", async () => {
  const queue = await renderQueue();
  fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
  await act(async () => queue.result.current.send(SECRET));
  await flush();
  expect(queue.result.current.pending[0]?.body).toBe(SECRET);
  await queue.unmount();
  client.clear();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  attachQueryClient(client);
  sessionStore.setState({
    status: "restoring",
    user: null,
    accessToken: null,
    accessTokenExpiresAt: null,
  });
  fetchMock.mockResolvedValueOnce(jsonResponse(200, authResponse(2)));
  await restoreSession();
  const restored = await renderQueue();
  expect(restored.result.current.pending).toEqual([]);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});
