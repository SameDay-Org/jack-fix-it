import type { CreatedRequest } from "./api";

// The request the flow just sent, for its confirmation: kept apart from the draft, which the flow
// forgets as it gives way to the confirmation.
let lastSent: CreatedRequest | null = null;

export function rememberSent(request: CreatedRequest): void {
  lastSent = request;
}

/** The request sent from this app session with this id, if it was the last one. */
export function sentRequest(id: string | undefined): CreatedRequest | null {
  return id !== undefined && lastSent?.id === id ? lastSent : null;
}
