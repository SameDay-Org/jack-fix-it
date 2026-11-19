"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { Locale } from "@/i18n/config";

import { localeOfPath } from "./routes";

/** An error screen's words: its heading, the line under it, and the two ways out. */
export type ErrorCopy = {
  title: string;
  body: string;
  retry: string;
  home: string;
  /** Where "home" leads: the site's home in the page's language, or the panel's. */
  homeHref: string;
};

/** One language's words (the panel: the staff member's), or both (the site: the path decides). */
type Copy = ErrorCopy | Record<Locale, ErrorCopy>;

const ErrorCopyContext = createContext<Copy | null>(null);

/**
 * Gives the error boundaries below it their words (#462). An error boundary is a client
 * component and cannot read the catalogs itself (that would send them to every browser), so
 * the server layout above passes the few strings it needs, from the catalogs.
 */
export function ErrorCopyProvider({ copy, children }: { copy: Copy; children: ReactNode }) {
  return <ErrorCopyContext value={copy}>{children}</ErrorCopyContext>;
}

/** The words for this page, and their language. */
export function useErrorCopy(pathname: string): { copy: ErrorCopy; locale: Locale | null } {
  const copy = useContext(ErrorCopyContext);
  if (copy === null) throw new Error("An error screen needs an ErrorCopyProvider above it.");
  if ("title" in copy) return { copy, locale: null };
  const locale = localeOfPath(pathname);
  return { copy: copy[locale], locale };
}
