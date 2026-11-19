import { ImageResponse } from "next/og";

import type { Locale } from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

/** The size social networks show a link card at. */
export const OG_SIZE = { width: 1200, height: 630 };

const CATALOGS = { en, es } as const;

/** The card's description for screen readers, in each language: the landing's, or another page's. */
export function ogAlt(locale: Locale, page: "landing" | "forPros" = "landing"): string {
  return CATALOGS[locale][page].meta.ogAlt;
}

// The brand tokens (globals.css): the image is drawn without the site's CSS.
const NAVY = "#01172E";
const LIME = "#5EB72B";
const WHITE = "#FFFFFF";

/**
 * The landing's Open Graph card (#85), drawn when the site is built: the wordmark and the
 * tagline on navy, in the page's language; another public page (#88) passes its own line. No
 * photo, no external service, no font download (the image renderer's own font).
 */
export function landingOgImage(locale: Locale, line?: string): ImageResponse {
  const { brand } = CATALOGS[locale];
  const [first, ...rest] = brand.name.split(" ");
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 28,
        padding: "0 96px",
        background: NAVY,
        color: WHITE,
      }}
    >
      <div style={{ display: "flex", width: 72, height: 12, borderRadius: 6, background: LIME }} />
      <div style={{ display: "flex", fontSize: 96, fontWeight: 800, letterSpacing: -2 }}>
        {first}
        <span style={{ color: LIME, marginLeft: 24 }}>{rest.join(" ")}</span>
      </div>
      <div style={{ display: "flex", fontSize: 48, maxWidth: 900 }}>{line ?? brand.tagline}</div>
    </div>,
    OG_SIZE,
  );
}
