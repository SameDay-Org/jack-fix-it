import { ApiError, SessionExpiredError } from "./errors";
import {
  sendRequest,
  throwIfAborted,
  type GetParams,
  type GetPath,
  type GetResponse,
  type PostBody,
  type PostParams,
  type PostPath,
  type PostResponse,
  type QueryParams,
} from "./http";
import { getAccessToken, isCurrentGeneration, refreshSession, sessionGeneration } from "./session";

export type RequestOptions = {
  /** Attach the session's bearer token; on `401 invalid_token`, refresh and retry once. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Query-string values, e.g. `{ limit: 20, cursor }` on a paged list; `undefined` ones are left out. */
  query?: QueryParams;
};

/**
 * The options argument for a path: optional when the path has no `{name}` segments, required with
 * `params` when it has, e.g. `{ params: { request_id } }` for `/v1/requests/{request_id}/quotes`.
 */
export type OptionsFor<Params> = [Params] extends [never]
  ? [options?: RequestOptions]
  : [options: RequestOptions & { params: Params }];

type SentOptions = RequestOptions & { params?: Readonly<Record<string, string>> };

const INVALID_TOKEN = "invalid_token";

/** Typed GET. Paths are the OpenAPI keys; a full URL is not one of them. */
export function apiGet<P extends GetPath>(
  path: P,
  ...[options]: OptionsFor<GetParams<P>>
): Promise<GetResponse<P>> {
  const { params, query, ...session }: SentOptions = options ?? {};
  return withSession(session, (accessToken) =>
    sendRequest<GetResponse<P>>("GET", path, {
      accessToken,
      signal: session.signal,
      params,
      query,
    }),
  );
}

/** Typed POST with a JSON body (`undefined` for a path that takes none). */
export function apiPost<P extends PostPath>(
  path: P,
  body: PostBody<P>,
  ...[options]: OptionsFor<PostParams<P>>
): Promise<PostResponse<P>> {
  const { params, query, ...session }: SentOptions = options ?? {};
  return withSession(session, (accessToken) =>
    sendRequest<PostResponse<P>>("POST", path, {
      body,
      accessToken,
      signal: session.signal,
      params,
      query,
    }),
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
