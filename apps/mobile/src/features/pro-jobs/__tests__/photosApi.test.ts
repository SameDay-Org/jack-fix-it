import type { QueryClient } from "@tanstack/react-query";

import { ApiError, apiPost, NetworkError, SessionExpiredError } from "@/api";

import {
  attachPhoto,
  completeJob,
  proJobQueryKey,
  proJobsQueryKey,
  type AttachOutcome,
  type DoneOutcome,
} from "../api";
import type { JobPhoto, ProJob } from "../phase";
import { JOB_ID, minutesFromNow, newQueryClient, working } from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());

const { mockSession } = jest.requireMock<{ mockSession: { generation: number } }>("@/api");

const PHOTOS = "/v1/pros/me/jobs/{job_id}/photos";
const COMPLETE = "/v1/pros/me/jobs/{job_id}/complete";

/** The pro's own job_photo upload: test data, never a real key. */
const UPLOAD_KEY = "uploads/job_photo/pro-7/0f3c-after-sink.jpg";
const PHOTO_URL = "https://storage.test.invalid/job-photos/0f3c-after-sink.jpg?X-Amz-Signature=sig";

const afterPhoto = (): JobPhoto => ({
  id: "00000000-0000-4000-8000-0000000006a1",
  content_type: "image/jpeg",
  url: PHOTO_URL,
  expires_at: minutesFromNow(15),
});

/** Working with the after photo on the job, as the attach answer brings it back. */
const withAfter = (): ProJob => working({ photos: { before: [], after: [afterPhoto()] } });

/** The same job once Job's done went through. */
const completed = (): ProJob => ({
  ...withAfter(),
  status: "completed",
  completed_at: minutesFromNow(0),
});

/** The job's own cache and the list, both held by generation 1, as the job screen left them. */
function seeded(job: ProJob = working()): QueryClient {
  const client = newQueryClient();
  client.setQueryData(proJobsQueryKey(1), [job]);
  client.setQueryData(proJobQueryKey(JOB_ID, 1), job);
  return client;
}

const listInvalidated = (client: QueryClient, generation = 1) =>
  client.getQueryState(proJobsQueryKey(generation))?.isInvalidated ?? false;

const jobInvalidated = (client: QueryClient, generation = 1) =>
  client.getQueryState(proJobQueryKey(JOB_ID, generation))?.isInvalidated ?? false;

const attach = (client: QueryClient, kind: "before" | "after" = "after") =>
  attachPhoto(client, JOB_ID, kind, UPLOAD_KEY, 1);

/** What a console call would print for one argument, errors with their message and stack. */
function logText(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message} ${arg.stack ?? ""}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let consoleSpies: jest.SpyInstance[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.generation = 1;
  jest.mocked(apiPost).mockReset();
  consoleSpies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method).mockImplementation());
});

afterEach(() => {
  // Neither the upload key nor a signed URL ever reaches a log, whatever the outcome.
  const logged = consoleSpies.flatMap((spy) =>
    spy.mock.calls.map((args: unknown[]) => args.map(logText).join(" ")),
  );
  consoleSpies.forEach((spy) => spy.mockRestore());
  expect(logged.filter((line) => line.includes(UPLOAD_KEY) || line.includes(PHOTO_URL))).toEqual(
    [],
  );
  expect(logged.filter((line) => /uploads\/|X-Amz-Signature/.test(line))).toEqual([]);
});

