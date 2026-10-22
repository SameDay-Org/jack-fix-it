import type { ApiSchema } from "@jack/shared";

import { UploadFailedError, UploadRejectedError } from "../errors";
import { sessionStore } from "../session";
import { uploadMedia, type UploadMediaOptions } from "../upload";
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

/** A stand-in for React Native's XMLHttpRequest: records the request, the test settles it. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  timeout = 0;
  body: unknown;
  status = 0;
  aborted = false;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
  timeOut() {
    this.ontimeout?.();
  }
}

const BLOB = { size: FILE_SIZE } as Blob;
// `__DEV__` is a global the bundler defines; the test flips it to check the production rule.
const runtime = globalThis as unknown as { __DEV__: boolean };
let fetchMock: FetchMock;
let tickets: ApiSchema<"UploadResponse">[];
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
  jest.spyOn(console, method),
);

/** Lets the upload reach its next await (the file read, the URL request, the PUT). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const lastXhr = () => FakeXhr.instances[FakeXhr.instances.length - 1];
const start = (options: Partial<UploadMediaOptions> = {}) =>
  uploadMedia({
    purpose: "request_media",
    file: { uri: FILE_URI, contentType: "image/jpeg" },
    ...options,
  });

beforeEach(() => {
  FakeXhr.instances = [];
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  tickets = [ticket(1), ticket(2)];
  fetchMock = installFetchMock();
  fetchMock.mockImplementation(async (url) => {
    if (url === FILE_URI) return { blob: async () => BLOB } as unknown as Response;
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

describe("uploadMedia", () => {
  it("asks for a URL signed for the file's type and the size of the bytes it will send", async () => {
    const upload = start();
    await flush();

    const [call] = callsTo(fetchMock, "/v1/uploads");
    expect(callBody(call)).toEqual({
      purpose: "request_media",
      content_type: "image/jpeg",
      size_bytes: FILE_SIZE,
    });
    expect(callHeader(call, "Authorization")).toBe("Bearer access-1");

    lastXhr().respond(200);
    await expect(upload).resolves.toEqual({ key: ticket(1).key });
  });

  it("PUTs the bytes to exactly the returned URL with exactly its headers, never the token", async () => {
    const upload = start();
    await flush();

    const xhr = lastXhr();
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(ticket(1).upload_url);
    expect(xhr.headers).toEqual(ticket(1).headers);
    expect(xhr.body).toBe(BLOB);
    // The fixed part plus the time to send the file at the slowest uplink waited for.
    const { uploadTimeoutMs, uploadMinBytesPerSecond } = configMock.apiConfig;
    expect(xhr.timeout).toBe(
      uploadTimeoutMs + Math.ceil((FILE_SIZE / uploadMinBytesPerSecond) * 1000),
    );

    xhr.respond(200);
    await upload;
    // One API call (the URL) and one file read; the storage only ever sees the XHR above.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      FILE_URI,
      expect.stringContaining("/v1/uploads"),
    ]);
  });

  it("reports progress from 0 to 1", async () => {
    const onProgress = jest.fn();
    const upload = start({ onProgress });
    await flush();

    lastXhr().progress(FILE_SIZE / 4, FILE_SIZE);
    lastXhr().progress(FILE_SIZE, FILE_SIZE);
    lastXhr().respond(200);
    await upload;

    expect(onProgress.mock.calls.map(([fraction]) => fraction)).toEqual([0, 0.25, 1, 1]);
  });

  it.each([
    [403, "upload_forbidden"],
    [403, "forbidden"],
    [422, "upload_invalid"],
  ])("%i %s is an UploadRejectedError, with no PUT and no retry", async (status, code) => {
    fetchMock.mockImplementation(async (url) =>
      url === FILE_URI
        ? ({ blob: async () => BLOB } as unknown as Response)
        : errorResponse(status, code),
    );

    const failure = await start().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UploadRejectedError);
    expect(failure).toMatchObject({ status, code });
    expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("a storage refusal is final: UploadFailedError with its status, no retry", async () => {
    const upload = start().catch((error: unknown) => error);
    await flush();
    lastXhr().respond(403);

    expect(await upload).toMatchObject({
      name: "UploadFailedError",
      reason: "status",
      status: 403,
    });
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("a PUT that times out fails with reason timeout, no retry", async () => {
    const upload = start().catch((error: unknown) => error);
    await flush();
    lastXhr().timeOut();

    expect(await upload).toMatchObject({ name: "UploadFailedError", reason: "timeout" });
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("a network failure retries once on the same URL while it is valid, then gives up", async () => {
    const upload = start().catch((error: unknown) => error);
    await flush();
    lastXhr().fail();
    await flush();

    expect(FakeXhr.instances).toHaveLength(2);
    expect(lastXhr().url).toBe(ticket(1).upload_url);
    expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(1);

    lastXhr().fail();
    const failure = await upload;
    expect(failure).toBeInstanceOf(UploadFailedError);
    expect(failure).toMatchObject({ reason: "network" });
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("a network failure after the URL expired asks for a fresh URL and uploads there", async () => {
    tickets = [ticket(1, -1), ticket(2)];
    const upload = start();
    await flush();
    lastXhr().fail();
    await flush();

    expect(callsTo(fetchMock, "/v1/uploads")).toHaveLength(2);
    expect(lastXhr().url).toBe(ticket(2).upload_url);
    expect(lastXhr().headers).toEqual(ticket(2).headers);

    lastXhr().respond(200);
    await expect(upload).resolves.toEqual({ key: ticket(2).key });
  });

  it("aborting while the URL is requested sends no PUT", async () => {
    fetchMock.mockImplementation(async (url, init) =>
      url === FILE_URI
        ? ({ blob: async () => BLOB } as unknown as Response)
        : neverAnswers(url, init),
    );
    const controller = new AbortController();
    const upload = start({ signal: controller.signal }).catch((error: unknown) => error);
    await flush();

    controller.abort();

    expect(await upload).toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("aborting during the PUT cancels it, without a retry", async () => {
    const controller = new AbortController();
    const upload = start({ signal: controller.signal }).catch((error: unknown) => error);
    await flush();

    controller.abort();

    expect(lastXhr().aborted).toBe(true);
    expect(await upload).toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("reads only files on this device", async () => {
    await expect(
      start({ file: { uri: "https://elsewhere.invalid/photo.jpg", contentType: "image/jpeg" } }),
    ).rejects.toThrow(/files on this device/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("outside development, refuses to send the file to a plain http URL", async () => {
    const dev = runtime.__DEV__;
    runtime.__DEV__ = false;
    tickets = [{ ...ticket(1), upload_url: "http://storage.test.invalid/bucket/u/1.jpg" }];
    try {
      await expect(start()).rejects.toThrow(/https/);
      expect(FakeXhr.instances).toHaveLength(0);
    } finally {
      runtime.__DEV__ = dev;
    }
  });
});
