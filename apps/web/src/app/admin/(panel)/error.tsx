"use client";

import { ErrorScreen } from "@/features/site/error-screen";

/**
 * One panel page that could not be made, inside the panel's frame, in the staff member's
 * language: a retry and the way back to the panel's home (#462).
 * The error itself is never shown (the server logs keep its digest).
 */
export default function PanelPageError({ retry }: { retry: () => void }) {
  return <ErrorScreen variant="panelPage" retry={retry} />;
}
