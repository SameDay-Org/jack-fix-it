import { QueryClient } from "@tanstack/react-query";

import {
  authResponse,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  settle,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { attachQueryClient, login, logout } from "../../../api/session";
import { denyOpportunity, isOpportunityDenied } from "../../pro-home/useOpportunities";
import { opportunityQueryKey, opportunityQueryOptions } from "../useOpportunity";
import { detail } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

// The detail query records a 404 as a denial from inside its query function, so the record must
// stay with the session and the query that asked (Vault round 3, B2).

const ID = "6f1c2a40-0000-4000-8000-000000000219";
const OTHER = "6f1c2a40-0000-4000-8000-000000000220";
const PASSWORD = "correct horse battery";
const DENIED_KEY = ["opportunities-denied"];

let client: QueryClient;
let fetchMock: FetchMock;

/** A 404 whose error body the test releases by hand; `reading` turns true once it is awaited. */
function heldNotFound() {
  const body = deferred<unknown>();
  const state = { reading: false };
  const response = errorResponse(404, "not_found");
  response.json = () => {
    state.reading = true;
    return body.promise;
  };
  return {
    response,
    isReading: () => state.reading,
    release: () => body.resolve({ error: { code: "not_found", message: "not_found" } }),
  };
}

async function untilReading(isReading: () => boolean): Promise<void> {
  for (let n = 0; n < 30 && !isReading(); n++) await settle();
  expect(isReading()).toBe(true);
}

beforeEach(async () => {
  fetchMock = installFetchMock();
  resetSecureStore();
  // gcTime Infinity: no garbage-collection timer, so Jest exits once the tests are done.
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  attachQueryClient(client);
  fetchMock.mockResolvedValue(jsonResponse(200, authResponse(1)));
  await login({ email: user.email, password: PASSWORD });
});

afterEach(() => client.clear());

it("a 404 records only the requested dispatch, and logout clears it synchronously", async () => {
  fetchMock.mockResolvedValue(errorResponse(404, "not_found"));
  await expect(client.fetchQuery(opportunityQueryOptions(ID))).rejects.toMatchObject({
    status: 404,
  });
  expect(isOpportunityDenied(client, ID)).toBe(true);
  expect(isOpportunityDenied(client, OTHER)).toBe(false);

  fetchMock.mockResolvedValue(jsonResponse(204));
  const out = logout();
  expect(client.getQueryData(DENIED_KEY)).toBeUndefined();
  await out;
});

it.each([503, 422, 403])(
  "a %s neither records a denial nor lifts another dispatch's",
  async (status) => {
    denyOpportunity(client, OTHER);
    fetchMock.mockResolvedValue(errorResponse(status, "unavailable"));
    await expect(client.fetchQuery(opportunityQueryOptions(ID))).rejects.toMatchObject({
      status,
    });
    expect(client.getQueryData(DENIED_KEY)).toEqual([OTHER]);
  },
);

it("a cancelled query's late 404 records no denial", async () => {
  const held = heldNotFound();
  fetchMock.mockResolvedValueOnce(held.response);
  const read = client.fetchQuery(opportunityQueryOptions(ID)).catch(() => undefined);
  await untilReading(held.isReading);

  await client.cancelQueries({ queryKey: opportunityQueryKey(ID), exact: true });
  held.release();
  await read;
  await settle();

  expect(isOpportunityDenied(client, ID)).toBe(false);
});

it.each([false, true])(
  "an old session's late 404 cannot record a denial after logout (refresh retry: %s)",
  async (retry) => {
    const held = heldNotFound();
    if (retry) {
      fetchMock.mockResolvedValueOnce(errorResponse(401, "invalid_token"));
      fetchMock.mockResolvedValueOnce(jsonResponse(200, authResponse(2)));
    }
    fetchMock.mockResolvedValueOnce(held.response);
    const read = client.fetchQuery(opportunityQueryOptions(ID)).catch(() => undefined);
    await untilReading(held.isReading);

    fetchMock.mockResolvedValue(jsonResponse(204));
    await logout();
    expect(client.getQueryData(DENIED_KEY)).toBeUndefined();
    held.release();
    await read;
    await settle();

    expect(client.getQueryData(DENIED_KEY)).toBeUndefined();
  },
);

it("account A's late refreshed 404 cannot deny account B's fresh authorized opportunity", async () => {
  const held = heldNotFound();
  fetchMock.mockResolvedValueOnce(errorResponse(401, "invalid_token"));
  fetchMock.mockResolvedValueOnce(jsonResponse(200, authResponse(2)));
  fetchMock.mockResolvedValueOnce(held.response);
  const oldRead = client.fetchQuery(opportunityQueryOptions(ID)).catch(() => undefined);
  await untilReading(held.isReading);

  fetchMock.mockResolvedValue(jsonResponse(204));
  await logout();
  const b = {
    ...authResponse(3),
    user: { ...user, id: OTHER, email: "pro-b@example.com", role: "pro" as const },
  };
  fetchMock.mockResolvedValueOnce(jsonResponse(200, b));
  await login({ email: b.user.email, password: PASSWORD });
  const detailB = detail({ dispatch_id: ID, description: "B's authorized request", media: [] });
  fetchMock.mockResolvedValueOnce(jsonResponse(200, detailB));
  await expect(client.fetchQuery(opportunityQueryOptions(ID))).resolves.toEqual(detailB);
  expect(isOpportunityDenied(client, ID)).toBe(false);

  held.release();
  await oldRead;
  await settle();

  expect(client.getQueryData(opportunityQueryKey(ID))).toEqual(detailB);
  expect(isOpportunityDenied(client, ID)).toBe(false);
});
