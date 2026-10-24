import type { ApiSchema } from "@jack/shared";
import { File } from "expo-file-system";

import { UploadFailedError, UploadRejectedError } from "../errors";
import { sessionStore } from "../session";
import { localFileSize, uploadMedia, type UploadMediaOptions } from "../upload";
import {
  callBody,
  callHeader,
  callsTo,
  configMock,
  errorResponse,
  installFetchMock,
  jsonResponse,
  neverAnswers,
  user,
  type FetchMock,
} from "./helpers";

jest.mock("../config", () => jest.requireActual("./helpers").configMock);
jest.mock("expo-secure-store", () => jest.requireActual("./helpers").secureStoreMock);
// The upload drives expo-file-system's native handle (its mock class, patched below).
jest.mock("../nativeUploadTask", () => {
  const { resolve } = require as unknown as { resolve: (id: string) => string };
  const native = jest.requireActual<{ FileSystemUploadTask: new () => unknown }>(
    resolve("expo-file-system/package.json").replace(/package\.json$/, "mocks/FileSystem"),
  );
  return { createNativeUploadTask: () => new native.FileSystemUploadTask() };
});

const FILE_URI = "file:///data/cache/ImageManipulator/compressed.jpg";
const FILE_SIZE = 734_211;
const STORAGE = "https://storage.test.invalid/bucket";
const HOUR_MS = 3_600_000;

const ticket = (n: number, expiresInMs = HOUR_MS): ApiSchema<"UploadResponse"> => ({
  key: `u/${user.id}/request_media/${String(n).repeat(32)}.jpg`,
  upload_url: `${STORAGE}/u/${n}.jpg?X-Amz-Signature=sig-${n}`,
  headers: { "Content-Type": "image/jpeg", "Content-Length": String(FILE_SIZE) },
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});

// Node's fs and module resolution, typed here: the app's tsconfig carries no Node types.
const { readFileSync } = jest.requireActual<{
  readFileSync: (path: string, encoding: "utf8") => string;
}>("fs");
const resolveModule = (require as unknown as { resolve: (id: string) => string }).resolve;
const packageDir = (name: string) =>
  resolveModule(`${name}/package.json`).replace(/package\.json$/, "");

/**
 * A stand-in for expo-file-system's native side, under its real JavaScript `File`. It keeps what
 * B1 depends on: async calls wait on one FIFO queue until the test runs it, as on
 * `expo.modules.AsyncFunctionQueue`; `cancel()` acts at once, as on the JavaScript thread; `start`
 * clears the cancelled flag and then creates the request, as both platforms do. The network is
 * its own worker: with `network = "test"` a request sends what the test moves; with
 * `network = "completes"` it sends the whole body and the storage answers 200 as the start runs,
 * before anything else on the queue (the start's acknowledgement included) and whatever
 * JavaScript does. A cancel stops a request still in flight and does nothing to a settled one.
 * `nativeLog` records the native calls in the order they happen.
 */
type NativeRequest = {
  url: string;
  method: string;
  uri: string;
  headers: Record<string, string>;
  sessionType: string | undefined;
  cancelled: boolean;
  settled: boolean;
  /** The storage keeps the object: it answered 2xx after the whole body. */
  stored: boolean;
  bytesOnWire: number;
  /** Moves `bytes` to the storage and reports progress; false once cancelled or settled. */
  transmit: (bytes: number) => boolean;
  respond: (status: number) => void;
  fail: () => void;
  reject: (error: Error) => void;
};
type NativeTask = {
  cancelled: boolean;
  request?: NativeRequest;
  emit: (event: string, payload: unknown) => void;
};
type StartOptions = { httpMethod: string; headers?: Record<string, string>; sessionType?: string };

const nativeMock = jest.requireActual<{
  FileSystemFile: { prototype: object };
  FileSystemUploadTask: { prototype: object };
}>(`${packageDir("expo-file-system")}mocks/FileSystem`);
const nativeQueue: (() => void)[] = [];
const requests: NativeRequest[] = [];
const nativeLog: ("barrier" | "start" | "cancel")[] = [];
let network: "test" | "completes" = "test";
// Sizes the file metadata reports, by URI; a missing URI is a missing file.
const files = new Map<string, number>();

