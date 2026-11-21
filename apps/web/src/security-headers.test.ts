import { describe, expect, it } from "vitest";

import nextConfig, { SECURITY_HEADERS } from "../next.config";

describe("the response headers (pre-QA sweep)", () => {
  it("forbid framing and MIME sniffing and trim the Referer on every path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const everywhere = rules.find((rule) => rule.source === "/:path*");

    expect(everywhere?.headers).toEqual(SECURITY_HEADERS);
    expect(Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]))).toEqual({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      // Web QA pass 2: the features the site never uses, and HTTPS kept for a year.
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()",
      "Strict-Transport-Security": "max-age=31536000",
    });
    // The panel stays out of every cache and sends no Referer; its rules come after the global
    // one, so its Referrer-Policy wins (the last match for a key does).
    const order = rules.map((rule) => rule.source);
    expect(order.indexOf("/:path*")).toBeLessThan(order.indexOf("/admin/:path*"));
    for (const source of ["/admin", "/admin/:path*"]) {
      expect(rules.find((rule) => rule.source === source)?.headers).toEqual([
        { key: "Cache-Control", value: "no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ]);
    }
  });
});
