import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// A public form's signed token (the web request flow #86 and the app-launch interest list
// #409): minted on this server, sent back with the form. It proves the form came from this
// site and for which form (its purpose), refuses a send too soon after the form was given (a
// script, not a person) or too long after (a page left open: a fresh one is given), and its
// nonce can be the API's Idempotency-Key. Its secret never leaves the server. No cookie,
// nothing stored.

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_LENGTH = 512;

/** Which form a token is for: one form's token is refused by every other. */
export type FormPurpose = "request" | "interest";

type Payload = { v: number; p: FormPurpose; iat: number; nonce: string };

export type TokenCheck =
  { ok: true; nonce: string } | { ok: false; reason: "invalid" | "too_fast" | "expired" };

/** How old a token must be to send, and may be at most, in seconds. */
export type FormTimings = { minSeconds: number; maxAgeSeconds: number };

function sign(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
 * A new token for `purpose`, issued `nowMs`. `ageSeconds` dates it back: a fresh token given for
 * an expired one is old enough to send at once (the person has been at it for a while).
 */
export function mintFormToken(
  secret: string,
  purpose: FormPurpose,
  nowMs = Date.now(),
  ageSeconds = 0,
): string {
  const payload: Payload = {
    v: VERSION,
    p: purpose,
    iat: Math.floor(nowMs / 1000) - ageSeconds,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret).toString("base64url")}`;
}

function payloadOf(body: string): Payload | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { v, p, iat, nonce } = value as Record<string, unknown>;
    if (
      v !== VERSION ||
      (p !== "request" && p !== "interest") ||
      !Number.isInteger(iat) ||
      typeof nonce !== "string" ||
      !UUID.test(nonce)
    ) {
      return null;
    }
    return { v, p, iat: iat as number, nonce };
  } catch {
    return null;
  }
}

/** Whether `token` is one this server signed for `purpose`, old enough but not too old now. */
export function checkFormToken(
  token: unknown,
  secret: string,
  purpose: FormPurpose,
  nowMs: number,
  timings: FormTimings,
): TokenCheck {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "invalid" };
  }
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return { ok: false, reason: "invalid" };
  const expected = sign(body, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid" };
  }
  const payload = payloadOf(body);
  if (!payload || payload.p !== purpose) return { ok: false, reason: "invalid" };
  const age = Math.floor(nowMs / 1000) - payload.iat;
  if (age < timings.minSeconds) return { ok: false, reason: "too_fast" };
  if (age > timings.maxAgeSeconds) return { ok: false, reason: "expired" };
  return { ok: true, nonce: payload.nonce };
}
