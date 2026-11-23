import type { Href } from "expo-router";

/**
 * The receipt's route (#62), apart from the API client: the job screens link to it without
 * loading the API layer (`@/api` reads its configuration when loaded).
 */
export const receiptHref = (requestId: string): Href => ({
  pathname: "/requests/[id]/receipt",
  params: { id: requestId },
});