/** Runs the next `count` queued native calls, in order, letting JavaScript react after each. */
async function runNativeCalls(count: number) {
  for (let call = 0; call < count && nativeQueue.length > 0; call += 1) {
    nativeQueue.shift()?.();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  }
}
/** Runs every queued native call, including the ones they lead JavaScript to queue. */
const runNativeQueue = () => runNativeCalls(100);

function installNativeDouble() {
  const fileProto = nativeMock.FileSystemFile.prototype;
  jest.spyOn(fileProto as { exists: boolean }, "exists", "get").mockImplementation(function (this: {
    uri: string;
  }) {
    return files.has(this.uri);
  });
  jest.spyOn(fileProto as { size: number }, "size", "get").mockImplementation(function (this: {
    uri: string;
  }) {
    return files.get(this.uri) ?? 0;
  });
  // An async native call: it waits its turn on the queue, then fails for a missing file.
  Object.defineProperty(fileProto, "bytes", {
    configurable: true,
    value(this: { uri: string }) {
      return new Promise((resolve, reject) => {
        nativeQueue.push(() => {
          if (this.uri.includes("barrier")) nativeLog.push("barrier");
          return files.has(this.uri) ? resolve(new Uint8Array(0)) : reject(new Error("missing"));
        });
      });
    },
  });

  const taskProto = nativeMock.FileSystemUploadTask.prototype;
  Object.defineProperty(taskProto, "start", {
    configurable: true,
    value(this: NativeTask, url: string, file: { uri: string }, options: StartOptions) {
      return new Promise((resolve, reject) => {
        nativeQueue.push(() => {
          nativeLog.push("start");
          this.cancelled = false; // what both platforms' start does first
          const total = files.get(file.uri) ?? 0;
          const settle = () => {
            const first = !request.settled;
            request.settled = true;
            return first;
          };
          const request: NativeRequest = {
            url,
            method: options.httpMethod,
            uri: file.uri,
            headers: { ...options.headers },
            sessionType: options.sessionType,
            cancelled: false,
            settled: false,
            stored: false,
            bytesOnWire: 0,
            transmit: (bytes) => {
              if (request.cancelled || request.settled) return false;
              request.bytesOnWire += bytes;
              this.emit("progress", { bytesSent: request.bytesOnWire, totalBytes: total });
              return true;
            },
            respond: (status) => {
              if (!settle()) return;
              request.stored = status >= 200 && status < 300 && request.bytesOnWire === total;
              resolve({ status, body: "", headers: {} });
            },
            fail: () => {
              if (settle()) reject(new Error("The network connection was lost"));
            },
            reject: (error) => {
              if (settle()) reject(error);
            },
          };
          this.request = request;
          requests.push(request);
          if (network === "completes") {
            request.transmit(total);
            request.respond(200);
          }
        });
      });
    },
  });
  Object.defineProperty(taskProto, "cancel", {
    configurable: true,
    value(this: NativeTask) {
      nativeLog.push("cancel");
      this.cancelled = true;
      const { request } = this;
      if (!request || request.cancelled || request.settled) return;
      request.cancelled = true;
      request.reject(new Error("Upload was cancelled"));
    },
  });
}

// `__DEV__` is a global the bundler defines; the test flips it to check the production rule.
const runtime = globalThis as unknown as { __DEV__: boolean };
let fetchMock: FetchMock;
let tickets: ApiSchema<"UploadResponse">[];
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
  jest.spyOn(console, method),
);

/** Lets the upload reach its next await (the URL request, then the queued native start). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const lastRequest = () => requests[requests.length - 1];
/** Lets the upload reach the native start, then runs the queue: the request now exists. */
async function reachRequest() {
  await flush();
  await runNativeQueue();
  return lastRequest();
}
/** With fake timers: moves the upload on without moving the clock until a native call waits. */
async function untilNativeCall() {
  for (let tick = 0; tick < 50 && nativeQueue.length === 0; tick += 1) {
    await jest.advanceTimersByTimeAsync(0);
  }
}
const start = (options: Partial<UploadMediaOptions> = {}) =>
  uploadMedia({
    purpose: "request_media",
    file: { uri: FILE_URI, contentType: "image/jpeg" },
    ...options,
  });

