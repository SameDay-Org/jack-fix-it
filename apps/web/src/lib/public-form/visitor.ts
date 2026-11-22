import { isIP } from "node:net";

// The visitor's address for the API's per-address limits (#86 spec §3, #409). The web server
// calls the API, so without this every visitor would count as the web server. The API trusts
// the address only next to the web service's key (#517: app/web_service.py); without the key it
// ignores both headers.

/** The header the API reads the visitor's address from, and the one carrying the key. */
export const VISITOR_IP_HEADER = "x-jfi-client-ip";
export const WEB_KEY_HEADER = "x-jfi-web-key";

/**
 * The visitor's address as the edge saw it: ONE header, named by CLIENT_IP_HEADER (which one
 * Railway's edge sets reliably is checked on staging before a public form goes on), and only
 * its last value, the one the edge itself added; whatever a client put before it is ignored.
 * Null without the setting or without a valid address: then nothing is forwarded.
 */
export function visitorIp(
  request: Headers,
  headerName: string | undefined = process.env.CLIENT_IP_HEADER,
): string | null {
  if (!headerName) return null;
  const value = request.get(headerName);
  const last = value?.split(",").at(-1)?.trim() ?? "";
  return isIP(last) ? last : null;
}

/** What every public call to the API carries: the web service's key and the visitor's address. */
export function forwardingHeaders(request: Headers): Headers {
  const headers = new Headers();
  const key = process.env.WEB_SERVICE_KEY;
  if (key) headers.set(WEB_KEY_HEADER, key);
  const ip = visitorIp(request);
  if (ip) headers.set(VISITOR_IP_HEADER, ip);
  return headers;
}