describe("attachPhoto", () => {
  it("posts the kind and the one upload key, with auth, the generation and the job id", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(withAfter());

    await attach(seeded());

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(
      PHOTOS,
      { kind: "after", upload_keys: [UPLOAD_KEY] },
      { auth: true, generation: 1, params: { job_id: JOB_ID } },
    );
  });

  it("posts a before photo with kind before", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(working());

    await attach(seeded(), "before");

    expect(apiPost).toHaveBeenCalledWith(
      PHOTOS,
      { kind: "before", upload_keys: [UPLOAD_KEY] },
      { auth: true, generation: 1, params: { job_id: JOB_ID } },
    );
  });

  it("answers attached, writes the answered job into its cache and asks the list again", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(withAfter());
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({ kind: "attached" });

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(withAfter());
    expect(listInvalidated(client)).toBe(true);
  });

  it("keeps no upload key in the cache", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(withAfter());
    const client = seeded();

    await attach(client);

    const cached = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    );
    expect(cached).not.toContain(UPLOAD_KEY);
  });

  it("writes nothing when the session changed before the answer arrived", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      return withAfter();
    });
    const client = seeded();

    await attach(client);

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(working());
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 2))).toBeUndefined();
    expect(listInvalidated(client)).toBe(false);
    expect(jobInvalidated(client)).toBe(false);
  });

  it("answers attached for a duplicate_photo and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "duplicate_photo"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({ kind: "attached" });

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(working());
    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("answers expired for upload_expired and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "upload_expired"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({ kind: "expired" });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers refused for invalid_photo and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "invalid_photo"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({ kind: "refused" });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers full for job_photo_limit and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "job_photo_limit"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({ kind: "full" });

    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("answers a changed failure for a 409 job_photo_not_allowed and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "job_photo_not_allowed"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({
      kind: "failure",
      failure: "changed",
    });

    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("answers a gone failure for a 404 and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(404, "not_found"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({
      kind: "failure",
      failure: "gone",
    });

    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("answers an offline failure when no answer came and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(true));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({
      kind: "failure",
      failure: "offline",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers a signedOut failure when the session is over and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new SessionExpiredError("superseded"));
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({
      kind: "failure",
      failure: "signedOut",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it.each([
    ["a 500", new ApiError(500, undefined)],
    ["a 422 with another code", new ApiError(422, "validation_error")],
    ["an unexpected error", new Error("boom")],
  ])("answers a failed failure for %s and refreshes nothing", async (_name, error) => {
    jest.mocked(apiPost).mockRejectedValueOnce(error);
    const client = seeded();

    await expect(attach(client)).resolves.toEqual<AttachOutcome>({
      kind: "failure",
      failure: "failed",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it.each([
    ["duplicate_photo", new ApiError(409, "duplicate_photo")],
    ["job_photo_limit", new ApiError(409, "job_photo_limit")],
    ["job_photo_not_allowed", new ApiError(409, "job_photo_not_allowed")],
  ])("refreshes nothing for a %s that lands after the session changed", async (_name, error) => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      throw error;
    });
    const client = seeded();

    await attach(client);

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 2))).toBeUndefined();
  });
});

describe("completeJob", () => {
  it("posts no body with auth, the generation and the job id", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(completed());

    await completeJob(seeded(withAfter()), JOB_ID, 1);

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(COMPLETE, undefined, {
      auth: true,
      generation: 1,
      params: { job_id: JOB_ID },
    });
  });

  it("answers done with the completed job, writes it into its cache and asks the list again", async () => {
    jest.mocked(apiPost).mockResolvedValueOnce(completed());
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "done",
      job: completed(),
    });

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(completed());
    expect(listInvalidated(client)).toBe(true);
  });

  it("writes nothing when the session changed before the answer arrived", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      return completed();
    });
    const client = seeded(withAfter());

    await completeJob(client, JOB_ID, 1);

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(withAfter());
    expect(client.getQueryData(proJobQueryKey(JOB_ID, 2))).toBeUndefined();
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers processing for after_photos_processing and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "after_photos_processing"));
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "processing",
    });

    expect(client.getQueryData(proJobQueryKey(JOB_ID, 1))).toEqual(withAfter());
    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers photosRequired for after_photos_required and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "after_photos_required"));
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "photosRequired",
    });

    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("refreshes nothing for an after_photos_required that lands after the session changed", async () => {
    jest.mocked(apiPost).mockImplementationOnce(async () => {
      mockSession.generation += 1;
      throw new ApiError(409, "after_photos_required");
    });
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "photosRequired",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers a changed failure for a 409 invalid_transition and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(409, "invalid_transition"));
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "failure",
      failure: "changed",
    });

    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("answers a gone failure for a 404 and asks the job and the list again", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(404, "not_found"));
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "failure",
      failure: "gone",
    });

    expect(jobInvalidated(client)).toBe(true);
    expect(listInvalidated(client)).toBe(true);
  });

  it("answers an offline failure when no answer came and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(false));
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "failure",
      failure: "offline",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers a signedOut failure when the session is over and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new SessionExpiredError());
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "failure",
      failure: "signedOut",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });

  it("answers a failed failure for a 500 and refreshes nothing", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(500, undefined));
    const client = seeded(withAfter());

    await expect(completeJob(client, JOB_ID, 1)).resolves.toEqual<DoneOutcome>({
      kind: "failure",
      failure: "failed",
    });

    expect(jobInvalidated(client)).toBe(false);
    expect(listInvalidated(client)).toBe(false);
  });
});
