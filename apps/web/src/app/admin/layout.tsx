import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ErrorCopyProvider } from "@/features/site/error-copy";
import { panelErrorCopy } from "@/features/site/error-copy-server";
import { defaultLocale } from "@/i18n/config";
import { getT } from "@/i18n/server";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Every panel route. When the panel's own layout fails (the staff session could not be checked)
 * the staff member's language is unknown: the error screen speaks the panel's default one, as
 * the login does (#462).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const t = await getT(defaultLocale);
  return <ErrorCopyProvider copy={panelErrorCopy(t)}>{children}</ErrorCopyProvider>;
}
