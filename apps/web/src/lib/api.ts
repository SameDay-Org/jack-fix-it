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

function apiBaseUrl(): string {
  const url = process.env.API_INTERNAL_URL;
  if (!url) throw new Error("API_INTERNAL_URL is not set");
  return url;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

/** Server-side GET against the API (Railway private network). Throws ApiError on non-2xx. */
export async function apiGet<P extends GetPath>(
  path: P,
  init?: RequestInit,
): Promise<GetResponse<P>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  const response = await fetch(new URL(path, apiBaseUrl()), { ...init, method: "GET", headers });
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
  init?: RequestInit,
): Promise<PostResponse<P>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, apiBaseUrl()), {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  if (response.status === 204) return undefined as PostResponse<P>;
  return (await response.json()) as PostResponse<P>;
}
