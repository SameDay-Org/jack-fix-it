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
 * The key to send `body` with (#388). The draft's key while the body is the one it was taken for,
 * so a retry of the same request (after a timeout, the network, Try again) can only answer the
 * request it made. A new key once the body changed (an edit after a failed send): the server
 * refuses an old key with a new body. Null when no valid key could be made.
 */
export function sendKeyFor(body: RequestCreate): string | null {
  const fingerprint = bodyFingerprint(body);
  const held = requestDraftStore.getState().sendKey;
  if (held !== null && held.fingerprint === fingerprint) return held.key;
  const key = mintKey();
  requestDraftStore.setState({ sendKey: key === null ? null : { key, fingerprint } });
  return key;
}

/**
 * Lets go of `key` while the draft still holds it: its request exists (201, or 200 for a retry),
 * or the server holds it for another body (409). The next send takes a new one. A key the draft
 * no longer holds (a newer one, another draft's) is left alone.
 */
export function releaseSendKey(key: string): void {
  if (requestDraftStore.getState().sendKey?.key === key) {
    requestDraftStore.setState({ sendKey: null });
  }
}
