import { ApiError, SessionExpiredError } from "./errors";
import {
  sendRequest,
  throwIfAborted,
  type GetPath,
  type GetResponse,
  type PostBody,
  type PostPath,
  type PostResponse,
} from "./http";
import { getAccessToken, isCurrentGeneration, refreshSession, sessionGeneration } from "./session";

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

const isExpiredAccess = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401 && error.code === INVALID_TOKEN;

/** The session the operation started in is gone: its results, errors and retries are void. */
function ensureCurrent(startedIn: number): void {
  if (!isCurrentGeneration(startedIn)) throw new SessionExpiredError("superseded");
}

// The whole authenticated operation belongs to the session generation it starts in. Whatever
// comes back after a sign-out or a newer sign-in is discarded, even a 2xx, because the data was
// the old session's; a 401 refreshes only while that generation is current, and the one retry
// happens only if it still is once the refresh resolves. A caller that cancels while a shared
// refresh runs sends nothing afterwards; the refresh still completes for the others.
async function withSession<T>(
  options: RequestOptions,
  send: (accessToken?: string) => Promise<T>,
): Promise<T> {
  if (!options.auth) return send();
  const startedIn = sessionGeneration();
  const accessToken = await getAccessToken();
  ensureCurrent(startedIn);
  throwIfAborted(options.signal);

  let result: T;
  try {
    result = await send(accessToken);
  } catch (error) {
    ensureCurrent(startedIn);
    if (!isExpiredAccess(error)) throw error;
    const freshToken = await refreshSession();
    ensureCurrent(startedIn);
    throwIfAborted(options.signal);
    result = await send(freshToken);
  }
  ensureCurrent(startedIn);
  return result;
}
