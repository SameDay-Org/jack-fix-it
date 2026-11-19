import { createServer, type ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch, user } from "@/lib/test-helpers";

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

import {
  card,
  MEDIA_URL,
  NOW,
  OTHER_REQUEST_ID,
  REQUEST_ID,
} from "../../../../queue/queue-test-helpers";
import { ACCESS_TOKEN, me, requestsTo, signIn } from "../../../../support/support-test-helpers";
import { GET } from "./route";

const CARD = `/v1/admin/requests/${REQUEST_ID}`;
const OTHER_CARD = `/v1/admin/requests/${OTHER_REQUEST_ID}`;
const VIDEO_URL = "https://storage.test.invalid/get/m/safe.mp4?sig=video-probe";
const OTHER_URL = "https://storage.test.invalid/get/m/other.jpg?sig=other-probe";
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

const photo = {
  kind: "photo",
  content_type: "image/jpeg",
  url: MEDIA_URL,
  expires_at: NOW,
} as const;
const video = {
  kind: "video",
  content_type: "video/mp4",
  url: VIDEO_URL,
  expires_at: NOW,
} as const;

/**
 * The API (who is asking; this request's card with a photo and a video; another request's card
 * with three media) and the storage's files.
 */
function serve(
  options: { who?: () => Response; card?: () => Response; file?: () => Response } = {},
): void {
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": options.who ?? (() => me("agent")),
      [CARD]: options.card ?? (() => Response.json(card({ media: [photo, video] }))),
      [OTHER_CARD]: () =>
        Response.json(
          card({ id: OTHER_REQUEST_ID, media: [photo, video, { ...photo, url: OTHER_URL }] }),
        ),
      "/get/m/safe.jpg":
        options.file ??
        (() =>
          new Response(BYTES, {
            headers: { "Content-Type": "image/jpeg", "Content-Length": "8" },
          })),
      "/get/m/safe.mp4": () => new Response(BYTES, { headers: { "Content-Type": "video/mp4" } }),
      "/get/m/other.jpg": () => new Response(BYTES, { headers: { "Content-Type": "image/jpeg" } }),
    }),
  );
}

function open(index: string, requestId = REQUEST_ID): Promise<Response> {
  return GET(new Request(`http://panel.test/admin/requests/${requestId}/media/${index}`), {
    params: Promise.resolve({ requestId, index }),
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

describe("a request's media, opened through the panel", () => {
  it("passes the photo on inline, never cached, after an audited staff read of the card", async () => {
    serve();

    const response = await open("0");

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/jpeg",
      "content-disposition": "inline",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-length": "8",
    });
    // The staff member's own token reads the card (the API audits that read)...
    const [read] = requestsTo(fetchMock.mock.calls, CARD);
    expect(new Headers(read?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(read?.init?.cache).toBe("no-store");
    // ...and the file comes from the signed address the API just gave, never cached.
    const [file] = requestsTo(fetchMock.mock.calls, "/get/m/safe.jpg");
    expect(String(file?.url)).toBe(MEDIA_URL);
    expect(file?.init?.cache).toBe("no-store");
  });

  it("opens the request's video by its position", async () => {
    serve();
    const response = await open("1");
    expect([response.status, response.headers.get("Content-Type")]).toEqual([200, "video/mp4"]);
  });

  it.each([
    ["a request id that is no id", "0", "../../v1/auth/me"],
    ["a negative position", "-1", REQUEST_ID],
    ["a position with a leading zero", "01", REQUEST_ID],
    ["a position in another notation", "1e0", REQUEST_ID],
    ["a path", "..%2F..%2Fv1%2Fauth%2Fme", REQUEST_ID],
    ["a position past any card", "1000", REQUEST_ID],
  ])("is not found for %s, without asking anything", async (_, index, requestId) => {
    serve();
    expect((await open(index, requestId)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only ever opens a media of the request in the path", async () => {
    serve();
    // Position 2 exists on the other request's card, not on this one.
    const response = await open("2");
    expect(response.status).toBe(404);
    expect(requestsTo(fetchMock.mock.calls, OTHER_CARD)).toEqual([]);
    expect(requestsTo(fetchMock.mock.calls, "/get/m/other.jpg")).toEqual([]);
  });

  it("is not found for a request the API does not know", async () => {
    serve({ card: () => Response.json({ error: { code: "request_not_found" } }, { status: 404 }) });
    expect((await open("0")).status).toBe(404);
  });

  it.each<[string, () => Response]>([
    ["the storage refuses", () => new Response("AccessDenied", { status: 403 })],
    [
      "the file is not a type a customer may upload",
      () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    ],
    [
      "the file says it is a web page",
      () => new Response("<script>", { headers: { "Content-Type": "text/html" } }),
    ],
    [
      "the photo comes back as a video",
      () => new Response(BYTES, { headers: { "Content-Type": "video/mp4" } }),
    ],
    [
      "the photo comes back as a document",
      () => new Response(BYTES, { headers: { "Content-Type": "application/pdf" } }),
    ],
  ])("answers 502, with nothing in it, when %s", async (_, file) => {
    serve({ file });
    const response = await open("0");
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });

  it("never shows the signed address, even when the storage cannot be reached", async () => {
    serve({
      file: () => {
        throw new TypeError(`fetch failed for ${MEDIA_URL}`);
      },
    });
    const response = await open("0");
    const shown = await everything(response);
    expect(response.status).toBe(502);
    expect(shown).not.toContain("sig=");
    expect(shown).not.toContain("storage.test.invalid");
  });

  // Vault round 2 on #418: a redirect must not lead the server to another host. Real listeners
  // and the real fetch: the other host must receive no request at all.
  it.each([301, 302, 303, 307, 308])(
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
        const signed = `${storage.origin}/safe.jpg?sig=redirect-probe`;
        const api = routeFetch({
          "/v1/auth/me": () => me("agent"),
          [CARD]: () => Response.json(card({ media: [{ ...photo, url: signed }] })),
        });
        fetchMock.mockImplementation((input, init) =>
          String(input).startsWith(storage.origin) ? nativeFetch(input, init) : api(input, init),
        );

        const response = await open("0");

        expect(storage.asked).toEqual(["/safe.jpg?sig=redirect-probe"]);
        expect(other.asked).toEqual([]);
        expect(response.status).toBe(502);
        expect(await everything(response)).not.toContain("sig=");
      } finally {
        await Promise.all([storage.close(), other.close()]);
      }
    },
  );

  it("answers 502 when the API fails", async () => {
    serve({ card: () => new Response("", { status: 500 }) });
    expect((await open("0")).status).toBe(502);
  });

  it("sends a visitor without a staff session away, before anything is read", async () => {
    cookies.reset({});
    serve();
    await expect(open("0")).rejects.toBeInstanceOf(RedirectSignal);
    expect(requestsTo(fetchMock.mock.calls, CARD)).toEqual([]);
  });

  it.each(["customer", "pro"] as const)(
    "sends a signed-in %s away, before anything is read",
    async (role) => {
      serve({ who: () => Response.json(user(role)) });
      await expect(open("0")).rejects.toBeInstanceOf(RedirectSignal);
      expect(requestsTo(fetchMock.mock.calls, CARD)).toEqual([]);
      expect(requestsTo(fetchMock.mock.calls, "/get/m/safe.jpg")).toEqual([]);
    },
  );
});
