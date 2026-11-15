import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, routeFetch } from "@/lib/test-helpers";

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ACCESS_TOKEN, decoded, me, requestsTo, signIn } from "../../support/support-test-helpers";
import { document, FILE_URL, OLD_DOCUMENT_ID, pro, PRO_ID } from "../pros-test-helpers";
import ProPage from "./page";

const PRO = `/v1/admin/pros/${PRO_ID}`;
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

function api(one: () => Response, locale = "en"): void {
  fetchMock.mockImplementation(
    routeFetch({ "/v1/auth/me": () => me("admin", locale), [PRO]: one }),
  );
}

async function markup(proId = PRO_ID): Promise<string> {
  return renderToStaticMarkup(await ProPage({ params: Promise.resolve({ proId }) }));
}

async function render(proId = PRO_ID): Promise<string> {
  return decoded(await markup(proId));
}

/** The labels of the page's buttons, in order. */
function buttons(page: string): string[] {
  return [...page.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label ?? "");
}

describe("pro page", () => {
  it("shows the profile, the documents with a preview link and the review buttons", async () => {
    api(() => Response.json(pro()));

    const html = await markup();
    const page = decoded(html);

    const [request] = requestsTo(fetchMock.mock.calls, PRO);
    expect(new Headers(request?.init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.init?.cache).toBe("no-store");
    for (const text of [
      "Lucía Ramírez",
      "Name on the account. Compare it with the ID document.",
      "Plumbing",
      "33301 Fort Lauderdale",
      "Not set up yet",
      "Photo ID",
      "Jan 31, 2031",
      "All pros",
    ]) {
      expect(page).toContain(text);
    }
    expect(page.replaceAll(/<[^>]+>/g, "")).toContain("Required: Photo ID, Insurance");
    expect(page).toContain("Not submitted yet: Insurance");
    // The pro's own text is shown as text, line breaks kept by the style: markup stays inert.
    expect(page).toContain("Plumber since 2009.\nCall me at 305-555-0141 <b>now</b>.");
    expect(html).toContain("&lt;b&gt;now&lt;/b&gt;");
    // The file opens in a new tab, with no opener and no referrer for the storage to read.
    const [link] = page.match(/<a [^>]*href="https:\/\/storage[^>]*>/g) ?? [];
    expect(link).toContain(`href="${FILE_URL}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    // A pending document can be approved or rejected; the pro too, each in two steps.
    expect(buttons(page)).toEqual(["Approve", "Reject", "Approve pro", "Reject pro"]);
    for (const button of page.match(/<button[^>]*>/g) ?? []) {
      expect(button).not.toContain('disabled=""');
    }
    // What an approval still needs, as the API lists it.
    expect(page).toContain("Before this pro can be approved");
    expect(page).toContain("Photo ID: no approved document");
    expect(page).toContain("Insurance: no approved document");
    expect(page).not.toContain("Earlier documents");
    expect(page).not.toContain(ACCESS_TOKEN);
  });

  it("offers no review of a document that has a decision, and shows the earlier ones", async () => {
    api(() =>
      Response.json(
        pro({
          verification_status: "rejected",
          rejection_reason: "The ID <i>photo</i> is blurry.",
          reviewed_at: "2026-11-08T09:00:00Z",
          payouts_enabled: true,
          photo: { url: "https://storage.test.invalid/get/u/p.jpg?sig=p", expires_at: "x" },
          documents: [
            document({ status: "approved", reviewed_at: "2026-11-08T08:00:00Z", expires_on: null }),
            document({
              id: OLD_DOCUMENT_ID,
              doc_type: "insurance",
              status: "approved",
              expires_on: "2020-01-31",
            }),
          ],
          history: [
            document({
              id: "d0c0f3a5-3333-4444-8555-166677778841",
              status: "rejected",
              rejection_reason: "Cropped.",
            }),
          ],
          missing_types: [],
          approval_blockers: [
            { kind: "document_expired", doc_type: "insurance" },
            { kind: "no_category", doc_type: null },
            { kind: "no_service_area", doc_type: null },
          ],
        }),
      ),
    );

    const html = await markup();
    const page = decoded(html);

    // A rejected pro can be approved later; rejecting again is not offered.
    expect(buttons(page)).toEqual(["Approve pro"]);
    for (const text of [
      "Rejected",
      "The ID <i>photo</i> is blurry.",
      "Nov 8, 2026, 9:00 AM UTC",
      "Set up",
      "No expiry date",
      "Expired",
      "Earlier documents",
      "Cropped.",
      "Open the profile photo",
      "Insurance: the approved document has expired",
      "The pro has no category",
      "The pro has no service area",
    ]) {
      expect(page).toContain(text);
    }
    expect(html).toContain("&lt;i&gt;photo&lt;/i&gt;");
    expect(page).not.toContain("Not submitted yet");
    expect(page.match(/rel="noopener noreferrer"/g)).toHaveLength(4);
  });

  it("offers only a rejection of an approved pro, with nothing left to do", async () => {
    api(() =>
      Response.json(
        pro({
          legal_name: null,
          verification_status: "approved",
          documents: [],
          missing_types: [],
          approval_blockers: [],
        }),
      ),
    );

    const page = await render();

    expect(buttons(page)).toEqual(["Reject pro"]);
    // Without a name on the account the public name stands in, and the page says so.
    expect(page).toContain("Lucía R.");
    expect(page).toContain("The account has no full name to compare with the ID document.");
    expect(page).toContain("No documents yet");
    expect(page).not.toContain("Before this pro can be approved");
  });

  it.each(["not-a-uuid", "..", `${PRO_ID}x`])(
    "never asks the API for an id that is not a UUID (%s)",
    async (proId) => {
      api(() => Response.json(pro()));

      const page = await render(proId);

      expect(page).toContain("This pro doesn't exist.");
      expect(requestsTo(fetchMock.mock.calls, PRO)).toEqual([]);
    },
  );

  it("says when the pro does not exist", async () => {
    api(() => Response.json({ error: { code: "pro_not_found" } }, { status: 404 }));

    const page = await render();

    expect(page).toContain("This pro doesn't exist.");
    expect(page).not.toContain('role="alert"');
    expect(buttons(page)).toEqual([]);
  });

  it.each([
    ["the API refuses", () => Response.json({ error: { code: "x" } }, { status: 500 })],
    [
      "the API cannot be reached",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("shows an error when %s", async (_, answer) => {
    api(answer);

    const page = await render();

    expect(page).toContain('role="alert"');
    expect(page).toContain("We couldn't load this pro. Try again in a moment.");
    expect(buttons(page)).toEqual([]);
  });

  it("is in Spanish for a Spanish-speaking staff member", async () => {
    api(() => Response.json(pro()), "es");

    const page = await render();

    for (const text of [
      "Todos los profesionales",
      "Plomería",
      "Identificación con foto",
      "Aprobar profesional",
      "Rechazar profesional",
      "Identificación con foto: sin documento aprobado",
      "31 ene 2031",
    ]) {
      expect(page).toContain(text);
    }
  });
});
