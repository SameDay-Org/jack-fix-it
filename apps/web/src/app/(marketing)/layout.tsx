import type { ReactNode } from "react";

import { SITE_PAGE } from "@/features/site/font";

/** The layout of the landing page (#85), in English and Spanish: the site's font. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <div className={SITE_PAGE}>{children}</div>;
}
