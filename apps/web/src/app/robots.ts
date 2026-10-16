import type { MetadataRoute } from "next";

// Read at request time so each Railway environment answers for itself.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  // Only production is indexable; staging and local builds are not.
  if (process.env.APP_ENV !== "production") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return { rules: { userAgent: "*", allow: "/", disallow: "/admin" } };
}
