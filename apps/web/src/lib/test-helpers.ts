/** Test doubles for next/headers cookies() and next/navigation redirect(). Tests only. */
import type { AuthResponse, User } from "./session";

export type SetCall = { name: string; value: string; options: Record<string, unknown> };

/** An in-memory cookie jar with the slice of Next's API the session code uses. */
export class FakeCookieJar {
  readonly values = new Map<string, string>();
  readonly sets: SetCall[] = [];
  readonly deletes: { name: string; path?: string }[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.values.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options: Record<string, unknown> = {}): this {
    this.values.set(name, value);
    this.sets.push({ name, value, options });
    return this;
  }

  delete(options: { name: string; path?: string }): this {
    this.values.delete(options.name);
    this.deletes.push(options);
    return this;
  }

  reset(entries: Record<string, string> = {}): void {
    this.values.clear();
    this.sets.length = 0;
    this.deletes.length = 0;
    for (const [name, value] of Object.entries(entries)) this.values.set(name, value);
  }
}

/** What the redirect() mock throws, like Next's own redirect, so code after it never runs. */
export class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

export const TOKENS = {
  access_token: "access-token-probe-4821",
  refresh_token: "refresh-token-probe-4821",
  expires_in: 900,
  token_type: "bearer" as const,
};

export function user(role: User["role"], extra: Partial<User> = {}): User {
  return {
    id: "6f1c2a1e-1111-4222-8333-944455556666",
    email: "staff.probe@example.com",
    role,
    locale: "en",
    status: "active",
    phone: null,
    phone_verified: false,
    first_name: null,
    last_name: null,
    ...extra,
  };
}

/** The session id of the fixture login (a UUID, like the real ones). */
export const SID = "5f0e3c1a-7d2b-4e8f-9a61-0c3b2d4e5f60";

/** A token cookie's value under the fixture login: `<sid>.<token>`. */
export function bound(token: string): string {
  return `${SID}.${token}`;
}

/** The fixture login's session marker, for the user user() returns: `<sid>.<user id>`. */
export const MARKER = `${SID}.${user("agent").id}`;

export function auth(role: User["role"]): AuthResponse {
  return { ...TOKENS, user: user(role) };
}

/** A fetch mock answering by path: each value is the Response (or error) for that path. */
export function routeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${path}`);
    return route();
  };
}