beforeEach(() => {
  nativeQueue.length = 0;
  requests.length = 0;
  nativeLog.length = 0;
  network = "test";
  files.clear();
  files.set(FILE_URI, FILE_SIZE);
  installNativeDouble();
  tickets = [ticket(1), ticket(2)];
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async () => {
    const next = tickets.shift();
    if (!next) throw new Error("no more tickets");
    return jsonResponse(201, next);
  });
  sessionStore.setState({
    status: "signedIn",
    user,
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + HOUR_MS,
    cleanupPending: false,
  });
  consoleSpies.forEach((spy) => spy.mockImplementation().mockClear());
});

afterEach(() => {
  // Never a key, a storage URL or the file's path in a log line.
  const logged = consoleSpies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
  expect(
    logged.filter((line) => /request_media\/|storage\.test|ImageManipulator/.test(line)),
  ).toEqual([]);
});

describe("localFileSize", () => {
  it("reads the size from the file's metadata", () => {
    expect(localFileSize(FILE_URI)).toBe(FILE_SIZE);
  });

  it.each([
    ["missing", "file:///cache/gone.mp4", undefined],
    ["empty", "file:///cache/empty.mp4", 0],
  ])("is null for a %s file", (_, uri, size) => {
    if (size !== undefined) files.set(uri, size);
    expect(localFileSize(uri)).toBeNull();
  });

  it("is null when the metadata cannot be read", () => {
    jest
      .spyOn(nativeMock.FileSystemFile.prototype as { exists: boolean }, "exists", "get")
      .mockImplementation(() => {
        throw new Error("no access");
      });
    expect(localFileSize(FILE_URI)).toBeNull();
  });
});

