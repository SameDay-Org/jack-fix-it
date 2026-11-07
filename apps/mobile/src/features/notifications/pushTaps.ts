import { sessionGeneration } from "@/api";

/**
 * A tapped push waiting for the signed-in app: its `data.url` as it came, and the session
 * generation it was tapped in. It opens only in that generation: a sign-in after the tap (from
 * signed out, or into another account) or a sign-out moves the generation, and the push is then
 * dropped, never opened for whoever is signed in now. A restore at launch keeps the generation, so
 * a push that launched the app opens once the stored session is back.
 */
export type PendingPushTap = { url: unknown; generation: number };

let pending: PendingPushTap | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

/** Records a tap; a newer tap replaces one that has not opened yet. */
export function receivePushTap(url: unknown): void {
  pending = { url, generation: sessionGeneration() };
  emit();
}

/** Hands the waiting tap over once: the next read finds none. */
export function takePushTap(): PendingPushTap | null {
  const tap = pending;
  if (tap === null) return null;
  pending = null;
  emit();
  return tap;
}

export const peekPushTap = (): PendingPushTap | null => pending;

export function subscribePushTaps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
