import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The admin panel is per-user and staff-only: never stored by a browser or a proxy (#80).
  // Its server actions keep Next's default Origin check (no serverActions.allowedOrigins).
  async headers() {
    const noStore = [{ key: "Cache-Control", value: "no-store" }];
    return [
      { source: "/admin", headers: noStore },
      { source: "/admin/:path*", headers: noStore },
    ];
  },
};

export default nextConfig;
