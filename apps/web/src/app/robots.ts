import type { MetadataRoute } from "next";

import { siteUrl } from "@/features/site/routes";

// Read at request time so each Railway environment answers for itself.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  // Only production is indexable; staging and local builds are not.
  if (process.env.APP_ENV !== "production") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const base = siteUrl();
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/admin" },
    ...(base ? { sitemap: new URL("/sitemap.xml", base).href } : {}),
  };
}
