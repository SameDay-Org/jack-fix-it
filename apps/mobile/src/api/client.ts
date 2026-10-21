import { ApiError } from "./errors";
import {
  sendRequest,
  type GetPath,
  type GetResponse,
  type PostBody,
  type PostPath,
  type PostResponse,
} from "./http";
import { getAccessToken, refreshSession } from "./session";

export type RequestOptions = {
  /** Attach the session's bearer token; on `401 invalid_token`, refresh and retry once. */
  auth?: boolean;
  signal?: AbortSignal;
};

const INVALID_TOKEN = "invalid_token";

/** Typed GET. Paths are the OpenAPI keys; a full URL is not one of them. */
export function apiGet<P extends GetPath>(
  path: P,
  options: RequestOptions = {},
): Promise<GetResponse<P>> {
  return withSession(options, (accessToken) =>
    sendRequest<GetResponse<P>>("GET", path, { accessToken, signal: options.signal }),
  );
}

/** Typed POST with a JSON body. */
export function apiPost<P extends PostPath>(
  path: P,
  body: PostBody<P>,
  options: RequestOptions = {},
): Promise<PostResponse<P>> {
  return withSession(options, (accessToken) =>
    sendRequest<PostResponse<P>>("POST", path, { body, accessToken, signal: options.signal }),
  );
}

// One retry at most: a 401 with a freshly issued token is the server's final word.
async function withSession<T>(
  options: RequestOptions,
  send: (accessToken?: string) => Promise<T>,
): Promise<T> {
  if (!options.auth) return send();
  try {
    return await send(await getAccessToken());
  } catch (error) {
    const expiredAccess =
      error instanceof ApiError && error.status === 401 && error.code === INVALID_TOKEN;
    if (!expiredAccess) throw error;
    return send(await refreshSession());
  }
}
