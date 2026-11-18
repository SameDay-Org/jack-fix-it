import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, RedirectSignal, routeFetch, user } from "@/lib/test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("@/lib/test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
    useRouter: () => ({ refresh: () => {} }),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { decoded, me, requestsTo, signIn } from "../../support/support-test-helpers";
import {
  CODE,
  dispute,
  DISPUTE_ID,
  hoursAgo,
  NOW,
  payment,
  PHOTO_ID,
  refund,
  REPLY,
  SIGNED_URL,
} from "../disputes-test-helpers";
import DisputeLoading from "./loading";
import DisputePage from "./page";

const DETAIL = `/v1/admin/disputes/${DISPUTE_ID}`;
const fetchMock = vi.fn<typeof fetch>();
let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  signIn(cookies);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("API_INTERNAL_URL", "http://api.test.invalid:8000");
  vi.stubEnv("API_TIMEOUT_MS", "1000");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function api(
  detail: () => Response,
  { role = "admin", locale = "en" }: { role?: "agent" | "admin"; locale?: string } = {},
): void {
  fetchMock.mockImplementation(
    routeFetch({ "/v1/auth/me": () => me(role, locale), [DETAIL]: detail }),
  );
}

async function markup(disputeId = DISPUTE_ID): Promise<string> {
  return renderToStaticMarkup(await DisputePage({ params: Promise.resolve({ disputeId }) }));
}

async function render(disputeId = DISPUTE_ID): Promise<string> {
  return decoded(await markup(disputeId));
}

