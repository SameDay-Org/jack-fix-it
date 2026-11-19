import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The mascot (#404) is a workspace package shipped as TypeScript source.
  transpilePackages: ["@jack/mascot"],
  images: {
    // Next's default widths plus 480: the showcase's phone screens (#403) are about 240 CSS px
    // wide on a phone, so a 2x display gets a 480 px file instead of the 640 px one.
    deviceSizes: [480, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  },
  // The admin panel is per-user and staff-only: never stored by a browser or a proxy (#80).
  // Its server actions keep Next's default Origin check (no serverActions.allowedOrigins).
  // The web request flow (#86) holds what a visitor types: never stored either.
  async headers() {
    const noStore = [{ key: "Cache-Control", value: "no-store" }];
    return [
      { source: "/admin", headers: noStore },
      { source: "/admin/:path*", headers: noStore },
      { source: "/request", headers: noStore },
      { source: "/es/request", headers: noStore },
    ];
  },
};

export default nextConfig;
