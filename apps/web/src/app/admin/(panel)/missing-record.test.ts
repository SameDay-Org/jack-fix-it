import type { ReactElement } from "react";
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

import LoginPage from "../login/page";
import { MissingRecord } from "./missing-record";
import ProNotFound from "./pros/[proId]/not-found";
import RequestNotFound from "./requests/[requestId]/not-found";
import { decoded, me, signIn } from "./support/support-test-helpers";
import TicketNotFound from "./support/[ticketId]/not-found";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  const cookies = new FakeCookieJar();
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

/** A not-found screen as Next renders it: the file's element, then its async component. */
async function screen(notFound: () => ReactElement, locale = "en"): Promise<string> {
  fetchMock.mockImplementation(routeFetch({ "/v1/auth/me": () => me("agent", locale) }));
  const element = notFound() as ReactElement<Parameters<typeof MissingRecord>[0]>;
  return decoded(renderToStaticMarkup(await MissingRecord(element.props)));
}

describe("a panel record that does not exist (#494)", () => {
  it.each([
    [ProNotFound, "This pro doesn't exist.", "/admin/pros", "All pros"],
    [RequestNotFound, "This request doesn't exist.", "/admin/queue", "Operations queue"],
    [TicketNotFound, "This ticket doesn't exist.", "/admin/support", "All tickets"],
  ])(
    "says so in the page's one heading, with the way back",
    async (notFound, message, href, back) => {
      const html = await screen(notFound);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toMatch(new RegExp(`<h1[^>]*>${message}</h1>`));
      expect(html).toMatch(new RegExp(`<a[^>]*href="${href}"[^>]*>.*${back}</a>`));
    },
  );

  it("speaks the staff member's language", async () => {
    const html = await screen(ProNotFound, "es");
    expect(html).toMatch(/<h1[^>]*>[^<]*profesional[^<]*<\/h1>/i);
  });
});

describe("the sign-in page (#493)", () => {
  it("has one h1: the page's title", async () => {
    // No return address: the sign-in page reads it from its search params (#464).
    const html = decoded(
      renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) })),
    );
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Sign in to the panel<\/h1>/);
  });
});