describe("uploadMedia", () => {
  it("asks for a URL signed for the file's type and its size from metadata", async () => {
    const upload = start();
    const request = await reachRequest();

    const [call] = callsTo(fetchMock, "/v1/uploads");
    expect(callBody(call)).toEqual({
      purpose: "request_media",
      content_type: "image/jpeg",
      size_bytes: FILE_SIZE,
    });
    expect(callHeader(call, "Authorization")).toBe("Bearer access-1");

    request.respond(200);
    await expect(upload).resolves.toEqual({ key: ticket(1).key });
  });

  it("PUTs the file itself to exactly the returned URL with exactly its headers, never the token", async () => {
    const upload = start();
    const request = await reachRequest();

    expect(request).toMatchObject({
      method: "PUT",
      url: ticket(1).upload_url,
      uri: FILE_URI,
      headers: ticket(1).headers,
      sessionType: "foreground",
    });
    request.respond(200);
    await upload;
    // One API call; the storage only ever sees the PUT above, and nothing read the file into JS.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining("/v1/uploads"),
    ]);
    expect(requests).toHaveLength(1);
  });

  it("reports the share of the bytes really sent, from 0 to 1", async () => {
    const onProgress = jest.fn();
    const upload = start({ onProgress });
    const request = await reachRequest();

    request.transmit(FILE_SIZE / 4);
    request.transmit((FILE_SIZE * 3) / 4);
    request.respond(200);
    await upload;

    const fractions = onProgress.mock.calls.map(([fraction]: [number]) => fraction);
    expect(fractions.slice(0, 3)).toEqual([0, 0.25, 1]);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
  });

  it("a PUT that never settles is cancelled at its deadline and reported as a timeout", async () => {
    jest.useFakeTimers();
    try {
      const upload = start().catch((error: unknown) => error);
      await untilNativeCall();
      await runNativeQueue();
      const request = lastRequest();
      expect(request).toBeDefined();

      // The deadline is the fixed part plus the file's time at the slowest uplink waited for.
      const { uploadTimeoutMs, uploadMinBytesPerSecond } = configMock.apiConfig;
      const deadline = uploadTimeoutMs + Math.ceil((FILE_SIZE / uploadMinBytesPerSecond) * 1000);
      await jest.advanceTimersByTimeAsync(deadline - 1);
      expect(request.cancelled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect(request.cancelled).toBe(true);
      expect(await upload).toMatchObject({ name: "UploadFailedError", reason: "timeout" });
      expect(requests).toHaveLength(1); // a timeout is not retried
    } finally {
      jest.useRealTimers();
    }
  });

  // B1 and B3 with a small body, which the network can send in full before a cancel reaches it.
  describe.each(["abort", "timeout"] as const)("B1/B3: a stop (%s) with a 64 KiB body", (kind) => {
    const SMALL = 65_536;
    const { uploadTimeoutMs, uploadMinBytesPerSecond } = configMock.apiConfig;
    const deadline = uploadTimeoutMs + Math.ceil((SMALL / uploadMinBytesPerSecond) * 1000);
    const stopError =
      kind === "abort" ? { name: "AbortError" } : { name: "UploadFailedError", reason: "timeout" };
    let controller: AbortController;
    let outcome: Promise<unknown>;
    let settled: boolean;

    beforeEach(() => {
      jest.useFakeTimers();
      files.set(FILE_URI, SMALL);
      controller = new AbortController();
    });
    afterEach(() => jest.useRealTimers());

    /** The caller's abort, or the watchdog at the deadline; synchronous, like the real ones. */
    const stopNow = () =>
      kind === "abort" ? controller.abort() : jest.advanceTimersByTime(deadline);

    /** Starts an upload up to the native start: the start and its acknowledgement wait queued. */
    async function untilStartQueued() {
      settled = false;
      outcome = start({ signal: controller.signal })
        .then(
          (value) => ({ resolved: value }),
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });
      await untilNativeCall();
      await runNativeCalls(1); // the barrier that empties the queue
      expect(nativeQueue).toHaveLength(2);
      expect(nativeLog).toEqual(["barrier"]);
    }
    /** Runs the next native call without letting JavaScript react to it. */
    const runNativeCallNow = () => nativeQueue.shift()?.();

    async function expectStopErrorWithoutRetry() {
      await runNativeQueue();
      expect(await outcome).toMatchObject(stopError);
      expect(requests).toHaveLength(1); // no retry
      expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(1);
    }

    it("(a) before the native start runs: cancelled at once and again on the acknowledgement", async () => {
      await untilStartQueued();

      stopNow();
      expect(nativeLog).toEqual(["barrier", "cancel"]); // at stop time, before the start runs

      await runNativeCalls(1); // the start clears its flag: that first cancel is lost
      expect(lastRequest().cancelled).toBe(false);
      expect(settled).toBe(false); // the caller's queue waits while bytes may still go out
      await runNativeCalls(1); // its acknowledgement cancels again
      expect(nativeLog).toEqual(["barrier", "cancel", "start", "barrier", "cancel"]);
      expect(lastRequest()).toMatchObject({ cancelled: true, bytesOnWire: 0, stored: false });
      await expectStopErrorWithoutRetry();
    });

    it("(b) after the native start, before its acknowledgement: cancelled at stop time", async () => {
      await untilStartQueued();
      await runNativeCalls(1); // the start runs; its acknowledgement still waits
      const request = lastRequest();
      expect(request.transmit(SMALL / 4)).toBe(true);

      stopNow();
      expect(nativeLog).toEqual(["barrier", "start", "cancel"]);
      expect(nativeQueue).toHaveLength(1); // the acknowledgement has not arrived
      expect(request).toMatchObject({ cancelled: true, bytesOnWire: SMALL / 4, stored: false });
      expect(request.transmit(SMALL)).toBe(false);
      await expectStopErrorWithoutRetry();
    });

    it("(c) the network completes before the cancel reaches native: still the stop error, no key", async () => {
      network = "completes";
      await untilStartQueued();

      stopNow(); // its cancel is lost when the start clears the flag
      await runNativeCalls(1); // the network sends the whole body and the storage answers 200
      expect(lastRequest()).toMatchObject({ stored: true, bytesOnWire: SMALL });

      // The residual: the storage keeps that object, but the upload reports the stop, not a key.
      await expectStopErrorWithoutRetry();
      expect(await outcome).not.toHaveProperty("resolved");
      expect(nativeLog).toEqual(["barrier", "cancel", "start", "barrier", "cancel"]);
    });

    it("(d) a delayed acknowledgement: the cancel is repeated the moment it arrives", async () => {
      await untilStartQueued();
      stopNow();
      await runNativeCalls(1); // the start runs and clears the cancelled flag
      const request = lastRequest();

      // The network sends on its own while the acknowledgement is still on its way.
      expect(request.transmit(SMALL / 2)).toBe(true);
      expect(request.cancelled).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(nativeLog).toEqual(["barrier", "cancel", "start"]);
      expect(settled).toBe(false);

      await runNativeCalls(1);
      expect(nativeLog).toEqual(["barrier", "cancel", "start", "barrier", "cancel"]);
      expect(request).toMatchObject({ cancelled: true, bytesOnWire: SMALL / 2, stored: false });
      await expectStopErrorWithoutRetry();
    });

    it("B3: a stop recorded before a 200 reaches JavaScript wins over the 200", async () => {
      network = "completes";
      await untilStartQueued();

      runNativeCallNow(); // the start runs and the storage answers 200 at once...
      expect(lastRequest()).toMatchObject({ stored: true, settled: true });
      stopNow(); // ...but the stop lands before JavaScript sees that answer
      expect(nativeLog).toEqual(["barrier", "start", "cancel"]);

      await expectStopErrorWithoutRetry();
      expect(await outcome).not.toHaveProperty("resolved");
    });
  });

  describe("B1: a cancelled or timed-out upload never starts a PUT", () => {
    it("a cancel before the start creates no request at all", async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(async () => {
        const next = tickets.shift();
        controller.abort(); // lands while the URL is on its way back
        return jsonResponse(201, next);
      });

      const failure = start({ signal: controller.signal }).catch((error: unknown) => error);
      await flush();
      await runNativeQueue();

      expect(await failure).toMatchObject({ name: "AbortError" });
      expect(requests).toHaveLength(0);
    });

    it("a cancel while the queue is being emptied creates no request at all", async () => {
      const controller = new AbortController();
      const failure = start({ signal: controller.signal }).catch((error: unknown) => error);
      await flush();
      expect(nativeQueue).toHaveLength(1); // the first barrier, still waiting

      controller.abort();
      await runNativeQueue();

      expect(await failure).toMatchObject({ name: "AbortError" });
      expect(requests).toHaveLength(0);
      expect(nativeQueue).toHaveLength(0);
    });

    it("the deadline while the queue is being emptied creates no request at all", async () => {
      jest.useFakeTimers();
      try {
        const failure = start().catch((error: unknown) => error);
        await untilNativeCall();
        await jest.advanceTimersByTimeAsync(configMock.apiConfig.uploadTimeoutMs * 10);
        await runNativeQueue();

        expect(await failure).toMatchObject({ name: "UploadFailedError", reason: "timeout" });
        expect(requests).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("a cancel after transmission started stops it, without a retry", async () => {
      const controller = new AbortController();
      const upload = start({ signal: controller.signal }).catch((error: unknown) => error);
      const request = await reachRequest();
      expect(request.transmit(FILE_SIZE / 2)).toBe(true);

      controller.abort();

      expect(request.cancelled).toBe(true);
      expect(request.transmit(FILE_SIZE / 2)).toBe(false);
      expect(request.bytesOnWire).toBe(FILE_SIZE / 2); // the storage never got the whole body
      expect(await upload).toMatchObject({ name: "AbortError" });
      expect(requests).toHaveLength(1);
    });
  });

  it.each([
    [403, "upload_forbidden"],
    [403, "forbidden"],
    [422, "upload_invalid"],
  ])("%i %s is an UploadRejectedError, with no PUT and no retry", async (status, code) => {
    fetchMock.mockImplementation(async () => errorResponse(status, code));

    const failure = await start().catch((error: unknown) => error);
    await runNativeQueue();

    expect(failure).toBeInstanceOf(UploadRejectedError);
    expect(failure).toMatchObject({ status, code });
    expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  it("a storage refusal is final: UploadFailedError with its status, no retry", async () => {
    const upload = start().catch((error: unknown) => error);
    (await reachRequest()).respond(403);

    expect(await upload).toMatchObject({
      name: "UploadFailedError",
      reason: "status",
      status: 403,
    });
    expect(requests).toHaveLength(1);
  });

  it("a network failure retries once on the same URL while it is valid, then gives up", async () => {
    const upload = start().catch((error: unknown) => error);
    (await reachRequest()).fail();
    await reachRequest();

    expect(requests).toHaveLength(2);
    expect(lastRequest().url).toBe(ticket(1).upload_url);
    expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(1);

    lastRequest().fail();
    const failure = await upload;
    expect(failure).toBeInstanceOf(UploadFailedError);
    expect(failure).toMatchObject({ reason: "network" });
    expect(requests).toHaveLength(2);
  });

  it("a network failure after the URL expired asks for a fresh URL and uploads there", async () => {
    tickets = [ticket(1, -1), ticket(2)];
    const upload = start();
    (await reachRequest()).fail();
    const retried = await reachRequest();

    expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(2);
    expect(retried.url).toBe(ticket(2).upload_url);
    expect(retried.headers).toEqual(ticket(2).headers);

    retried.respond(200);
    await expect(upload).resolves.toEqual({ key: ticket(2).key });
  });

  it("aborting while the URL is requested sends no PUT", async () => {
    fetchMock.mockImplementation(neverAnswers);
    const controller = new AbortController();
    const upload = start({ signal: controller.signal }).catch((error: unknown) => error);
    await flush();

    controller.abort();
    await runNativeQueue();

    expect(await upload).toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);
  });

  it("reads only files on this device", async () => {
    await expect(
      start({ file: { uri: "https://elsewhere.invalid/photo.jpg", contentType: "image/jpeg" } }),
    ).rejects.toThrow(/files on this device/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nativeQueue).toHaveLength(0);
  });

  it("a file whose size cannot be found asks for no URL", async () => {
    files.clear();

    await expect(start()).rejects.toThrow(/could not be read/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nativeQueue).toHaveLength(0);
  });

  it("outside development, refuses to send the file to a plain http URL", async () => {
    const dev = runtime.__DEV__;
    runtime.__DEV__ = false;
    tickets = [{ ...ticket(1), upload_url: "http://storage.test.invalid/bucket/u/1.jpg" }];
    try {
      await expect(start()).rejects.toThrow(/https/);
      await runNativeQueue();
      expect(requests).toHaveLength(0);
    } finally {
      runtime.__DEV__ = dev;
    }
  });

  it("the double backs the File class the upload uses", () => {
    expect(Object.getPrototypeOf(File.prototype)).toBe(nativeMock.FileSystemFile.prototype);
  });

  // The barrier in upload.ts rests on these native facts; if one changes, revisit the barrier.
  it("tripwire: the upload start and the barrier share Expo's one ordered native queue", () => {
    const core = packageDir("expo-modules-core");
    const fs = packageDir("expo-file-system");
    const read = (path: string) => readFileSync(path, "utf8");

    // iOS: one serial default queue (no `.concurrent`) for every AsyncFunction without its own.
    const asyncFunction = read(`${core}ios/Core/Functions/AsyncFunctionDefinition.swift`);
    expect(asyncFunction).toMatch(
      /private let defaultQueue = DispatchQueue\(label: "expo\.modules\.AsyncFunctionQueue", qos: \.userInitiated\)\r?\n/,
    );
    expect(asyncFunction).toMatch(/let queue = queue \?\? defaultQueue/);
    // Android: the default scope runs on one HandlerThread, so launches run in order.
    expect(read(`${core}android/src/main/java/expo/modules/kotlin/AppContext.kt`)).toMatch(
      /modulesQueueDispatcher = HandlerThread\("expo\.modules\.AsyncFunctionQueue"\)[\s\S]*?val modulesQueue = CoroutineScope\(\s*modulesQueueDispatcher \+/,
    );
    expect(
      read(
        `${core}android/src/main/java/expo/modules/kotlin/functions/SuspendFunctionComponent.kt`,
      ),
    ).toMatch(/Queues\.DEFAULT -> appContext\.modulesQueue/);

    // expo-file-system: `start` and `bytes` are default-queue AsyncFunctions on both platforms,
    // and `cancel` is synchronous.
    const ios = read(`${fs}ios/FileSystemModule.swift`);
    expect(ios).toMatch(
      /AsyncFunction\("start"\) \{ \(task: FileSystemUploadTask, [^)]*\) in\s*task\.start\([^)]*\)\s*\}\s*Function\("cancel"\)/,
    );
    expect(ios).toMatch(
      /AsyncFunction\("bytes"\) \{ file in\s*return try file\.bytes\(\)\s*\}\s*Function\("bytesSync"\)/,
    );
    const android = read(`${fs}android/src/main/java/expo/modules/filesystem/FileSystemModule.kt`);
    expect(android).toMatch(
      /AsyncFunction\("start"\) Coroutine \{ task: FileSystemUploadTask,[^}]*\}\s*Function\("cancel"\)/,
    );
    expect(android).toMatch(/AsyncFunction\("bytes"\) Coroutine \{ file: FileSystemFile ->/);
    // Android: start clears the flag and creates the call before its first suspension, so the
    // call exists once start has had its turn. Nothing before `newCall` may suspend.
    const androidTask = read(
      `${fs}android/src/main/java/expo/modules/filesystem/FileSystemUploadTask.kt`,
    );
    expect(androidTask).toMatch(
      /suspend fun start\([^)]*\): UploadTaskResult \{\s*file\.validatePermission\([^)]*\)\s*cancelled = false\s*val request = buildUploadRequest\(url, file, options\)\s*return executeUploadRequest\(request\)\s*\}/,
    );
    expect(androidTask).toMatch(/\n {2}private fun buildUploadRequest\(/);
    expect(androidTask).not.toMatch(/suspend fun buildUploadRequest/);
    expect(androidTask).toMatch(
      /private suspend fun executeUploadRequest\(request: Request\): UploadTaskResult \{\s*return suspendCancellableCoroutine \{ continuation ->[\s\S]*?call = client\.newCall\(request\)\s*call\?\.enqueue/,
    );
    expect(androidTask).toMatch(/fun cancel\(\) \{\s*cancelled = true\s*call\?\.cancel\(\)\s*\}/);

    // iOS: start clears the flag, creates the task, checks the flag and resumes, all in the queued
    // block with no hop to another queue; cancel cancels the task once it exists.
    const iosTask = read(`${fs}ios/FileSystemUploadTask.swift`);
    const iosStart =
      /func start\(url: URL, file: FileSystemFile, options: UploadTaskOptions, promise: Promise\) \{[\s\S]*?\n {2}func cancel\(\)/.exec(
        iosTask,
      )?.[0] ?? "";
    expect(iosStart).not.toBe("");
    expect(iosStart).toMatch(
      /cancelled = false[\s\S]*?uploadTask = session\.uploadTask\(with: request, fromFile: sourceUrl\)[\s\S]*?guard !cancelled else[\s\S]*?uploadTask\.resume\(\)/,
    );
    expect(iosStart).not.toMatch(/Task \{|\.async\s*\{|\.asyncAfter|await /);
    expect(iosTask).toMatch(
      /func cancel\(\) \{\s*cancelled = true\s*uploadTask\?\.cancel\(\)\s*\}/,
    );

    // nativeUploadTask.ts drives the handle the public `UploadTask` wraps, with the wrapper's own
    // calls: the "FileSystem" module's FileSystemUploadTask, start(url, file, options) with these
    // options, progress events and release. Only the wrapper's once-only cancel is bypassed.
    expect(read(`${fs}src/ExpoFileSystem.ts`)).toMatch(
      /export default requireNativeModule<ExpoFileSystemModule>\('FileSystem'\);/,
    );
    const wrapper =
      /export class UploadTask \{[\s\S]*?\r?\n\}\r?\n/.exec(
        read(`${fs}src/NetworkTasks.ts`),
      )?.[0] ?? "";
    expect(wrapper).toMatch(/this\._nativeTask = new ExpoFileSystem\.FileSystemUploadTask\(\);/);
    expect(wrapper).toMatch(
      /const nativeOpts = \{\s*httpMethod: [^\n]*,\s*uploadType: [^\n]*,\s*headers: this\._options\?\.headers,[\s\S]*?sessionType: this\._options\?\.sessionType,\s*\};\s*const result = await this\._nativeTask\.start\(this\._url, this\._file, nativeOpts\);/,
    );
    expect(wrapper).toMatch(/return this\._nativeTask\.addListener\(eventName, listener\);/);
    expect(wrapper).toMatch(/this\._nativeTask\.release\(\);/);
    expect(wrapper).toMatch(
      /cancel\(\): void \{\s*if \(\['completed', 'cancelled', 'error'\]\.includes\(this\._state\)\) return;/,
    );
  });
});
