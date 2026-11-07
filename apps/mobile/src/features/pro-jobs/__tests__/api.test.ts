import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { ApiError, apiGet, apiPost, NetworkError, SessionExpiredError, useSession } from "@/api";

import {
  ATTEMPTS_REMAINING_HEADER,
  checkIn,
  markOnTheWay,
  proJobQueryKey,
  proJobQueryOptions,
  proJobsQueryKey,
  proJobsQueryOptions,
  startJob,
  stepFailure,
  useProJob,
  useProJobs,
  useSingleFlight,
  type StepFailure,
} from "../api";
import type { ProJob, ProJobPage } from "../phase";
import { settle } from "../../../api/__tests__/helpers";
import { SIGNED_OUT } from "../../auth/__tests__/helpers";
import {
  ARRIVAL_CODE,
  arrived,
  hoursFromNow,
  JOB_ID,
  jobN,
  jobPage,
  navigation,
  newQueryClient,
  onTheWay,
  proJob,
  signedIn,
  working,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);

const { mockSession } = jest.requireMock<{ mockSession: { generation: number } }>("@/api");

const { accessToken: _token, accessTokenExpiresAt: _expiry, ...SIGNED_OUT_VIEW } = SIGNED_OUT;

const POSITION = { lat: 26.1224, lng: -80.1373 };
const LIST = "/v1/pros/me/jobs";
const ONE = "/v1/pros/me/jobs/{job_id}";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

/** The list cache of generation 1 holding these jobs, as "Your jobs" left it. */
function listedClient(jobs: ProJob[] = [proJob()]): QueryClient {
  const client = newQueryClient();
  client.setQueryData(proJobsQueryKey(1), jobs);
  return client;
}

const listInvalidated = (client: QueryClient, generation = 1) =>
  client.getQueryState(proJobsQueryKey(generation))?.isInvalidated ?? false;

const jobInvalidated = (client: QueryClient, generation = 1) =>
  client.getQueryState(proJobQueryKey(JOB_ID, generation))?.isInvalidated ?? false;

/** A 422 wrong code with the tries-left header as the API sends it (or none). */
const wrongCode = (triesHeader?: string) =>
  new ApiError(
    422,
    "arrival_code_invalid",
    new Headers(triesHeader === undefined ? {} : { [ATTEMPTS_REMAINING_HEADER]: triesHeader }),
  );

beforeEach(() => {
  mockSession.generation = 1;
  jest.mocked(apiGet).mockReset();
  jest.mocked(apiPost).mockReset();
  jest.mocked(useSession).mockReset();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro", first_name: "Dan" }));
});

afterEach(() => navigation.reset());

