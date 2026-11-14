import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import { uuid } from "expo";
import type { ReactNode } from "react";

import { logout } from "@/api";

import {
  callBody,
  callHeader,
  callPath,
  errorResponse,
  installFetchMock,
  jsonResponse,
  neverAnswers,
  resetSecureStore,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { attachQueryClient, sessionStore } from "../../../api/session";
import { SIGNED_OUT } from "../../auth/__tests__/helpers";
import { useSendRequest, type CreatedRequest } from "../api";
import { requestDraftStore, resetDraft } from "../requestDraft";
import type { RequestCreate, SendFailure } from "../send";
import { bodyFingerprint, sendKeyFor } from "../sendKey";
import { created, PAINTING } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

const REQUESTS = "/v1/requests";
/** A version 4 UUID, as the API takes it. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

const BODY: RequestCreate = {
  category_id: PAINTING.id,
  description: "Water stain on the ceiling",
  address: { line1: "12 Main St", city: "Newark", state: "NJ", zip_code: "07102" },
  intake_answers: { surface: "ceiling", furnished: false },
  media_keys: ["uploads/1.jpg", "uploads/2.jpg"],
};
const EDITED: RequestCreate = { ...BODY, description: "Water stain on the ceiling, now dripping" };

type Outcome = { sent: CreatedRequest } | { failed: SendFailure } | null;
type Answer = (call: Parameters<FetchMock>) => Promise<Response>;

const ok =
  (status: 200 | 201): Answer =>
  async () =>
    jsonResponse(status, created());
const refused =
  (status: number, code = "internal_error"): Answer =>
  async () =>
    errorResponse(status, code);
const offline: Answer = async () => {
  throw new TypeError("Network request failed");
};
const noAnswer: Answer = ([url, init]) => neverAnswers(url, init);

let fetchMock: FetchMock;
/** How the next `POST /v1/requests` calls are answered, in order. */
let answers: Answer[];
let client: QueryClient;

const posts = () => fetchMock.mock.calls.filter((call) => callPath(call) === REQUESTS);
const keyOf = (index: number) => {
  const call = posts()[index];
  return call ? callHeader(call, "Idempotency-Key") : undefined;
};
const heldKey = () => requestDraftStore.getState().sendKey?.key ?? null;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

async function renderSend() {
  const { result } = await renderHook(() => useSendRequest(), { wrapper });
  return result;
}

type Send = Awaited<ReturnType<typeof renderSend>>;

/** One tap on Send (or Try again): resolves with how that send ended. */
async function send(hook: Send, body: RequestCreate = BODY): Promise<Outcome> {
  let outcome: Outcome = null;
  await act(async () => {
    await hook.current.send(body, {
      onSent: (request) => (outcome = { sent: request }),
      onFailed: (failure) => (outcome = { failed: failure }),
    });
  });
  return outcome;
}

beforeEach(() => {
  answers = [];
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (...call) => {
    const path = callPath(call);
    if (path === REQUESTS) {
      const answer = answers.shift();
      if (!answer) throw new Error("a request the test did not expect");
      return answer(call);
    }
    if (path === "/v1/auth/logout") return jsonResponse(204);
    return errorResponse(404, "not_found");
  });
  resetSecureStore();
  resetDraft();
  // Nothing in the caches expires: a garbage-collection timer would outlive the test.
  client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  });
  attachQueryClient(client);
  sessionStore.setState({
    ...SIGNED_OUT,
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 900_000,
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("the request's Idempotency-Key (#388)", () => {
  it("the first send carries a new UUID, and the key goes once the request exists", async () => {
    answers = [ok(201)];
    const hook = await renderSend();

    expect(heldKey()).toBeNull();
    const outcome = await send(hook);

    expect(outcome).toStrictEqual({ sent: created() });
    expect(posts()).toHaveLength(1);
    expect(keyOf(0)).toMatch(UUID_V4);
    expect(callBody(posts()[0]!)).toStrictEqual(BODY);
    expect(heldKey()).toBeNull();
  });

  it("a retry after a timeout carries the same key, and the replay's 200 ends like a 201", async () => {
    jest.useFakeTimers();
    answers = [noAnswer, ok(200)];
    const hook = await renderSend();
    let outcome: Outcome = null;
    await act(async () => {
      const sending = hook.current.send(BODY, {
        onSent: (request) => (outcome = { sent: request }),
        onFailed: (failure) => (outcome = { failed: failure }),
      });
      await jest.advanceTimersByTimeAsync(15_000);
      await sending;
    });
    expect(outcome).toStrictEqual({ failed: { kind: "retry", reason: "failed" } });
    // No answer: the request may exist, so the draft keeps its key.
    expect(heldKey()).toBe(keyOf(0));
    jest.useRealTimers();

    const onSent = jest.fn();
    await act(() => hook.current.send(BODY, { onSent, onFailed: jest.fn() }));

    expect(posts()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith(created());
    expect(heldKey()).toBeNull();
  });

  it("retries after a network error, a 5xx and quick Try again taps all carry the same key", async () => {
    answers = [offline, refused(503), ok(201)];
    const hook = await renderSend();

    expect(await send(hook)).toStrictEqual({ failed: { kind: "retry", reason: "failed" } });
    expect(await send(hook)).toStrictEqual({ failed: { kind: "retry", reason: "failed" } });
    // Two taps on Try again in one go: one request, with the same key.
    const onSent = jest.fn();
    await act(async () => {
      const callbacks = { onSent, onFailed: jest.fn() };
      await Promise.all([hook.current.send(BODY, callbacks), hook.current.send(BODY, callbacks)]);
    });

    expect(posts()).toHaveLength(3);
    expect(keyOf(0)).toMatch(UUID_V4);
    expect(new Set([keyOf(0), keyOf(1), keyOf(2)]).size).toBe(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("an edited draft never reaches the server with the old key", async () => {
    answers = [refused(503), ok(201)];
    const hook = await renderSend();

    await send(hook);
    await send(hook, EDITED);

    expect(keyOf(1)).toMatch(UUID_V4);
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(callBody(posts()[1]!)).toStrictEqual(EDITED);
  });

  it("a new draft takes a new key, even for the same request", async () => {
    answers = [refused(503), refused(503)];
    const hook = await renderSend();
    await send(hook);
    expect(heldKey()).toBe(keyOf(0));

    // The flow was discarded (its layout forgets the draft) and the customer starts again.
    resetDraft();
    expect(heldKey()).toBeNull();
    await send(hook);

    expect(keyOf(1)).toMatch(UUID_V4);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("a 409 idempotency_key_reused: the calm try-again, nothing sent by itself, then a new key", async () => {
    answers = [refused(409, "idempotency_key_reused"), ok(201)];
    const hook = await renderSend();

    expect(await send(hook)).toStrictEqual({ failed: { kind: "retry", reason: "failed" } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(posts()).toHaveLength(1);
    expect(heldKey()).toBeNull();

    // Try again: a fresh key (this call created nothing; see sendKey.ts).
    expect(await send(hook)).toStrictEqual({ sent: created() });
    expect(keyOf(1)).toMatch(UUID_V4);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("sign-out forgets the key with the draft", async () => {
    answers = [refused(503)];
    const hook = await renderSend();
    await send(hook);
    expect(heldKey()).not.toBeNull();

    await act(() => logout());

    expect(heldKey()).toBeNull();
  });

  it("a key that is not a UUID never goes out: one more is made, then the plain try-again", async () => {
    answers = [ok(201)];
    const v4 = jest.spyOn(uuid, "v4").mockReturnValueOnce("not-a-uuid");
    const hook = await renderSend();

    await send(hook);
    expect(v4).toHaveBeenCalledTimes(2);
    expect(keyOf(0)).toMatch(UUID_V4);

    // Another draft (a request that went through sends nothing more), and no generator at all.
    resetDraft();
    const next = await renderSend();
    v4.mockReset().mockImplementation(() => {
      throw new Error("Native UUID version 4 generator implementation wasn't found");
    });
    expect(await send(next, EDITED)).toStrictEqual({
      failed: { kind: "retry", reason: "failed" },
    });
    expect(v4).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(1);
    expect(heldKey()).toBeNull();
  });

  it("keeps the key out of every log, every query key and the body", async () => {
    const spies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method).mockImplementation());
    answers = [offline, refused(409, "idempotency_key_reused"), ok(201)];
    const hook = await renderSend();

    await send(hook);
    const first = keyOf(0)!;
    await send(hook);
    await send(hook);
    const keys = [first, keyOf(2)!];

    const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
    const queryKeys = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    );
    const bodies = posts().map((call) => JSON.stringify(callBody(call)));
    for (const key of keys) {
      expect(logged.filter((line) => line.includes(key))).toEqual([]);
      expect(queryKeys).not.toContain(key);
      expect(bodies.filter((body) => body.includes(key))).toEqual([]);
    }
  });
});

describe("sendKeyFor", () => {
  it("knows the same request however its keys were put together", () => {
    const reordered: RequestCreate = {
      media_keys: ["uploads/1.jpg", "uploads/2.jpg"],
      intake_answers: { furnished: false, surface: "ceiling" },
      address: { zip_code: "07102", state: "NJ", city: "Newark", line1: "12 Main St" },
      description: "Water stain on the ceiling",
      category_id: PAINTING.id,
    };

    expect(bodyFingerprint(reordered)).toBe(bodyFingerprint(BODY));
    expect(sendKeyFor(reordered)).toBe(sendKeyFor(BODY));
  });

  it("takes a new key for any change: a field, an answer, the address, the files or their order", () => {
    const changes: RequestCreate[] = [
      EDITED,
      { ...BODY, intake_answers: { surface: "walls", furnished: false } },
      { ...BODY, address: { ...BODY.address, line2: "Apt 2" } },
      { ...BODY, media_keys: ["uploads/1.jpg"] },
      { ...BODY, media_keys: ["uploads/2.jpg", "uploads/1.jpg"] },
      { ...BODY, preferred_date: "2026-11-20", preferred_period: "morning" },
    ];
    const first = sendKeyFor(BODY);

    const next = changes.map((body) => sendKeyFor(body));

    expect(new Set([first, ...next]).size).toBe(changes.length + 1);
  });
});
