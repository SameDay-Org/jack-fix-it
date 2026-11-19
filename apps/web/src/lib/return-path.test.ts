import { describe, expect, it } from "vitest";

import { PATH_HEADER, RETURN_PARAM, safeReturnPath, withReturn } from "./return-path";
import { END_PATH, LOGIN_PATH, PANEL_PATH, REFRESH_PATH } from "./session";

describe("safeReturnPath (#464)", () => {
  // Each one either leaves the site, is read differently by a browser or a decoder, or loops
  // back into the sign-in: all are ignored.
  it.each([
    "//evil.example",
    "//evil.example/admin",
    "https://evil.example",
    "https://evil.example/admin",
    "http:/evil.example/admin",
    "https:evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/admin\\..\\..\\evil.example",
    "/%5Cevil.example",
    "/%5cevil.example",
    "%2F%2Fevil.example",
    "/%2F%2Fevil.example",
    "/%2f%2fevil.example",
    "/admin/%2F%2Fevil.example",
    "%252F%252Fevil.example",
    "/admin//evil.example",
    "/admin/..//evil.example",
    "/admin/../../evil.example",
    "/admin/./queue",
    "/admin/%2e%2e/%2e%2e/evil.example",
    "/admin@evil.example",
    "/admin.evil.example",
    "/administrator",
    "/es/app",
    "/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    " /admin",
    "/admin ",
    "/admin\t/queue",
    "/admin%09",
    "/admin%0d%0aLocation:%20https://evil.example",
    "/admin/queue\n",
    // In the query the parser rewrites these silently ("\\" to %5C, tab and newline dropped), and
    // only the path is compared after parsing: the character guard is what refuses them (#479 r1).
    "/admin?x=\\foo",
    "/admin?x=a\tb",
    "/admin?x=a\nb",
    "/admin/login",
    "/admin/login?next=/admin",
    "/admin/logout",
    "/admin/session/end",
    "/admin/session/refresh?next=/admin",
    `/admin/${"a".repeat(600)}`,
    "",
  ])("ignores %j", (probe) => {
    expect(safeReturnPath(probe)).toBeNull();
  });

  it("ignores what is not a string", () => {
    for (const value of [null, undefined, 42, ["/admin"], new File([], "x")]) {
      expect(safeReturnPath(value)).toBeNull();
    }
  });

  it.each([
    ["/admin", "/admin"],
    ["/admin/queue", "/admin/queue"],
    ["/admin/queue?tab=urgent", "/admin/queue?tab=urgent"],
    [
      "/admin/disputes/6b3c0e1d-1111-4222-8333-944455556666",
      "/admin/disputes/6b3c0e1d-1111-4222-8333-944455556666",
    ],
    ["/admin/support?status=all#ticket", "/admin/support?status=all"],
    ["/admin/queue?tab=urgent&_rsc=1x2y", "/admin/queue?tab=urgent"],
    ["/admin/loginx", "/admin/loginx"],
  ])("keeps the panel path %j", (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it("leaves the sign-in and session routes out by the same names session.ts uses", () => {
    expect(PANEL_PATH).toBe("/admin");
    for (const route of [LOGIN_PATH, REFRESH_PATH, END_PATH, `${PANEL_PATH}/logout`]) {
      expect(safeReturnPath(route), route).toBeNull();
    }
  });
});

describe("withReturn", () => {
  it("puts the return address in the query, encoded, and nothing without one", () => {
    expect(withReturn(LOGIN_PATH, "/admin/queue?tab=urgent")).toBe(
      `/admin/login?${RETURN_PARAM}=%2Fadmin%2Fqueue%3Ftab%3Durgent`,
    );
    expect(withReturn(LOGIN_PATH, null)).toBe(LOGIN_PATH);
    // What a route reads back is the same path.
    const url = new URL(withReturn(END_PATH, "/admin/queue?tab=urgent"), "http://x");
    expect(safeReturnPath(url.searchParams.get(RETURN_PARAM))).toBe("/admin/queue?tab=urgent");
    expect(PATH_HEADER).toBe("x-jfi-path");
  });
});
