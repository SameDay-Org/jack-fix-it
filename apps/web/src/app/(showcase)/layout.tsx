import localFont from "next/font/local";
import type { ReactNode } from "react";

// Plus Jakarta Sans, served from this site (license and source: features/showcase/fonts).
// The showcase pages are the only ones that load it: the brand's final font is still open.
// Its space is narrow, so the pages add a little room between words.
const showcaseFont = localFont({
  src: "../../features/showcase/fonts/plus-jakarta-sans-latin-wght-normal.woff2",
  weight: "200 800",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

// The header is sticky (4rem): the document keeps 5rem of scroll padding while a showcase page
// is shown, so an anchor (a section, the skip link's target, "back to the top") and a control
// that gets keyboard focus stop below the header instead of under it.
const SCROLL_PADDING = "[html:has(&)]:scroll-pt-20";

/** The layout of the product showcase (#403) and its legal placeholders: its own font. */
export default function ShowcaseLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${showcaseFont.className} ${SCROLL_PADDING} [word-spacing:0.05em]`}>
      {children}
    </div>
  );
}
