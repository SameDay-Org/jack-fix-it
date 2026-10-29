import { onSignOut } from "@/api";

import type { CreatedRequest } from "./api";

type Sent = { userId: string; request: CreatedRequest };

// The request the flow just sent, for its confirmation: kept apart from the draft, which the flow
// forgets as it gives way to the confirmation. It belongs to the account that sent it and goes
// with that account's session.
let lastSent: Sent | null = null;

onSignOut(() => {
  lastSent = null;
});

export function rememberSent(request: CreatedRequest, userId: string): void {
  lastSent = { userId, request };
}

/**
 * The request this account sent from this session with this id, if it was the last one. Any other
 * id, or another account's send, is null: the caller reads the request from the API instead.
 */
export function sentRequest(
  id: string | undefined,
  userId: string | undefined,
): CreatedRequest | null {
  if (id === undefined || userId === undefined || lastSent === null) return null;
  return lastSent.userId === userId && lastSent.request.id === id ? lastSent.request : null;
}