describe("dispute page", () => {
  it("shows both sides' text as plain text, never as markup", async () => {
    api(() => Response.json(dispute()));
    const raw = await markup();
    // React escaped the sentinel: no tag reached the page.
    expect(raw).not.toContain("<script>alert");
    expect(raw).not.toContain("<b>bold</b>");
    expect(raw).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &lt;b&gt;bold&lt;/b&gt;",
    );
    const page = decoded(raw);
    expect(page).toContain("The customer's report");
    expect(page).toContain("The pro's reply");
    expect(page).toContain(REPLY);
    expect(page).toMatch(/whitespace-pre-wrap">The tap still leaks.\n</);
  });

  it("says when the pro has not replied", async () => {
    api(() => Response.json(dispute({ pro_reply: null, pro_replied_at: null })));
    expect(await render()).toContain("The pro hasn't replied.");
  });

  it("shows the photos only through the panel's route, never the signed address", async () => {
    api(() => Response.json(dispute()));
    const raw = await markup();
    const route = `/admin/disputes/${DISPUTE_ID}/photos/${PHOTO_ID}`;
    expect(raw).toContain(`<img src="${route}" alt="Photo 1 of the report" loading="lazy"`);
    expect(raw).toContain(`href="${route}"`);
    expect(raw).not.toContain(SIGNED_URL);
    expect(raw).not.toContain("storage.test.invalid");
    expect(raw).not.toContain("X-Amz-Signature");
  });

  it("says how many photos are still being checked, and when there are none", async () => {
    api(() => Response.json(dispute({ photos: [], photos_pending: 2 })));
    expect(await render()).toContain("Photos still being checked: 2.");
    api(() => Response.json(dispute({ photos: [], photos_pending: 0 })));
    expect(await render()).toContain("No photos with this report.");
  });

  it("shows the money as the API froze it", async () => {
    api(() => Response.json(dispute()));
    const page = await render();
    for (const [term, value] of [
      ["Customer paid", "$132.50"],
      ["Of which tax", "$7.50"],
      ["Pro payout", "$100.00"],
      ["Platform fee", "$25.00"],
      ["Payment", "Paid"],
      ["Refund", "None"],
      ["Payout to the pro", "None"],
    ]) {
      expect(page).toMatch(
        new RegExp(`<dt[^>]*>${term}</dt><dd[^>]*>(<span[^>]*>)?${value.replace("$", "\\$")}`),
      );
    }
  });

  it("says when the job's payment is missing", async () => {
    api(() =>
      Response.json(dispute({ payment: null, customer_total_cents: null, currency: null })),
    );
    expect(await render()).toContain(
      "No payment on record for this job: it needs a review before it can be resolved.",
    );
  });

  it("puts a banner over a refund Stripe has not finished", async () => {
    api(() =>
      Response.json(
        dispute({
          refund: refund({ status: "created", stripe_status: "pending", amount_cents: 7_220 }),
        }),
      ),
    );
    const page = await render();
    expect(page).toMatch(
      /<section aria-labelledby="refund-banner" data-refund="pending" class="[^"]*bg-warning/,
    );
    expect(page).toContain("A refund is being processed");
    expect(page).toContain("Stripe hasn't finished the refund of $72.20 yet.");
    expect(page).toContain("$72.20</span> · Processing at Stripe");
  });

  it("puts the same banner over an attempt still under way, before Stripe holds a refund", async () => {
    api(() =>
      Response.json(
        dispute({
          refund: refund({ status: "pending", stripe_status: null, stripe_refund_id: null }),
        }),
      ),
    );
    const page = await render();
    expect(page).toContain('data-refund="pending"');
    expect(page).toContain("$132.50</span> · Being processed");
  });

  it("puts a red banner over a refund Stripe failed: the money did not go back", async () => {
    api(() =>
      Response.json(
        dispute({
          refund_failed: true,
          refund: refund({ status: "created", stripe_status: "failed" }),
        }),
      ),
    );
    const page = await render();
    expect(page).toMatch(/data-refund="failed" class="[^"]*bg-danger/);
    expect(page).toContain("The refund failed");
    expect(page).toContain("the money did not go back to the customer");
    expect(page).toContain("Ask an engineer to repair it in Stripe.");
    expect(page).toContain("· Failed at Stripe");
  });

  it("says when the last refund attempt did not go through, with Stripe's code", async () => {
    api(() =>
      Response.json(
        dispute({
          refund: refund({
            status: "failed",
            stripe_status: null,
            stripe_refund_id: null,
            last_error_code: "charge_disputed",
          }),
        }),
      ),
    );
    const page = await render();
    expect(page).toMatch(/data-refund="attempt_failed" class="[^"]*bg-warning/);
    expect(page).toContain("The last refund attempt didn't go through");
    expect(page).toContain("send the same decision again, or ask an engineer to check Stripe");
    expect(page).toContain("Stripe code: charge_disputed");
  });

  it("puts no banner over a refund Stripe made", async () => {
    api(() => Response.json(dispute({ refund: refund({ status: "created" }) })));
    const page = await render();
    expect(page).not.toContain("refund-banner");
    expect(page).toContain("$132.50</span> · Refunded");
  });

  it("lists the job's history", async () => {
    api(() => Response.json(dispute()));
    const page = await render();
    const history = page.slice(page.indexOf("Job history"));
    expect(history.indexOf(">Completed<")).toBeLessThan(history.indexOf(">Disputed<"));
  });

  it("gives an admin the resolve control", async () => {
    api(() => Response.json(dispute()), { role: "admin" });
    const page = await render();
    expect(page).toContain("Review the decision");
    expect(page).toContain("Release the payout to the pro");
    expect(page).toContain("Refund the customer in full");
    expect(page).not.toContain("Only admins can resolve disputes.");
  });

  it("shows an agent the dispute read-only: no decision, no note, no button", async () => {
    api(() => Response.json(dispute()), { role: "agent" });
    const page = await render();
    expect(page).toContain("Only admins can resolve disputes.");
    expect(page).not.toContain("Review the decision");
    expect(page).not.toContain('type="radio"');
    expect(page).not.toContain("<textarea");
    expect(page).not.toContain("<form");
  });

  it("shows a resolved dispute's resolution: decision, when, who, amounts and note", async () => {
    api(() =>
      Response.json(
        dispute({
          status: "resolved",
          resolution: "partial_release",
          resolved_at: hoursAgo(1),
          resolved_by: user("admin").id,
          pro_release_cents: 4_550,
          customer_refund_cents: 7_220,
          resolution_note: "Half the job was done.\n<i>checked photos</i>",
          refund: refund({ amount_cents: 7_220 }),
          job_status: "disputed",
        }),
      ),
    );
    const page = await render();
    const resolution = page.slice(page.indexOf(">Resolution<"));
    expect(resolution).toMatch(/<dt[^>]*>Decision<\/dt><dd[^>]*>Split</);
    expect(resolution).toMatch(/<dt[^>]*>By<\/dt><dd[^>]*>You</);
    expect(resolution).toMatch(/<dt[^>]*>Released to the pro<\/dt><dd[^>]*>\$45.50</);
    expect(resolution).toMatch(/<dt[^>]*>Refunded to the customer<\/dt><dd[^>]*>\$72.20</);
    expect(resolution).toContain("Half the job was done.\n<i>checked photos</i>");
    expect(await markup()).toContain("&lt;i&gt;checked photos&lt;/i&gt;");
    expect(page).not.toContain("Review the decision");
  });

  it("names another admin by the id the API gives", async () => {
    const other = "8d2c4e6a-1111-4222-8333-944455556666";
    api(() =>
      Response.json(dispute({ status: "resolved", resolution: "released", resolved_by: other })),
    );
    expect(await render()).toContain(other);
  });

  it("shows the code, the reason and the wait", async () => {
    api(() => Response.json(dispute({ opened_at: hoursAgo(30) })));
    const page = await render();
    expect(page).toContain(`<h1 class="text-2xl font-bold">Dispute ${CODE}</h1>`);
    expect(page).toContain("Work not finished");
    expect(page).toMatch(/data-tone="warn"[^>]*>Opened 30 h ago · waiting long</);
  });

  it("does not ask the API for an id that is not a UUID", async () => {
    api(() => Response.json(dispute()));
    const page = await render("not-a-uuid");
    expect(page).toContain("We couldn't find this dispute.");
    expect(requestsTo(fetchMock.mock.calls, DETAIL)).toHaveLength(0);
  });

  it("says when the dispute does not exist", async () => {
    api(() => Response.json({ error: { code: "not_found" } }, { status: 404 }));
    expect(await render()).toContain("We couldn't find this dispute.");
  });

  it("shows an error with a retry when the API fails", async () => {
    api(() => Response.json({ error: { code: "x", message: "raw API text" } }, { status: 500 }));
    const page = await render();
    expect(page).toMatch(/<div [^>]*role="alert"/);
    expect(page).toContain("We couldn't load this dispute.");
    expect(page).toContain(`href="/admin/disputes/${DISPUTE_ID}"`);
    expect(page).not.toContain("raw API text");
  });

  it("speaks Spanish", async () => {
    api(() => Response.json(dispute({ refund: refund({ stripe_status: "pending" }) })), {
      locale: "es",
    });
    const page = await render();
    expect(page).toContain(`Disputa ${CODE}`);
    expect(page).toContain("El reporte del cliente");
    expect(page).toContain("Un reembolso está en proceso");
    expect(page).toContain("Revisar la decisión");
  });

  it("asks nothing of the dispute without a staff session", async () => {
    cookies.reset({});
    api(() => Response.json(dispute()));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(requestsTo(fetchMock.mock.calls, DETAIL)).toHaveLength(0);
  });

  it("uses the payment's own numbers, never sums of its own", async () => {
    // Amounts that do not add up: the page shows each as given.
    api(() =>
      Response.json(
        dispute({ payment: payment({ customer_total_cents: 99_999, pro_payout_cents: 1 }) }),
      ),
    );
    const page = await render();
    expect(page).toContain("$999.99");
    expect(page).toMatch(/<dt[^>]*>Pro payout<\/dt><dd[^>]*>\$0.01</);
  });
});

describe("dispute loading state", () => {
  it("says it is loading, in gray blocks still under Reduce Motion", async () => {
    api(() => Response.json(dispute()));
    const page = decoded(renderToStaticMarkup(await DisputeLoading()));
    expect(page).toContain('aria-busy="true"');
    expect(page).toMatch(/<p role="status"[^>]*>Loading the dispute…<\/p>/);
    expect(page).not.toMatch(/ animate-pulse/);
  });
});
