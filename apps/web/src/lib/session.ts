/**
 * The admin panel session (D16.1, #80): the API's tokens in httpOnly cookies, staff only.
 *
 * - `jfi_at` (access) and `jfi_rt` (refresh) are httpOnly, SameSite=Strict, Path=/admin and
 *   Secure when deployed. Client JavaScript never sees them; they never go in a URL or a log.
 * - `requireStaff()` (the panel layout) checks the session on every request against
 *   `GET /v1/auth/me`, so a role change or a suspension takes effect at once.
 * - Only a server action or a route handler may write cookies, so a server component that
 *   finds an expired access token redirects to `/admin/session/refresh`, which refreshes once
 *   (rotating both cookies) and comes back; any failure ends at `/admin/session/end`, which
 *   clears the cookies and goes to the login.
 * - Each login gets a random session id. `jfi_sid` holds `<sid>.<user id>` and only login
 *   sets it; the token cookies hold `<sid>.<token>`, and a refresh writes the new tokens under
 *   the same sid, never the marker. Tokens count only under the current login's sid (compared
 *   in constant time), and `/me` must answer the login's user. So a refresh response that
 *   lands late (another tab, a slow network) cannot revive a logout, nor put user A's tokens
 *   under user B's later login: the next render ends the session. The API only ever sees the
 *   raw tokens.
 * - Both session routes act only on requests from this site (`fromThisSite`): a cross-site
 *   navigation arrives without the Strict cookies, and a Set-Cookie on it would still delete
 *   them in the browser.
 */
import { timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { components } from "@jack/shared";

import { ApiError, apiGet, apiPost } from "./api";

export type User = components["schemas"]["UserOut"];
export type AuthResponse = components["schemas"]["AuthResponse"];

export const ACCESS_COOKIE = "jfi_at";
export const REFRESH_COOKIE = "jfi_rt";
// Set by a refresh for a little less than the new access token lives: if the API still refuses
// that token, the session ends instead of refreshing again, so a broken session never loops,
// while a refresh that becomes due later, once the token expires, still happens.
export const REFRESHED_COOKIE = "jfi_rf";
export const SESSION_COOKIE = "jfi_sid";
export const PANEL_PATH = "/admin";
export const LOGIN_PATH = "/admin/login";
export const REFRESH_PATH = "/admin/session/refresh";
export const END_PATH = "/admin/session/end";
const STAFF_ROLES: ReadonlySet<string> = new Set(["agent", "admin"]);
const DEPLOYED: ReadonlySet<string> = new Set(["staging", "production"]);

export type CookieOptions = {
  httpOnly: true;
  sameSite: "strict";
  path: string;
  secure: boolean;
  maxAge: number;
};

export function isStaff(user: Pick<User, "role">): boolean {
  return STAFF_ROLES.has(user.role);
}

export function cookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    path: PANEL_PATH,
    secure: DEPLOYED.has(process.env.APP_ENV ?? ""),
    maxAge,
  };
}

/** REFRESH_TOKEN_TTL_SECONDS: the API's refresh token lifetime, mirrored (never a literal). */
export function refreshTokenTtlSeconds(): number {
  const seconds = Number(process.env.REFRESH_TOKEN_TTL_SECONDS);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("REFRESH_TOKEN_TTL_SECONDS is not set to a positive whole number");
  }
  return seconds;
}

type CookieJar = Awaited<ReturnType<typeof cookies>>;
type Login = { sid: string; userId: string };

/** The login in `jfi_sid` (`<sid>.<user id>`), or null. */
function loginOf(value: string | undefined): Login | null {
  const [sid, userId, ...rest] = (value ?? "").split(".");
  return sid && userId && rest.length === 0 ? { sid, userId } : null;
}

/** A token cookie, `<sid>.<token>`, split; the token itself may contain dots (a JWT). */
function splitToken(value: string | undefined): { sid: string; token: string } | null {
  const dot = (value ?? "").indexOf(".");
  if (value === undefined || dot <= 0 || dot === value.length - 1) return null;
  return { sid: value.slice(0, dot), token: value.slice(dot + 1) };
}

/** Constant time, so a comparison never tells how much of a session id matched. */
function sameSid(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The raw token in cookie `name` when it belongs to `login`; null otherwise. */
function tokenOf(jar: CookieJar, name: string, login: Login): string | null {
  const bound = splitToken(jar.get(name)?.value);
  return bound !== null && sameSid(bound.sid, login.sid) ? bound.token : null;
}

function bearer(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" };
}

/** Stores both tokens under the login's `sid`. Only from a server action or a route handler. */
export async function setSession(tokens: AuthResponse, sid: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, `${sid}.${tokens.access_token}`, cookieOptions(tokens.expires_in));
  jar.set(
    REFRESH_COOKIE,
    `${sid}.${tokens.refresh_token}`,
    cookieOptions(refreshTokenTtlSeconds()),
  );
}

