import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch } from "@/lib/test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import { ACCESS_TOKEN, me, requestsTo, signIn } from "../../../../support/support-test-helpers";
import {
  document,
  DOCUMENT_ID,
  FILE_URL,
  OLD_DOCUMENT_ID,
  pro,
  PRO_ID,
} from "../../../pros-test-helpers";
import { GET } from "./route";

const PRO = `/v1/admin/pros/${PRO_ID}`;
const PHOTO_URL = "https://storage.test.invalid/get/u/photo.jpg?sig=photo-probe";
const OLD_URL = "https://storage.test.invalid/get/u/old.png?sig=old-probe";
const BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]); // "%PDF-1.7"
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

/** The API (the staff check, the pro's detail) and the storage's three files. */
function serve(options: { detail?: () => Response; file?: () => Response } = {}): void {
  const file =
    options.file ??
    (() =>
      new Response(BYTES, {
        headers: { "Content-Type": "application/pdf", "Content-Length": "8" },
      }));
  fetchMock.mockImplementation(
    routeFetch({
      "/v1/auth/me": () => me("agent"),
      [PRO]:
        options.detail ??
        (() =>
          Response.json(
            pro({
              photo: { url: PHOTO_URL, expires_at: "2026-11-07T14:35:00Z" },
              history: [document({ id: OLD_DOCUMENT_ID, status: "rejected", url: OLD_URL })],
            }),
          )),
      "/get/u/doc.pdf": file,
      "/get/u/photo.jpg": () => new Response(BYTES, { headers: { "Content-Type": "image/jpeg" } }),
      "/get/u/old.png": () => new Response(BYTES, { headers: { "Content-Type": "image/png" } }),
    }),
  );
}

function open(fileId: string, proId = PRO_ID): Promise<Response> {
  return GET(new Request(`http://panel.test/admin/pros/${proId}/files/${fileId}`), {
    params: Promise.resolve({ proId, fileId }),
  });
}

/** Everything a response shows: its status, headers and body. */
async function everything(response: Response): Promise<string> {
  return `${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`;
}

describe("a pro's file, opened through the panel", () => {
  it("passes the document on inline, never cached, after an audited staff read of the pro", async () => {
    serve();

    const response = await open(DOCUMENT_ID);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": "inline",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-length": "8",
    });
    // The staff member's own token reads the pro (the API audits that read)...
    const [read] = requestsTo(fetchMock.mock.calls, PRO);
    expect(new Headers(read?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    // ...and the file comes from the signed address the API just gave, never cached.
    const [file] = requestsTo(fetchMock.mock.calls, "/get/u/doc.pdf");
    expect(String(file?.url)).toBe(FILE_URL);
    expect(file?.init?.cache).toBe("no-store");
  });

  it("opens the profile photo and an older document too", async () => {
    serve();
    const photo = await open("photo");
    const old = await open(OLD_DOCUMENT_ID);
    expect([photo.status, photo.headers.get("Content-Type")]).toEqual([200, "image/jpeg"]);
    expect([old.status, old.headers.get("Content-Type")]).toEqual([200, "image/png"]);
  });

  it.each([
    ["a file id that is no document id", "not-a-uuid", PRO_ID],
    ["a pro id that is no id", DOCUMENT_ID, "../../v1/auth/me"],
  ])("is not found for %s, without asking anything", async (_, fileId, proId) => {
    serve();
    expect((await open(fileId, proId)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not found for a document that is not this pro's, or a pro the API does not know", async () => {
    serve();
    expect((await open("d0c0f3a5-9999-4999-8999-999999999999")).status).toBe(404);
    serve({ detail: () => Response.json({ error: { code: "pro_not_found" } }, { status: 404 }) });
    expect((await open(DOCUMENT_ID)).status).toBe(404);
  });

  it("is not found for the photo of a pro who has none", async () => {
    serve({ detail: () => Response.json(pro({ photo: null })) });
    expect((await open("photo")).status).toBe(404);
  });

  it.each<[string, () => Response]>([
    ["the storage refuses", () => new Response("AccessDenied", { status: 403 })],
    [
      "the file is not a type a pro may upload",
      () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    ],
    [
      "the file says it is a web page",
      () => new Response("<script>", { headers: { "Content-Type": "text/html" } }),
    ],
  ])("answers 502, with nothing in it, when %s", async (_, file) => {
    serve({ file });
    const response = await open(DOCUMENT_ID);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });

  it("never shows the signed address, even when the storage cannot be reached", async () => {
    serve({
      file: () => {
        throw new TypeError(`fetch failed for ${FILE_URL}`);
      },
    });
    const response = await open(DOCUMENT_ID);
    const shown = await everything(response);
    expect(response.status).toBe(502);
    expect(shown).not.toContain("sig=");
    expect(shown).not.toContain("storage.test.invalid");
  });

  it("answers 502 when the API fails", async () => {
    serve({ detail: () => new Response("", { status: 500 }) });
    expect((await open(DOCUMENT_ID)).status).toBe(502);
  });

  it("sends a visitor without a staff session to end it, before anything is read", async () => {
    cookies.reset({});
    serve();
    await expect(open(DOCUMENT_ID)).rejects.toBeInstanceOf(RedirectSignal);
    expect(requestsTo(fetchMock.mock.calls, PRO)).toEqual([]);
  });
});
