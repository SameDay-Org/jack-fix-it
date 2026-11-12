/** Fixtures of the support page tests: a staff session and tickets as the API returns them. Tests only. */
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from "@/lib/session";
import { bound, type FakeCookieJar, MARKER, user } from "@/lib/test-helpers";

import type { Ticket, TicketItem } from "./tickets";

export const ACCESS_TOKEN = "at-support-probe";
export const TICKET_ID = "0f3a5c1e-1111-4222-8333-944455556666";
export const JOB_ID = "7b2d9e4a-5555-4666-8777-188899990000";
export const MESSAGE = "The app froze on the payment step.\nCall me at 305-555-0142 <b>please</b>.";

/** Signs the fixture staff member in: the cookies a login leaves. */
export function signIn(cookies: FakeCookieJar): void {
  cookies.reset({
    [SESSION_COOKIE]: MARKER,
    [ACCESS_COOKIE]: bound(ACCESS_TOKEN),
    [REFRESH_COOKIE]: bound("rt-support-probe"),
  });
}

/** `GET /v1/auth/me` for the fixture login, in a role and a locale. */
export function me(role: "agent" | "admin" | "customer" = "agent", locale = "en"): Response {
  return Response.json(user(role, { locale }));
}

export function item(extra: Partial<TicketItem> = {}): TicketItem {
  return {
    id: TICKET_ID,
    user_id: "3c1e0f3a-2222-4333-8444-655566667777",
    user_first_name: "Ana",
    role: "customer",
    topic: "payment",
    job_id: null,
    status: "open",
    created_at: "2026-11-07T14:30:00Z",
    ...extra,
  };
}

export function ticket(extra: Partial<Ticket> = {}): Ticket {
  return {
    ...item(),
    message: MESSAGE,
    closed_at: null,
    app_version: null,
    platform: null,
    updated_at: "2026-11-07T14:30:00Z",
    ...extra,
  };
}

/** The markup as a reader sees its text: the entities React escapes, decoded. */
export function decoded(markup: string): string {
  return markup
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The requests a fetch mock received, by path. */
export function requestsTo(
  calls: [input: RequestInfo | URL, init?: RequestInit][],
  path: string,
): { url: URL; init: RequestInit | undefined }[] {
  return calls
    .map(([input, init]) => ({ url: new URL(String(input)), init }))
    .filter(({ url }) => url.pathname === path);
}
