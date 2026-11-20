import type { ReactNode } from "react";

import { ErrorCopyProvider } from "@/features/site/error-copy";
import { siteErrorCopy } from "@/features/site/error-copy-server";
import { SITE_PAGE } from "@/features/site/font";
import { getT } from "@/i18n/server";

/**
 * The layout of the landing page (#85) and the pages beside it, in English and Spanish: the
 * site's font, and the error screen's words in both languages (its path picks one: #462).
 */
export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const [en, es] = await Promise.all([getT("en"), getT("es")]);
  return (
    <div className={SITE_PAGE}>
      <ErrorCopyProvider copy={{ en: siteErrorCopy(en, "en"), es: siteErrorCopy(es, "es") }}>
        {children}
      </ErrorCopyProvider>
    </div>
  );
}