describe("proJobsQueryOptions", () => {
  it("reads every page, keeps only active jobs and lists them soonest first", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(
        jobPage(
          [
            jobN(1, { scheduled_start_at: hoursFromNow(5) }),
            jobN(2, { status: "completed", scheduled_start_at: hoursFromNow(-30) }),
          ],
          "c1",
        ),
      )
      .mockResolvedValueOnce(
        jobPage(
          [
            jobN(3, { status: "on_the_way", scheduled_start_at: hoursFromNow(1) }),
            jobN(4, { status: "cancelled", scheduled_start_at: hoursFromNow(-2) }),
            jobN(6, { status: "confirmed", scheduled_start_at: hoursFromNow(-48) }),
          ],
          "c2",
        ),
      )
      .mockResolvedValueOnce(
        jobPage([
          jobN(5, { status: "in_progress", scheduled_start_at: hoursFromNow(-1) }),
          jobN(7, { status: "refunded", scheduled_start_at: hoursFromNow(-3) }),
          jobN(8, { status: "paid_out", scheduled_start_at: hoursFromNow(-4) }),
          jobN(9, { status: "disputed", scheduled_start_at: hoursFromNow(-5) }),
        ]),
      );

    const jobs = await newQueryClient().fetchQuery(proJobsQueryOptions(1));

    expect(jobs.map((job) => job.id)).toEqual([jobN(5).id, jobN(3).id, jobN(1).id]);
    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it("asks each page with the session's generation, the active filter, the cursor and the signal", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(jobPage([jobN(1)], "c1"))
      .mockResolvedValueOnce(jobPage([jobN(2)]));

    await newQueryClient().fetchQuery(proJobsQueryOptions(7));

    expect(apiGet).toHaveBeenNthCalledWith(1, LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 7,
      query: { active: "true", cursor: undefined },
    });
    expect(apiGet).toHaveBeenNthCalledWith(2, LIST, {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 7,
      query: { active: "true", cursor: "c1" },
    });
  });

  it("passes the query's own signal, so cancelling the list aborts the page in flight", async () => {
    const page = deferred<ProJobPage>();
    jest.mocked(apiGet).mockReturnValueOnce(page.promise);
    const client = newQueryClient();

    const read = client.fetchQuery(proJobsQueryOptions(1)).catch(() => undefined);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const options = jest.mocked(apiGet).mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);

    await client.cancelQueries({ queryKey: proJobsQueryKey(1) });
    expect(options.signal.aborted).toBe(true);
    page.resolve(jobPage([]));
    await read;
  });

  it("stops reading when a cursor comes back a second time", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(jobPage([jobN(1)], "c1"))
      .mockResolvedValueOnce(jobPage([jobN(2)], "c1"))
      .mockResolvedValue(jobPage([jobN(3)], "c1"));

    const jobs = await newQueryClient().fetchQuery(proJobsQueryOptions(1));

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(jobs.map((job) => job.id).sort()).toEqual([jobN(1).id, jobN(2).id]);
  });

  it("stops reading when the cursors loop back to an earlier page", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(jobPage([jobN(1)], "c1"))
      .mockResolvedValueOnce(jobPage([jobN(2)], "c2"))
      .mockResolvedValueOnce(jobPage([jobN(3)], "c1"))
      .mockResolvedValue(jobPage([jobN(4)], "c2"));

    await newQueryClient().fetchQuery(proJobsQueryOptions(1));

    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it("orders two jobs that start at the same time by id, whatever order the pages had", async () => {
    const at = hoursFromNow(2);
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(
        jobPage([
          jobN(9, { scheduled_start_at: at }),
          jobN(4, { scheduled_start_at: at }),
          jobN(6, { scheduled_start_at: hoursFromNow(1) }),
        ]),
      );

    const jobs = await newQueryClient().fetchQuery(proJobsQueryOptions(1));

    expect(jobs.map((job) => job.id)).toEqual([jobN(6).id, jobN(4).id, jobN(9).id]);
  });

  it("answers an empty list when the pro has no active job", async () => {
    jest.mocked(apiGet).mockResolvedValueOnce(jobPage([]));

    await expect(newQueryClient().fetchQuery(proJobsQueryOptions(1))).resolves.toEqual([]);
  });

  it("keys the list by generation and does not retry a failure", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));

    expect(proJobsQueryOptions(3).queryKey).toEqual(["pro-jobs", "active", 3]);
    await expect(newQueryClient().fetchQuery(proJobsQueryOptions(3))).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe("proJobQueryOptions", () => {
  it("asks for the one job pinned to the generation, with its id as the path parameter", async () => {
    jest.mocked(apiGet).mockResolvedValueOnce(onTheWay());

    const job = await newQueryClient().fetchQuery(proJobQueryOptions(JOB_ID, 4));

    expect(job).toEqual(onTheWay());
    expect(apiGet).toHaveBeenCalledWith(ONE, {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 4,
      params: { job_id: JOB_ID },
    });
    expect(proJobQueryOptions(JOB_ID, 4).queryKey).toEqual(["pro-jobs", "job", JOB_ID, 4]);
  });

  it("does not retry a failed read", async () => {
    jest.mocked(apiGet).mockRejectedValueOnce(new ApiError(404, "not_found"));

    await expect(newQueryClient().fetchQuery(proJobQueryOptions(JOB_ID, 1))).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe("useProJobs", () => {
  it("asks for a signed-in pro's jobs under the current generation", async () => {
    mockSession.generation = 2;
    jest.mocked(apiGet).mockResolvedValueOnce(jobPage([proJob()]));
    const client = newQueryClient();

    const { result } = await renderHook(() => useProJobs(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.data).toEqual([proJob()]));
    expect(apiGet).toHaveBeenCalledWith(LIST, expect.objectContaining({ generation: 2 }));
    expect(client.getQueryData(proJobsQueryKey(2))).toEqual([proJob()]);
  });

  it("asks again when the home comes back into focus", async () => {
    jest.mocked(apiGet).mockResolvedValue(jobPage([proJob()]));

    const { result } = await renderHook(() => useProJobs(), {
      wrapper: wrapperFor(newQueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledTimes(1);

    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it("with refetchOnReturn off, neither focus nor the foreground asks again, and its refetch still does", async () => {
    jest.mocked(apiGet).mockResolvedValue(jobPage([proJob()]));
    jest.mocked(AppState.addEventListener).mockClear();

    const { result } = await renderHook(() => useProJobs({ refetchOnReturn: false }), {
      wrapper: wrapperFor(newQueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledTimes(1);

    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    const listeners = jest
      .mocked(AppState.addEventListener)
      .mock.calls.filter(([event]) => event === "change")
      .map(([, listener]) => listener as (state: AppStateStatus) => void);
    await act(async () => listeners.forEach((listener) => listener("active")));
    await act(settle);
    expect(apiGet).toHaveBeenCalledTimes(1);

    // The caller's own refresh (the home's pull) still asks.
    await act(async () => {
      await result.current.refetch();
    });
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a signed-in customer", () => signedIn()],
    ["a signed-out session", () => SIGNED_OUT_VIEW],
  ])("asks nothing for %s, and its refetch resolves without a call", async (_who, session) => {
    jest.mocked(useSession).mockReturnValue(session());

    const { result } = await renderHook(() => useProJobs(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    await act(async () => {
      await expect(result.current.refetch()).resolves.toBeUndefined();
    });
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });
});

describe("useProJob", () => {
  it("asks nothing for an id that is not a UUID and reports it as not valid", async () => {
    const { result } = await renderHook(() => useProJob("not-a-job"), {
      wrapper: wrapperFor(newQueryClient()),
    });

    expect(result.current.valid).toBe(false);
    await act(async () => {
      await expect(result.current.refetch()).resolves.toBeUndefined();
    });
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("asks nothing for a signed-out session, even with a valid id", async () => {
    jest.mocked(useSession).mockReturnValue(SIGNED_OUT_VIEW);

    const { result } = await renderHook(() => useProJob(JOB_ID), {
      wrapper: wrapperFor(newQueryClient()),
    });

    expect(result.current.valid).toBe(true);
    await act(async () => {
      await expect(result.current.refetch()).resolves.toBeUndefined();
    });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("draws a listed job at once from the list cache, then asks the API for it", async () => {
    const answer = deferred<ProJob>();
    jest.mocked(apiGet).mockReturnValueOnce(answer.promise);
    const client = listedClient([jobN(1), proJob()]);

    const { result } = await renderHook(() => useProJob(JOB_ID), {
      wrapper: wrapperFor(client),
    });

    expect(result.current.valid).toBe(true);
    expect(result.current.data).toEqual(proJob());
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(ONE, expect.objectContaining({ generation: 1 })),
    );

    await act(async () => answer.resolve(onTheWay()));
    await waitFor(() => expect(result.current.data).toEqual(onTheWay()));
  });

  it("has nothing to draw for a job the list does not hold until the API answers", async () => {
    const answer = deferred<ProJob>();
    jest.mocked(apiGet).mockReturnValueOnce(answer.promise);
    const client = listedClient([jobN(1)]);

    const { result } = await renderHook(() => useProJob(JOB_ID), {
      wrapper: wrapperFor(client),
    });

    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await act(async () => answer.resolve(proJob()));
    await waitFor(() => expect(result.current.data).toEqual(proJob()));
  });
});

describe("markOnTheWay", () => {
  it("posts the arrival time pinned to the generation and writes the answer into the job's cache", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(onTheWay());
    const client = listedClient();

    await expect(markOnTheWay(client, JOB_ID, 20, 1)).resolves.toEqual(onTheWay());

    expect(apiPost).toHaveBeenCalledWith(
      "/v1/pros/me/jobs/{job_id}/on-the-way",
      { eta_minutes: 20 },
      { auth: true, generation: 1, params: { job_id: JOB_ID } },
    );
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(onTheWay());
    expect(listInvalidated(client)).toBe(true);
  });

  it("writes nothing when the session changed before the answer arrived", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      return onTheWay();
    });
    const client = listedClient();

    await expect(markOnTheWay(client, JOB_ID, 45, 1)).resolves.toEqual(onTheWay());

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toBeUndefined();
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 2))).toBeUndefined();
    expect(listInvalidated(client)).toBe(false);
  });

  it("lets a failure reach the caller and writes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "invalid_transition"));
    const client = listedClient();

    await expect(markOnTheWay(client, JOB_ID, 20, 1)).rejects.toBeInstanceOf(ApiError);

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toBeUndefined();
    expect(listInvalidated(client)).toBe(false);
  });
});

describe("startJob", () => {
  it("posts no body pinned to the generation and writes the started job into the cache", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(working());
    const client = listedClient([arrived()]);

    await expect(startJob(client, JOB_ID, 1)).resolves.toEqual(working());

    expect(apiPost).toHaveBeenCalledWith("/v1/pros/me/jobs/{job_id}/start", undefined, {
      auth: true,
      generation: 1,
      params: { job_id: JOB_ID },
    });
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(working());
    expect(listInvalidated(client)).toBe(true);
  });

  it("writes nothing when the session changed before the answer arrived", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      return working();
    });
    const client = listedClient([arrived()]);

    await startJob(client, JOB_ID, 1);

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toBeUndefined();
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 2))).toBeUndefined();
    expect(listInvalidated(client)).toBe(false);
  });

  it("hands a 409 check_in_required to the caller as a changed step", async () => {
    const refusal = new ApiError(409, "check_in_required");
    jest.mocked(apiPost).mockRejectedValueOnce(refusal);

    const error: unknown = await startJob(listedClient(), JOB_ID, 1).catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(stepFailure(error)).toBe("changed");
  });
});

describe("checkIn", () => {
  /** The job's own cache and the list, both held by generation 1. */
  function seeded(): QueryClient {
    const client = listedClient([onTheWay()]);
    client.setQueryData(proJobQueryKey(JOB_ID, 1), onTheWay());
    return client;
  }

  it("posts the code and the position in one request pinned to the generation", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());

    await checkIn(seeded(), JOB_ID, ARRIVAL_CODE, POSITION, 1);

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      "/v1/pros/me/jobs/{job_id}/check-in",
      { arrival_code: ARRIVAL_CODE, lat: POSITION.lat, lng: POSITION.lng },
      { auth: true, generation: 1, params: { job_id: JOB_ID } },
    );
  });

  it("answers checkedIn with the job and writes it into the cache", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());
    const client = seeded();

    await expect(checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "checkedIn",
      job: arrived(),
    });
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(arrived());
    expect(listInvalidated(client)).toBe(true);
  });

  it("keeps neither the code nor the position in the cache", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(arrived());
    const client = seeded();

    await checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1);

    const cached = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    );
    expect(cached).not.toContain(ARRIVAL_CODE);
    expect(cached).not.toContain(String(POSITION.lat));
  });

  it("writes nothing for a check-in whose session changed before the answer", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      return arrived();
    });
    const client = seeded();

    const outcome = await checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1);

    expect(outcome.kind).toBe("checkedIn");
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(onTheWay());
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 2))).toBeUndefined();
    expect(listInvalidated(client)).toBe(false);
  });

  it.each([
    ["3", 3],
    ["1", 1],
    ["0", 0],
    [" 2 ", 2],
  ])("answers a wrong code with %j tries left as the number %d", async (header, tries) => {
    jest.mocked(apiPost).mockRejectedValueOnce(wrongCode(header));
    const client = seeded();

    await expect(checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "wrongCode",
      triesLeft: tries,
    });
    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a number", "x"],
    ["negative", "-1"],
    ["a fraction", "2.5"],
    ["beyond a safe integer", "99999999999999999999"],
  ])("answers a wrong code with no tries left count when the header is %s", async (_, header) => {
    jest.mocked(apiPost).mockRejectedValueOnce(wrongCode(header));

    await expect(checkIn(seeded(), JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "wrongCode",
      triesLeft: null,
    });
  });

  it("answers locked on a 423 and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(423, "arrival_code_locked"));
    const client = seeded();

    await expect(checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "locked",
    });
    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("refreshes nothing for a 423 that lands after the session changed", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      throw new ApiError(423, "arrival_code_locked");
    });
    const client = seeded();

    await expect(checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "locked",
    });
    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it.each([
    ["a 409", new ApiError(409, "invalid_transition"), "changed"],
    ["a 404", new ApiError(404, "not_found"), "gone"],
  ] as const)("answers %s as %s and asks the job and the list again", async (_, error, failure) => {
    jest.mocked(apiPost).mockRejectedValueOnce(error);
    const client = seeded();

    await expect(checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "failure",
      failure,
    });
    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it.each([
    ["no answer from the network", new NetworkError(false), "offline"],
    ["a timeout", new NetworkError(true), "offline"],
    ["an expired session", new SessionExpiredError(), "signedOut"],
    ["a superseded session", new SessionExpiredError("superseded"), "signedOut"],
    ["a 422 validation_error", new ApiError(422, "validation_error"), "failed"],
    ["a 500", new ApiError(500, undefined), "failed"],
  ] as const)("answers %s as %s and writes nothing", async (_, error, failure) => {
    jest.mocked(apiPost).mockRejectedValueOnce(error);
    const client = seeded();

    await expect(checkIn(client, JOB_ID, ARRIVAL_CODE, POSITION, 1)).resolves.toEqual({
      kind: "failure",
      failure,
    });
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(onTheWay());
    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });
});

