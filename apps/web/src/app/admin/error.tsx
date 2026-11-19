"use client";

import { ErrorScreen } from "@/features/site/error-screen";

/**
 * The whole panel, when its layout could not check the staff session: the API is down,
 * failing or limiting the web server. The account is not signed out; the page offers to try
 * again (#462).
 * The error itself is never shown (the server logs keep its digest).
 */
export default function AdminError({ retry }: { retry: () => void }) {
  return <ErrorScreen variant="panel" retry={retry} />;
}
