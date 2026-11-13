import type { paths } from "@jack/shared";

/** API paths that accept GET. */
type GetPath = {
  [P in keyof paths]: paths[P] extends { get: object } ? P : never;
}[keyof paths];

/** The JSON body of a GET path's 200 response, from the OpenAPI schema. */
type GetResponse<P extends GetPath> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer Body } } } };
}
  ? Body
  : never;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`API request failed with status ${status}${code ? ` (${code})` : ""}`);
    this.name = "ApiError";
  }
}

/** API_TIMEOUT_MS: the longest wait on the API for one call, body included (never a literal). */
export function apiTimeoutMs(): number {
  const ms = Number(process.env.API_TIMEOUT_MS);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error("API_TIMEOUT_MS is not set to a positive whole number");
  }
  return ms;
}

function apiBaseUrl(): string {
  const url = process.env.API_INTERNAL_URL;
  if (!url) throw new Error("API_INTERNAL_URL is not set");
  return url;
}

/** The values of a path's `{placeholders}`, from the OpenAPI schema. */
type PathParams<Operation> = Operation extends { parameters: { path: infer Params } }
  ? Params
  : never;

/** The query string a path accepts, from the OpenAPI schema. */
type QueryParams<Operation> = Operation extends { parameters: { query?: infer Query } }
  ? Query
  : never;

/** What a call may add to RequestInit: the path's `{placeholders}` and its query string. */
export type ApiInit<Operation> = RequestInit & {
  params?: PathParams<Operation>;
  query?: QueryParams<Operation>;
};

type UrlParts = { params?: object; query?: object };

/**
 * The URL of an API path: each `{placeholder}` replaced by its value in `params`, URL-encoded,
 * and `query` appended (null and undefined values are left out). A placeholder without a
 * value, or with one that would change the path (empty, `.` or `..`), throws: a call never
 * reaches another route than the one it names.
 */
export function apiUrl(path: string, parts?: UrlParts): URL {
  const params: Record<string, unknown> = { ...parts?.params };
  const filled = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (typeof value !== "string" || value === "" || value === "." || value === "..") {
      throw new Error(`API path parameter ${name} is missing or invalid`);
    }
    return encodeURIComponent(value);
  });
  const url = new URL(filled, apiBaseUrl());
  for (const [name, value] of Object.entries({ ...parts?.query })) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  return url;
}

/** `init` without the fields fetch does not know. */
function fetchInit(init: (RequestInit & UrlParts) | undefined): RequestInit {
  const rest: RequestInit & UrlParts = { ...init };
  delete rest.params;
  delete rest.query;
  return rest;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Server-side GET against the API (Railway private network). Throws ApiError on non-2xx, and
 * the fetch's TimeoutError when the API takes longer than API_TIMEOUT_MS.
 */
export async function apiGet<P extends GetPath>(
  path: P,
  init?: ApiInit<paths[P]["get"]>,
): Promise<GetResponse<P>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  // The signal stays armed while the body is read, so a stalled body times out too.
  const response = await fetch(apiUrl(path, init), {
    ...fetchInit(init),
    method: "GET",
    headers,
    signal: AbortSignal.timeout(apiTimeoutMs()),
  });
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  return (await response.json()) as GetResponse<P>;
}

/** API paths that accept POST. */
type PostPath = {
  [P in keyof paths]: paths[P] extends { post: object } ? P : never;
}[keyof paths];

/** The JSON request body of a POST path, from the OpenAPI schema. */
type PostBody<P extends PostPath> = paths[P] extends {
  post: { requestBody: { content: { "application/json": infer Body } } };
}
  ? Body
  : never;

/** The JSON body of a POST path's 200 or 201 response; undefined for a 204. */
type PostResponse<P extends PostPath> = paths[P] extends {
  post: { responses: { 200: { content: { "application/json": infer Body } } } };
}
  ? Body
  : paths[P] extends {
        post: { responses: { 201: { content: { "application/json": infer Body } } } };
      }
    ? Body
    : undefined;

/** Server-side POST of a JSON body against the API. Throws ApiError on non-2xx. */
export async function apiPost<P extends PostPath>(
  path: P,
  body: PostBody<P>,
  init?: ApiInit<paths[P]["post"]>,
): Promise<PostResponse<P>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const response = await fetch(apiUrl(path, init), {
    ...fetchInit(init),
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(apiTimeoutMs()), // body read included, as in apiGet
  });
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  if (response.status === 204) return undefined as PostResponse<P>;
  return (await response.json()) as PostResponse<P>;
}

/** API paths that accept PATCH. */
type PatchPath = {
  [P in keyof paths]: paths[P] extends { patch: object } ? P : never;
}[keyof paths];

/** The JSON request body of a PATCH path, from the OpenAPI schema. */
type PatchBody<P extends PatchPath> = paths[P] extends {
  patch: { requestBody: { content: { "application/json": infer Body } } };
}
  ? Body
  : never;

/** The JSON body of a PATCH path's 200 response. */
type PatchResponse<P extends PatchPath> = paths[P] extends {
  patch: { responses: { 200: { content: { "application/json": infer Body } } } };
}
  ? Body
  : never;

/** Server-side PATCH of a JSON body against the API. Throws ApiError on non-2xx. */
export async function apiPatch<P extends PatchPath>(
  path: P,
  body: PatchBody<P>,
  init?: ApiInit<paths[P]["patch"]>,
): Promise<PatchResponse<P>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const response = await fetch(apiUrl(path, init), {
    ...fetchInit(init),
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(apiTimeoutMs()), // body read included, as in apiGet
  });
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  return (await response.json()) as PatchResponse<P>;
}
