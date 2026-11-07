import { ALLOWED_PUSH_PATHS, parsePushLink, PUSH_ID_PATTERN, pushRoute } from "../deepLinks";

// Node's fs and module resolution, typed here: the app's tsconfig carries no Node types.
const { readFileSync } = jest.requireActual<{
  readFileSync: (path: string, encoding: "utf8") => string;
}>("fs");
const resolveFile = (require as unknown as { resolve: (id: string) => string }).resolve;

// The API's allow-list, read from its source: the app's copy must say exactly the same.
const API_FILE = resolveFile("../../../../../api/app/modules/notifications/deep_links.py");
const source = readFileSync(API_FILE, "utf8");

// No call reaches the API here; the screens' query modules only need it to load.
jest.mock("@/api", () => ({ onSignOut: () => () => undefined }));

const ID = "0b9e5f8e-6a3c-4c1e-9d2f-1a2b3c4d5e6f";

describe("the app's copy of the API's ALLOWED_DEEP_LINKS", () => {
  it("lists the same paths, in the same order", () => {
    const block = /ALLOWED_DEEP_LINKS: Final = \(([\s\S]*?)\n\)/.exec(source)?.[1];
    expect(block).toBeDefined();
    const apiPaths = [...(block ?? "").matchAll(/re\.compile\(rf"([^"]*)"\)/g)].map(([, path]) =>
      path.replaceAll("{_UUID}", "{id}"),
    );
    expect(apiPaths.length).toBeGreaterThan(0);
    expect(apiPaths).toEqual([...ALLOWED_PUSH_PATHS]);
  });

  it("reads ids with the same pattern", () => {
    expect(/_UUID: Final = r"([^"]*)"/.exec(source)?.[1]).toBe(PUSH_ID_PATTERN);
  });

  it("matches whole paths, like the API's fullmatch", () => {
    expect(source).toMatch(/pattern\.fullmatch\(path\)/);
  });
});

describe("parsePushLink", () => {
  it.each([
    [`/requests/${ID}`, "/requests/{id}"],
    [`/requests/${ID}/job`, "/requests/{id}/job"],
    [`/jobs/${ID}`, "/jobs/{id}"],
    [`/quotes/${ID}`, "/quotes/{id}"],
    [`/opportunities/${ID}`, "/opportunities/{id}"],
  ])("reads %s as %s", (url, path) => {
    expect(parsePushLink(url)).toEqual({ path, id: ID });
  });

  it.each([
    "/settings",
    `/requests/${ID}/`,
    `requests/${ID}`,
    `//requests/${ID}`,
    `jackfixit://jobs/${ID}`,
    `https://example.com/jobs/${ID}`,
    `/jobs/${ID}?x=1`,
    `/jobs/${ID}#x`,
    `/jobs/${ID.toUpperCase()}`,
    `/jobs/${ID.slice(1)}`,
    `/jobs/${ID}/check-in`,
    `/jobs/%2E%2E/${ID}`,
    "",
    null,
    42,
    { url: `/jobs/${ID}` },
  ])("refuses %p", (url) => {
    expect(parsePushLink(url)).toBeNull();
  });
});

describe("pushRoute", () => {
  it("opens the customer's paths for a customer and the pro's for a pro", () => {
    expect(pushRoute(parsePushLink(`/requests/${ID}`), "customer")?.href(ID)).toEqual({
      pathname: "/requests/[id]",
      params: { id: ID },
    });
    expect(pushRoute(parsePushLink(`/requests/${ID}/job`), "customer")?.href(ID)).toEqual({
      pathname: "/requests/[id]/job",
      params: { id: ID },
    });
    expect(pushRoute(parsePushLink(`/jobs/${ID}`), "pro")?.href(ID)).toEqual({
      pathname: "/jobs/[id]",
      params: { id: ID },
    });
    expect(pushRoute(parsePushLink(`/opportunities/${ID}`), "pro")?.href(ID)).toEqual({
      pathname: "/opportunities/[id]",
      params: { id: ID },
    });
  });

  it("opens nothing for the other role, a path with no screen, or no link", () => {
    expect(pushRoute(parsePushLink(`/jobs/${ID}`), "customer")).toBeNull();
    expect(pushRoute(parsePushLink(`/requests/${ID}`), "pro")).toBeNull();
    expect(pushRoute(parsePushLink(`/quotes/${ID}`), "customer")).toBeNull();
    expect(pushRoute(parsePushLink(`/quotes/${ID}`), "pro")).toBeNull();
    expect(pushRoute(null, "customer")).toBeNull();
  });
});
