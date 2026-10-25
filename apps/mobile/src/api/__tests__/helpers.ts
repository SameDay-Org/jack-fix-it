import type { ApiSchema } from "@jack/shared";

/** The API under test, as `jest.mock("../config", () => require("./helpers").configMock)`. */
export const API_ORIGIN = "http://api.test.invalid:8000";
export const configMock = {
  apiConfig: {
    baseUrl: new URL(`${API_ORIGIN}/`),
    timeoutMs: 15_000,
    uploadTimeoutMs: 120_000,
    uploadMinBytesPerSecond: 131_072,
    passwordMinLength: 10,
  },
};

/**
 * Single-slot secure store, installed with
 * `jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock)`.
 * The real store holds exactly one entry (the refresh token), so the slot ignores the key; tests
 * assert the key only through the `setItemAsync` call.
 */
let storedValue: string | null = null;
export const secureStoreMock = {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly",
  getItemAsync: jest.fn(async () => storedValue),
  setItemAsync: jest.fn(async (_key: string, value: string) => {
    storedValue = value;
  }),
  deleteItemAsync: jest.fn(async () => {
    storedValue = null;
  }),
};

export function resetSecureStore(): void {
  storedValue = null;
  secureStoreMock.getItemAsync.mockClear();
  secureStoreMock.setItemAsync.mockClear();
  secureStoreMock.deleteItemAsync.mockClear();
}

/** Puts a refresh token on the device, as a previous session would have. */
export function seedRefreshToken(token: string): void {
  storedValue = token;
}

export const storedRefreshToken = (): string | null => storedValue;

/** A Response stand-in with what the client reads: status, ok, json() and text(). */
export function jsonResponse(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

export const errorResponse = (status: number, code: string): Response =>
  jsonResponse(status, { error: { code, message: code } });

export const user: ApiSchema<"UserOut"> = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "maria@example.com",
  role: "customer",
  locale: "en",
  status: "active",
  phone: null,
  phone_verified: false,
  first_name: null,
  last_name: null,
};

/** The server's answer to register, login and refresh; `n` numbers the token pair. */
export const authResponse = (n: number): ApiSchema<"AuthResponse"> => ({
  user,
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  token_type: "bearer",
  expires_in: 900,
});

type FetchCall = [string, RequestInit | undefined];
export type FetchMock = jest.Mock<Promise<Response>, FetchCall>;

/** Replaces global fetch for the test; route requests in `mockImplementation`. */
export function installFetchMock(): FetchMock {
  const mock = jest.fn<Promise<Response>, FetchCall>();
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

export const callPath = ([url]: FetchCall): string => new URL(url).pathname;
export const callHeader = ([, init]: FetchCall, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name];
export const callBody = ([, init]: FetchCall): unknown => JSON.parse(String(init?.body));
export const callsTo = (fetchMock: FetchMock, path: string): FetchCall[] =>
  fetchMock.mock.calls.filter((call) => callPath(call) === path);

/** A fetch that never answers and rejects like the platform when its signal aborts. */
export const neverAnswers = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
    );
  });

/** A promise the test settles by hand, to order one answer against another. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending microtask and the current macrotask settle. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * Spies on every console method; `assertNoTokenLogged()` fails if any call mentioned a token.
 * Tokens in this suite all contain "access-" or "refresh-".
 */
export function watchConsole(): { assertNoTokenLogged: () => void; restore: () => void } {
  const spies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method).mockImplementation());
  return {
    assertNoTokenLogged: () => {
      const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.filter((line) => /access-|refresh-/.test(line))).toEqual([]);
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
