import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCookieJar, MARKER, RedirectSignal } from "@/lib/test-helpers";

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
// The one retry, made visible in the markup (the real one only acts in a browser).
vi.mock("./retry-once", () => ({
  RetryOnce: ({ href, seconds }: { href: string; seconds: number }) =>
    createElement("i", { "data-retry": href, "data-seconds": seconds }),
}));

import { SESSION_COOKIE } from "@/lib/session";

import BusyPage from "./page";

let cookies: FakeCookieJar;

beforeEach(() => {
  cookies = new FakeCookieJar();
  cookies.reset({ [SESSION_COOKIE]: MARKER });
  jar.current = cookies;
});

async function page(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await BusyPage({ searchParams: Promise.resolve(query) }));
}

describe("the busy page (#530)", () => {
  it("says the panel is busy and the staff member is still signed in, with a way back", async () => {
    const html = await page({ next: "/admin/queue?tab=urgent" });

    expect(html).toContain("<h1");
    expect(html).toContain("The panel is busy right now");
    expect(html).toContain("You&#x27;re still signed in; try again in a moment.");
    expect(html).toContain('href="/admin/queue?tab=urgent"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("data-retry");
    // Nothing was cleared or written: the session is untouched.
    expect(cookies.sets).toEqual([]);
    expect(cookies.deletes).toEqual([]);
  });

  it("goes back to the panel for a return address that is not a panel path", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/admin/session/busy"]) {
      const html = await page({ next });
      expect(html, next).toContain('href="/admin"');
      expect(html, next).not.toContain("evil");
    }
  });

  it("retries by itself once, through the refresh marked as the retry, for a wait of 1 to 5 s", async () => {
    expect(await page({ next: "/admin/kpis", wait: "3" })).toContain(
      'data-retry="/admin/session/refresh?next=%2Fadmin%2Fkpis&amp;retried=1" data-seconds="3"',
    );
    expect(await page({ wait: "5" })).toContain(
      'data-retry="/admin/session/refresh?retried=1" data-seconds="5"',
    );
    for (const wait of ["0", "6", "60", "2.5", "-1", "soon", ""]) {
      expect(await page({ wait }), wait).not.toContain("data-retry");
    }
  });

  it("sends a browser without a session to the login, with the page it asked for", async () => {
    cookies.reset({});

    await expect(page({ next: "/admin/kpis", wait: "3" })).rejects.toEqual(
      new RedirectSignal("/admin/login?next=%2Fadmin%2Fkpis"),
    );
  });
});
