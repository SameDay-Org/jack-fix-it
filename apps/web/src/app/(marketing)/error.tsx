"use client";

import { ErrorScreen } from "@/features/site/error-screen";

/**
 * A public page that could not be made, such as a service page while the API is
 * unreachable (#87, D4): calm words in the page's language, a retry, the way home (#462).
 * The error itself is never shown (the server logs keep its digest).
 */
export default function MarketingError({ retry }: { retry: () => void }) {
  return <ErrorScreen variant="site" retry={retry} />;
}
