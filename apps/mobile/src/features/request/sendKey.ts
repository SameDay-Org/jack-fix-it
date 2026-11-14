import { uuid } from "expo";

import { requestDraftStore } from "./requestDraft";
import type { RequestCreate } from "./send";

/** The shape the API takes for an Idempotency-Key (a UUID); anything else is a 422. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A first try and one more: a generator that fails twice will not recover on a third. */
const MINT_TRIES = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The body as one string, its keys sorted at every level: two bodies are the same request exactly
 * when their strings are equal, however they were put together. It holds what the customer wrote,
 * so it stays in memory with the draft: never logged, never hashed into anything that leaves.
 */
export function bodyFingerprint(body: RequestCreate): string {
  return JSON.stringify(body, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
}

/** A new key, checked against the API's shape before it can go out; null if none comes. */
function mintKey(): string | null {
  for (let attempt = 0; attempt < MINT_TRIES; attempt += 1) {
    try {
      const key = uuid.v4();
      if (UUID_SHAPE.test(key)) return key;
    } catch {
      // The native generator failed: one more try, then the send fails as a plain "try again".
    }
  }
  return null;
}

/**
 * The key to send `body` with (#388): the one this exact body went with before, so a retry of the
 * same request (after a timeout, the network, Try again, or an edit undone) can only answer the
 * request it made. A body never sent takes a new key: the server refuses an old key with a new
 * body. Null when no valid key could be made.
 */
export function sendKeyFor(body: RequestCreate): string | null {
  const fingerprint = bodyFingerprint(body);
  const keys = requestDraftStore.getState().sendKeys;
  const held = keys[fingerprint];
  if (held !== undefined) return held;
  const key = mintKey();
  if (key !== null) requestDraftStore.setState({ sendKeys: { ...keys, [fingerprint]: key } });
  return key;
}

/** Whether this exact body went out before with a key the draft still holds. */
export const holdsSendKey = (body: RequestCreate): boolean =>
  requestDraftStore.getState().sendKeys[bodyFingerprint(body)] !== undefined;

/**
 * Lets go of `key` while the draft holds it: its request exists (201, or 200 for a retry), or the
 * server holds it for another body (409). The next send of that body takes a new one. A key the
 * draft does not hold (another draft's) is left alone, and so are the draft's other keys.
 */
export function releaseSendKey(key: string): void {
  const keys = requestDraftStore.getState().sendKeys;
  const kept = Object.entries(keys).filter(([, held]) => held !== key);
  if (kept.length < Object.keys(keys).length) {
    requestDraftStore.setState({ sendKeys: Object.fromEntries(kept) });
  }
}
