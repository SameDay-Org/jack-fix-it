import type { NextConfig } from "next";

/** Sent with every page and file (pre-QA sweep, 2026-11-19). */
export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The mascot (#404) is a workspace package shipped as TypeScript source.
  transpilePackages: ["@jack/mascot"],
  images: {
    // Next's default widths plus 480: the showcase's phone screens (#403) are about 240 CSS px
    // wide on a phone, so a 2x display gets a 480 px file instead of the 640 px one.
    deviceSizes: [480, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  },
  // Every response: never framed by another site (clickjacking), no MIME sniffing, and only
  // the origin in a Referer sent to another site. The admin panel is per-user and staff-only:
  // never stored by a browser or a proxy (#80). Its server actions keep Next's default Origin
  // check (no serverActions.allowedOrigins).
  async headers() {
    // The panel: no-store, and no Referer at all (its file and photo routes say so too: a later
    // rule for the same key wins over the one for every path).
    const noStore = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ];
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/admin", headers: noStore },
      { source: "/admin/:path*", headers: noStore },
    ];
  },
};

export default nextConfig;
