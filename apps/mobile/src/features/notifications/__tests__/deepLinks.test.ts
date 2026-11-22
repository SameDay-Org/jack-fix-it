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
    // `rf"..."` for a path with an id, `r"..."` for one without (Home, #338).
    const apiPaths = [...(block ?? "").matchAll(/re\.compile\(rf?"([^"]*)"\)/g)].map(([, path]) =>
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
    [`/jobs/${ID}/chat`, "/jobs/{id}/chat"],
    [`/requests/${ID}/job/chat`, "/requests/{id}/job/chat"],
  ])("reads %s as %s", (url, path) => {
    expect(parsePushLink(url)).toEqual({ path, id: ID });
  });

  it("reads / as Home, which names no id (#338)", () => {
    expect(parsePushLink("/")).toEqual({ path: "/", id: null });
  });

  it.each([
    "/settings",
    "//",
    " /",
    "/?x=1",
    "/#top",
    "/%2F",
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
    `/jobs/${ID}/chat/`,
    `/requests/${ID}/chat`,
    `/jobs/${ID}/chat?request=${ID}`,
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

  it("opens each side's chat of the job (#73): the pro's by the job, the customer's by the request", () => {
    const JOB = "7f3c2b1a-0e9d-4c8b-a7f6-5e4d3c2b1a09";
    expect(pushRoute(parsePushLink(`/jobs/${ID}/chat`), "pro")?.href(ID)).toEqual({
      pathname: "/jobs/[id]/chat",
      params: { id: ID },
    });
    const customer = pushRoute(parsePushLink(`/requests/${ID}/job/chat`), "customer");
    // The job read answered: the chat of its job, with the request the chat reads the pro from.
    expect(customer?.href(ID, { id: JOB, status: "scheduled" })).toEqual({
      pathname: "/jobs/[id]/chat",
      params: { id: JOB, request: ID },
    });
    expect(customer?.path?.(ID, { id: JOB })).toBe(`/jobs/${JOB}/chat`);
    // No answer: the job screen of the request, which shows its own error and its chat entry.
    expect(customer?.href(ID, undefined)).toEqual({
      pathname: "/requests/[id]/job",
      params: { id: ID },
    });
    expect(customer?.path?.(ID, undefined)).toBe(`/requests/${ID}/job`);
    expect(pushRoute(parsePushLink(`/jobs/${ID}/chat`), "customer")).toBeNull();
    expect(pushRoute(parsePushLink(`/requests/${ID}/job/chat`), "pro")).toBeNull();
  });

  it("opens nothing for the other role, a path with no screen, or no link", () => {
    expect(pushRoute(parsePushLink(`/jobs/${ID}`), "customer")).toBeNull();
    expect(pushRoute(parsePushLink(`/requests/${ID}`), "pro")).toBeNull();
    expect(pushRoute(parsePushLink(`/quotes/${ID}`), "customer")).toBeNull();
    expect(pushRoute(parsePushLink(`/quotes/${ID}`), "pro")).toBeNull();
    expect(pushRoute(null, "customer")).toBeNull();
  });

  it("opens nothing over the current screen for Home: the tap goes back to it", () => {
    expect(pushRoute(parsePushLink("/"), "customer")).toBeNull();
    expect(pushRoute(parsePushLink("/"), "pro")).toBeNull();
  });
});
