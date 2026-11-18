import localFont from "next/font/local";

// Plus Jakarta Sans, served from this site (license and source: ./fonts), for the public pages
// (the landing and the showcase); the staff panel keeps the system font. Its space is narrow,
// so the pages add a little room between words.
export const siteFont = localFont({
  src: "./fonts/plus-jakarta-sans-latin-wght-normal.woff2",
  weight: "200 800",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

// The header is sticky (4rem): the document keeps 5rem of scroll padding while a public page
// is shown, so an anchor (a section, the skip link's target) and a control that gets keyboard
// focus stop below the header instead of under it.
export const SITE_PAGE = `${siteFont.className} [html:has(&)]:scroll-pt-20 [word-spacing:0.05em]`;
