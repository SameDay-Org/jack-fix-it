import type { QueryClient } from "@tanstack/react-query";

import { ApiError, apiGet, apiPost, NetworkError } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { newQueryClient } from "../../pro-jobs/__tests__/helpers";
import { REQUEST_ID } from "../../quotes/__tests__/helpers";
import { confirmJob, customerJobQueryOptions, isJobDenied } from "../api";
import type { CustomerJob } from "../phase";

import { confirmedJob, customerJob } from "./helpers";

jest.mock("@/api", () => jest.requireActual("../../pro-jobs/__tests__/helpers").apiMock());

const OTHER_REQUEST = "6f1c2a40-0000-4000-8000-000000000999";
const GONE = new ApiError(404, "not_found");
const FORBIDDEN = new ApiError(403, "forbidden");

const session = () =>
  jest.requireMock<{ mockSession: { generation: number } }>("@/api").mockSession;
const get = () => jest.mocked(apiGet) as unknown as jest.Mock<Promise<unknown>>;
const post = () => jest.mocked(apiPost) as unknown as jest.Mock<Promise<unknown>>;

/** Reads the job once, as the screen or the banner would; a failure is the caller's to check. */
const read = (client: QueryClient, requestId = REQUEST_ID) =>
  client.fetchQuery(customerJobQueryOptions(requestId, session().generation)).catch(() => null);

/** What a sign-out does to the cache and the session (`beginSignOut`). */
function signOut(client: QueryClient) {
  session().generation += 1;
  client.clear();
}

beforeEach(() => {
  session().generation = 1;
  get().mockReset();
  post().mockReset();
});

describe("the job refused to this session (#347 round 1)", () => {
  it.each([
    ["gone (404)", GONE],
    ["refused (403)", FORBIDDEN],
  ])("a read %s records it for that request and session only", async (_name, refusal) => {
    const client = newQueryClient();
    get().mockRejectedValue(refusal);

    await read(client);

    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(true);
    expect(isJobDenied(client, OTHER_REQUEST, 1)).toBe(false);
    expect(isJobDenied(client, REQUEST_ID, 2)).toBe(false);
  });

  it("offline or a server error keeps it; a read that answers the job lifts it", async () => {
    const client = newQueryClient();
    get().mockRejectedValueOnce(GONE);
    await read(client);

    get().mockRejectedValueOnce(new NetworkError(false));
    await read(client);
    get().mockRejectedValueOnce(new ApiError(500, "internal_error"));
    await read(client);
    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(true);

    get().mockResolvedValueOnce(customerJob());
    await read(client);
    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(false);
  });

  it("another request answering lifts nothing", async () => {
    const client = newQueryClient();
    get().mockRejectedValueOnce(GONE).mockResolvedValueOnce(customerJob());

    await read(client);
    await read(client, OTHER_REQUEST);

    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(true);
  });

  it("a sign-out takes it, and the next session starts with none", async () => {
    const client = newQueryClient();
    get().mockRejectedValue(GONE);
    await read(client);

    signOut(client);

    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(false);
    expect(isJobDenied(client, REQUEST_ID, 2)).toBe(false);
  });

  it("a refusal landing after the sign-out records nothing", async () => {
    const client = newQueryClient();
    const held = deferred<CustomerJob>();
    get().mockReturnValue(held.promise);
    const pending = read(client);

    signOut(client);
    held.reject(GONE);
    await pending;

    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(false);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it.each([
    ["gone (404)", GONE],
    ["refused (403)", FORBIDDEN],
  ])("a confirmation %s records it; a confirmation answered lifts it", async (_name, refusal) => {
    const client = newQueryClient();
    post().mockRejectedValueOnce(refusal);
    await expect(confirmJob(client, REQUEST_ID, 1)).rejects.toBe(refusal);
    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(true);

    post().mockResolvedValueOnce(confirmedJob());
    await confirmJob(client, REQUEST_ID, 1);
    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(false);
  });

  it("a confirmation refused after a sign-out records nothing", async () => {
    const client = newQueryClient();
    const held = deferred<CustomerJob>();
    post().mockReturnValue(held.promise);
    const pending = confirmJob(client, REQUEST_ID, 1);

    session().generation = 2;
    held.reject(GONE);
    await expect(pending).rejects.toBe(GONE);

    expect(isJobDenied(client, REQUEST_ID, 1)).toBe(false);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
