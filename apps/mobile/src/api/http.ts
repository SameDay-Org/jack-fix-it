import type { paths } from "@jack/shared";

import { apiConfig } from "./config";
import { ApiError, NetworkError } from "./errors";

/** Paths that accept GET, from the OpenAPI schema. */
export type GetPath = {
  [P in keyof paths]: paths[P] extends { get: object } ? P : never;
}[keyof paths];

/** Paths that accept POST, from the OpenAPI schema. */
export type PostPath = {
  [P in keyof paths]: paths[P] extends { post: object } ? P : never;
}[keyof paths];

/**
 * The JSON body of an operation's success response: 200, 201 or 202 with JSON, `undefined` for a
 * 202 without content (an accepted request, like the SMS code send) and for 204.
 */
type SuccessBody<Operation> = Operation extends { responses: infer Responses }
  ? Responses extends { 200: { content: { "application/json": infer Body } } }
    ? Body
    : Responses extends { 201: { content: { "application/json": infer Body } } }
      ? Body
      : Responses extends { 202: { content: { "application/json": infer Body } } }
        ? Body
        : Responses extends { 202: object }
          ? undefined
          : Responses extends { 204: object }
            ? undefined
            : never
  : never;

export type GetResponse<P extends GetPath> = SuccessBody<paths[P]["get"]>;
export type PostResponse<P extends PostPath> = SuccessBody<paths[P]["post"]>;

/** The JSON request body a POST path takes. */
export type PostBody<P extends PostPath> = paths[P]["post"] extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : never;

type Method = "GET" | "POST";

const ACCEPTED = 202;

export type SendOptions = {
  body?: unknown;
  accessToken?: string;
  signal?: AbortSignal;
};

/** Joins the path onto the API base URL and refuses anything that lands on another host. */
function resolveUrl(path: string): URL {
  const url = new URL(path, apiConfig.baseUrl);
  // Credentials never leave the configured host, whatever string reached us at runtime.
  if (url.origin !== apiConfig.baseUrl.origin) {
    throw new Error("API path resolves outside the configured API host");
  }
  return url;
}

/** Rethrows a caller's cancellation, so nothing is sent on behalf of a request it gave up on. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const { reason } = signal as { reason?: unknown };
  throw reason ?? Object.assign(new Error("The request was cancelled"), { name: "AbortError" });
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One typed HTTP exchange with the API: JSON in, JSON out, the configured timeout, and the
 * contract's errors. No session logic lives here; `client.ts` adds the bearer token and the retry.
 */
export async function sendRequest<T>(
  method: Method,
  path: GetPath | PostPath,
  options: SendOptions = {},
): Promise<T> {
  throwIfAborted(options.signal);
  const url = resolveUrl(path);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, apiConfig.timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new NetworkError(true, error);
    if (options.signal?.aborted) throw error; // the caller cancelled and gets its own abort back
    throw new NetworkError(false, error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  if (response.status === 204) return undefined as T;
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  // An accepted request answers 202 with an empty body (the contract types it `undefined`). A 202
  // that carries anything else must be JSON like any other answer: a malformed body is an error,
  // never a silent acceptance.
  if (response.status === ACCEPTED) {
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
  return (await response.json()) as T;
}
