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
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { components } from "@jack/shared";

import { ApiError, apiGet, apiPost } from "./api";

export type User = components["schemas"]["UserOut"];
export type AuthResponse = components["schemas"]["AuthResponse"];

export const ACCESS_COOKIE = "jfi_at";
export const REFRESH_COOKIE = "jfi_rt";
// Set by a refresh for a minute: if the API still refuses the new token, the session ends
// instead of refreshing again, so a broken session never loops.
export const REFRESHED_COOKIE = "jfi_rf";
export const PANEL_PATH = "/admin";
export const LOGIN_PATH = "/admin/login";
export const REFRESH_PATH = "/admin/session/refresh";
export const END_PATH = "/admin/session/end";
const REFRESHED_MAX_AGE_SECONDS = 60;
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

function bearer(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" };
}

/** Stores both tokens. Only callable from a server action or a route handler. */
export async function setSession(tokens: AuthResponse): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.access_token, cookieOptions(tokens.expires_in));
  jar.set(REFRESH_COOKIE, tokens.refresh_token, cookieOptions(refreshTokenTtlSeconds()));
}

/** Removes every session cookie. Only callable from a server action or a route handler. */
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, REFRESHED_COOKIE]) {
    jar.delete({ name, path: PANEL_PATH });
  }
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
 * session: to the one-time refresh when the access token is missing or refused, else to the
 * session end. Cached per request, so the layout and the page share one `/me` call.
 */
export const requireStaff = cache(async (): Promise<User> => {
  const jar = await cookies();
  const accessToken = jar.get(ACCESS_COOKIE)?.value;
  const user = accessToken ? await currentUser(accessToken) : null;
  if (user !== null) {
    if (isStaff(user)) return user;
    redirect(END_PATH); // the role changed: no panel any more
  }
  if (jar.get(REFRESH_COOKIE)?.value && !jar.get(REFRESHED_COOKIE)) redirect(REFRESH_PATH);
  redirect(END_PATH);
});

/**
 * Route handler side of the refresh: one `POST /v1/auth/refresh`, then both cookies rotate.
 * Returns where to go next: the panel on success, the login otherwise (session cleared).
 */
export async function refreshStaffSession(): Promise<string> {
  const jar = await cookies();
  const refreshToken = jar.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    await clearSession();
    return LOGIN_PATH;
  }
  let tokens: AuthResponse;
  try {
    tokens = await apiPost("/v1/auth/refresh", { refresh_token: refreshToken });
  } catch {
    await clearSession();
    return LOGIN_PATH;
  }
  if (!isStaff(tokens.user)) {
    await revoke(tokens.refresh_token);
    await clearSession();
    return LOGIN_PATH;
  }
  await setSession(tokens);
  jar.set(REFRESHED_COOKIE, "1", cookieOptions(REFRESHED_MAX_AGE_SECONDS));
  return PANEL_PATH;
}

/** Ends the session: revokes the refresh token (best effort) and clears every cookie. */
export async function endSession(): Promise<void> {
  const refreshToken = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (refreshToken) await revoke(refreshToken);
  await clearSession();
}