describe("stepFailure", () => {
  it.each<[string, unknown, StepFailure]>([
    ["an expired session", new SessionExpiredError(), "signedOut"],
    ["a superseded session", new SessionExpiredError("superseded"), "signedOut"],
    ["a network failure", new NetworkError(false), "offline"],
    ["a timeout", new NetworkError(true), "offline"],
    ["a 409", new ApiError(409, "check_in_required"), "changed"],
    ["a 404", new ApiError(404, "not_found"), "gone"],
    ["a 422", new ApiError(422, "validation_error"), "failed"],
    ["a 403", new ApiError(403, "forbidden"), "failed"],
    ["a 500", new ApiError(500, undefined), "failed"],
    ["a plain error", new Error("boom"), "failed"],
    ["a non-error", "boom", "failed"],
  ])("maps %s to %s", (_, error, failure) => {
    expect(stepFailure(error)).toBe(failure);
  });
});

describe("useSingleFlight", () => {
  it("ignores a second run while one is in flight and clears busy when it settles", async () => {
    const answer = deferred<string>();
    const work = jest.fn(() => answer.promise);
    const second = jest.fn(async () => "second");
    const { result } = await renderHook(() => useSingleFlight());
    expect(result.current.busy).toBe(false);

    let first: Promise<string | undefined> = Promise.resolve(undefined);
    let ignored: string | undefined = "not run";
    await act(async () => {
      first = result.current.run(work);
      ignored = await result.current.run(second);
    });

    expect(ignored).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);

    await act(async () => answer.resolve("done"));
    await expect(first).resolves.toBe("done");
    expect(result.current.busy).toBe(false);

    let next: string | undefined;
    await act(async () => {
      next = await result.current.run(second);
    });
    expect(next).toBe("second");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("clears busy and takes the next run after a failed one", async () => {
    const { result } = await renderHook(() => useSingleFlight());

    await act(async () => {
      await expect(
        result.current.run(() => Promise.reject(new NetworkError(false))),
      ).rejects.toBeInstanceOf(NetworkError);
    });
    expect(result.current.busy).toBe(false);

    let next: number | undefined;
    await act(async () => {
      next = await result.current.run(async () => 2);
    });
    expect(next).toBe(2);
  });

  it("reports mounted until the screen goes, and an answer after that sets no state", async () => {
    const answer = deferred<string>();
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, unmount } = await renderHook(() => useSingleFlight());
    const { mounted, run } = result.current;
    expect(mounted.current).toBe(true);

    let pending: Promise<string | undefined> = Promise.resolve(undefined);
    await act(async () => {
      pending = run(() => answer.promise);
    });
    await unmount();
    expect(mounted.current).toBe(false);

    answer.resolve("late");
    await expect(pending).resolves.toBe("late");
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
