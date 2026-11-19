import { createServer, type ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

// The real fetch, kept before the tests stub it: the redirect test talks to real listeners.
const nativeFetch = globalThis.fetch;

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({
  cookies: async () => jar.current,
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import { ACCESS_TOKEN, me, requestsTo, signIn } from "../../../../support/support-test-helpers";
import { dispute, DISPUTE_ID, PHOTO_ID, SIGNED_URL } from "../../../disputes-test-helpers";
import { GET } from "./route";

const DETAIL = `/v1/admin/disputes/${DISPUTE_ID}`;
const STORAGE_PATH = new URL(SIGNED_URL).pathname;
const BYTES = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70]); // a JPEG's first bytes
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

/** The API (the staff check, the dispute's detail) and the storage's photo. */
function serve(options: { detail?: () => Response; file?: () => Response } = {}): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me("agent"),
      [DETAIL]: options.detail ?? (() => Response.json(dispute())),
      [STORAGE_PATH]:
        options.file ??
        (() =>
          new Response(BYTES, {
            headers: { "Content-Type": "image/jpeg", "Content-Length": "8" },
          })),
    }),
  );
}

function open(photoId = PHOTO_ID, disputeId = DISPUTE_ID): Promise<Response> {
  return GET(new Request(`http://panel.test/admin/disputes/${disputeId}/photos/${photoId}`), {
    params: Promise.resolve({ disputeId, photoId }),
  });
}

/** A real HTTP listener on 127.0.0.1 that records every path it is asked for. */
async function listener(
  answer: (response: ServerResponse) => void,
): Promise<{ origin: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? "");
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    asked,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Everything a response shows: its status, headers and body. */
async function everything(response: Response): Promise<string> {
  return `${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`;
}

describe("a dispute's photo, opened through the panel", () => {
  it("passes the photo on inline, never cached, after an audited staff read of the dispute", async () => {
    serve();
    const response = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);

    const [read] = requestsTo(fetchMock.mock.calls, DETAIL);
    expect(new Headers(read?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(read?.init?.cache).toBe("no-store");
    const [file] = requestsTo(fetchMock.mock.calls, STORAGE_PATH);
    expect(file?.init?.redirect).toBe("error");
    expect(file?.init?.cache).toBe("no-store");
  });

  it("never shows the signed address, even when the storage cannot be reached", async () => {
    serve({
      file: () => {
        throw new TypeError(`fetch failed for ${SIGNED_URL}`);
      },
    });
    const response = await open();
    const shown = await everything(response);
    expect(response.status).toBe(502);
    expect(shown).not.toContain("X-Amz-Signature");
    expect(shown).not.toContain("storage.test.invalid");
  });

  it.each(["text/html", "image/svg+xml", "application/pdf", ""])(
    "refuses a file the storage sends as %j",
    async (type) => {
      serve({ file: () => new Response(BYTES, { headers: type ? { "Content-Type": type } : {} }) });
      const response = await open();
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("");
    },
  );

  it("is not found for a photo that is not this dispute's, or a dispute the API does not know", async () => {
    serve();
    expect((await open("1a2b3c4d-1111-4222-8333-944455556666")).status).toBe(404);
    serve({ detail: () => Response.json({ error: { code: "not_found" } }, { status: 404 }) });
    expect((await open()).status).toBe(404);
  });

  it("never asks the API for ids that are not UUIDs", async () => {
    serve();
    expect((await open("../../etc")).status).toBe(404);
    expect((await open(PHOTO_ID, "not-a-uuid")).status).toBe(404);
    expect(requestsTo(fetchMock.mock.calls, DETAIL)).toEqual([]);
  });

  // A redirect from the storage must not lead the server to another host. Real listeners and
  // the real fetch: the other host gets no request at all.
  it.each([301, 302, 307])(
    "never follows a %i from the storage: the other host is never asked",
    async (status) => {
      const other = await listener((response) => {
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(Buffer.from(BYTES));
      });
      const storage = await listener((response) => {
        response.writeHead(status, { Location: `${other.origin}/private` });
        response.end();
      });
      try {
        const signed = `${storage.origin}/safe/u/photo.jpg?X-Amz-Signature=redirect-probe`;
        const api = routeFetch({
          "/v1/auth/me": () => me("agent"),
          [DETAIL]: () =>
            Response.json(
              dispute({
                photos: [
                  {
                    id: PHOTO_ID,
                    content_type: "image/jpeg",
                    url: signed,
                    expires_at: "2026-11-18T13:00:00Z",
                  },
                ],
              }),
            ),
        });
        fetchMock.mockImplementation((input, init) =>
          String(input).startsWith(storage.origin) ? nativeFetch(input, init) : api(input, init),
        );

        const response = await open();

        expect(storage.asked).toEqual(["/safe/u/photo.jpg?X-Amz-Signature=redirect-probe"]);
        expect(other.asked).toEqual([]);
        expect(response.status).toBe(502);
        expect(await everything(response)).not.toContain("Signature");
      } finally {
        await Promise.all([storage.close(), other.close()]);
      }
    },
  );

  it("answers 502 when the API fails", async () => {
    serve({ detail: () => new Response("", { status: 500 }) });
    expect((await open()).status).toBe(502);
  });

  it("sends a visitor without a staff session to end it, before anything is read", async () => {
    cookies.reset({});
    serve();
    await expect(open()).rejects.toBeInstanceOf(RedirectSignal);
    expect(requestsTo(fetchMock.mock.calls, DETAIL)).toEqual([]);
  });
});