/** A login: a new session id, the marker and both tokens. Only from an action or a route. */
export async function startSession(tokens: AuthResponse): Promise<void> {
  const sid = crypto.randomUUID();
  (await cookies()).set(
    SESSION_COOKIE,
    `${sid}.${tokens.user.id}`,
    cookieOptions(refreshTokenTtlSeconds()),
  );
  await setSession(tokens, sid);
}

/** Removes every session cookie. Only callable from a server action or a route handler. */
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, REFRESHED_COOKIE, SESSION_COOKIE]) {
    jar.delete({ name, path: PANEL_PATH });
  }
}

/**
 * True for a request from this site: Sec-Fetch-Site same-origin or none (typed in the address
 * bar), or absent (an older browser). Shared by both session routes so they cannot drift.
 */
export function fromThisSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** Revokes the session's refresh token on the API, best effort: it never throws. */
export async function revoke(refreshToken: string): Promise<void> {
  try {
    await apiPost("/v1/auth/logout", { refresh_token: refreshToken });
  } catch {
    // The cookies are cleared either way; an unrevoked token expires on its own.
  }
}

async function currentUser(accessToken: string): Promise<User | null> {
  try {
    return await apiGet("/v1/auth/me", bearer(accessToken));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * The signed-in staff member, for server components. Redirects when there is no valid staff
 * session: to the one-time refresh when the login's access token is missing or refused, else
 * to the session end (no login, another login's token, another user, not staff). Cached per
 * request, so the layout and the page share one `/me` call.
 */
export const requireStaff = cache(async (): Promise<User> => {
  const jar = await cookies();
  const login = loginOf(jar.get(SESSION_COOKIE)?.value);
  if (login === null) redirect(END_PATH); // tokens without a login are no session
  const accessToken = tokenOf(jar, ACCESS_COOKIE, login);
  if (jar.get(ACCESS_COOKIE) && accessToken === null) redirect(END_PATH); // another login's
  const user = accessToken ? await currentUser(accessToken) : null;
  if (user !== null) {
    // Another user than the login's, or the role changed: no panel any more.
    if (user.id === login.userId && isStaff(user)) return user;
    redirect(END_PATH);
  }
  if (tokenOf(jar, REFRESH_COOKIE, login) && !jar.get(REFRESHED_COOKIE)) redirect(REFRESH_PATH);
  redirect(END_PATH);
});

/**
 * Route handler side of the refresh: one `POST /v1/auth/refresh`, then both cookies rotate.
 * Returns where to go next: the panel on success, the login otherwise (session cleared). With
 * no refresh cookie it clears nothing: there is nothing to clear. A refresh token of another
 * login (or none) goes to the session end. The new tokens keep the login's sid; the session
 * marker is never written here.
 */
export async function refreshStaffSession(): Promise<string> {
  const jar = await cookies();
  if (!jar.get(REFRESH_COOKIE)) return LOGIN_PATH;
  const login = loginOf(jar.get(SESSION_COOKIE)?.value);
  const refreshToken = login && tokenOf(jar, REFRESH_COOKIE, login);
  if (!login || !refreshToken) return END_PATH;
  let tokens: AuthResponse;
  try {
    tokens = await apiPost("/v1/auth/refresh", { refresh_token: refreshToken });
  } catch {
    await clearSession();
    return LOGIN_PATH;
  }
  if (!isStaff(tokens.user) || tokens.user.id !== login.userId) {
    await revoke(tokens.refresh_token);
    await clearSession();
    return LOGIN_PATH;
  }
  await setSession(tokens, login.sid);
  jar.set(REFRESHED_COOKIE, "1", cookieOptions(Math.max(1, tokens.expires_in - 1)));
  return PANEL_PATH;
}

/**
 * Ends the session: clears every cookie first, then revokes the refresh token, best effort and
 * bounded by API_TIMEOUT_MS, so the API can never hold or skip the local sign-out.
 */
export async function endSession(): Promise<void> {
  const refreshToken = splitToken((await cookies()).get(REFRESH_COOKIE)?.value)?.token;
  await clearSession();
  if (refreshToken) await revoke(refreshToken); // whichever login's it is: revoke it
}
