/**
 * The panel's return address (#464): the page a signed-out staff member asked for, carried as
 * `?next=` through the session routes and the sign-in form, so the sign-in ends where they
 * were going. Only a path of this site's panel is ever accepted. Anything else is ignored
 * (another host, a scheme, a backslash, an encoded slash or control character, a dot segment,
 * the sign-in and session routes themselves), so the parameter can never send anyone off the
 * site: no open redirect.
 */

/** The query parameter that carries the return address. */
export const RETURN_PARAM = "next";

/**
 * The request header the proxy (src/proxy.ts) sets on every panel request: the requested path
 * and query. The proxy always overwrites it, so a client cannot choose it; it is validated
 * here all the same.
 */
export const PATH_HEADER = "x-jfi-path";

/** The panel's root (lib/session.ts PANEL_PATH; return-path.test.ts keeps them equal). */
const PANEL = "/admin";

/** Where a return address may never lead: back into the sign-in (a loop) or a session route. */
const NOT_A_RETURN = ["/admin/login", "/admin/logout", "/admin/session"];

const MAX_LENGTH = 512;

/** A placeholder origin to resolve the path against: whatever leaves it is refused. */
const BASE = "http://panel.invalid";

/** Next's own query parameter on client navigations: never part of a return address. */
const NEXT_INTERNAL = ["_rsc"];

/**
 * The panel path in `raw`, normalized (path and query, no fragment), or null when `raw` is
 * not a plain path of this site's panel.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  // One leading slash and no second one anywhere ("//host"); no backslash (browsers read it
  // as a slash); no space or control character; nothing a decoder would turn into those.
  if (!raw.startsWith("/") || raw.includes("//") || /[\\\s\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  if (/%(2f|5c|[01][0-9a-f]|7f)/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const path = url.pathname;
  // The path as written, unchanged by normalization: no "." or ".." segments, no escapes.
  if (path !== raw.split(/[?#]/)[0]) return null;
  if (path !== PANEL && !path.startsWith(`${PANEL}/`)) return null;
  if (NOT_A_RETURN.some((route) => path === route || path.startsWith(`${route}/`))) return null;
  for (const name of NEXT_INTERNAL) url.searchParams.delete(name);
  return `${path}${url.search}`;
}

/** `path` with the return address in its query, when there is one. */
export function withReturn(path: string, returnPath: string | null): string {
  return returnPath === null ? path : `${path}?${RETURN_PARAM}=${encodeURIComponent(returnPath)}`;
}
