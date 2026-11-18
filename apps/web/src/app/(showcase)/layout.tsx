import type { ReactNode } from "react";

import { SITE_PAGE } from "@/features/site/font";

/** The layout of the product showcase (#403) and its legal placeholders: the site's font. */
export default function ShowcaseLayout({ children }: { children: ReactNode }) {
  return <div className={SITE_PAGE}>{children}</div>;
}
