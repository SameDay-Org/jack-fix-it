import { ApiError, SessionExpiredError } from "./errors";
import {
  sendRequest,
  throwIfAborted,
  type GetParams,
  type GetPath,
  type GetResponse,
  type PatchBody,
  type PatchParams,
  type PatchPath,
  type PatchResponse,
  type PostBody,
  type PostParams,
  type PostPath,
  type PostResponse,
  type PutBody,
  type PutParams,
  type PutPath,
  type PutResponse,
  type DeleteBody,
  type DeleteParams,
  type DeletePath,
  type DeleteResponse,
  type QueryParams,
} from "./http";
import { getAccessToken, isCurrentGeneration, refreshSession, sessionGeneration } from "./session";

export type RequestOptions = {
  /** Attach the session's bearer token; on `401 invalid_token`, refresh and retry once. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Query-string values, e.g. `{ limit: 20, cursor }` on a paged list; `undefined` ones are left out. */
  query?: QueryParams;
  /**
   * Pins the call to the session generation a longer operation started in (`sessionGeneration()`
   * taken when it started). After a sign-out or another sign-in nothing is sent: the call rejects
   * with `SessionExpiredError("superseded")`, so a later step of the operation never carries the
   * next session's token. Without it the call belongs to the generation current when it starts.
   */
  generation?: number;
};

/** A POST's options: a create that takes one may carry an Idempotency-Key. */
export type PostOptions = RequestOptions & {
  /**
   * Sent as the `Idempotency-Key` header (`POST /v1/requests`): the same key with the same body
   * answers what the first call created instead of creating it again. Never logged.
   */
  idempotencyKey?: string;
};

/**
 * The options argument for a path: optional when the path has no `{name}` segments, required with
 * `params` when it has, e.g. `{ params: { request_id } }` for `/v1/requests/{request_id}/quotes`.
 */
export type OptionsFor<Params, Options extends RequestOptions = RequestOptions> = [Params] extends [
  never,
]
  ? [options?: Options]
  : [options: Options & { params: Params }];

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
  ...[options]: OptionsFor<PostParams<P>, PostOptions>
): Promise<PostResponse<P>> {
  const { params, query, idempotencyKey, ...session }: SentOptions & PostOptions = options ?? {};
  return withSession(session, (accessToken) =>
    sendRequest<PostResponse<P>>("POST", path, {
      body,
      accessToken,
      signal: session.signal,
      params,
      query,
      idempotencyKey,
    }),
  );
}

/** Typed PATCH with a JSON body: the fields to change (a profile update). */
export function apiPatch<P extends PatchPath>(
  path: P,
  body: PatchBody<P>,
  ...[options]: OptionsFor<PatchParams<P>>
): Promise<PatchResponse<P>> {
  const { params, query, ...session }: SentOptions = options ?? {};
  return withSession(session, (accessToken) =>
    sendRequest<PatchResponse<P>>("PATCH", path, {
      body,
      accessToken,
      signal: session.signal,
      params,
      query,
    }),
  );
}

/** Typed PUT with a JSON body: the whole resource, an idempotent upsert (a device registration). */
export function apiPut<P extends PutPath>(
  path: P,
  body: PutBody<P>,
  ...[options]: OptionsFor<PutParams<P>>
): Promise<PutResponse<P>> {
  const { params, query, ...session }: SentOptions = options ?? {};
  return withSession(session, (accessToken) =>
    sendRequest<PutResponse<P>>("PUT", path, {
      body,
      accessToken,
      signal: session.signal,
      params,
      query,
    }),
  );
}

/**
 * Typed DELETE, with the JSON body the path takes (`undefined` for none): a value that must stay
 * out of the logged path, like a push token, travels in the body.
 */
export function apiDelete<P extends DeletePath>(
  path: P,
  body: DeleteBody<P>,
  ...[options]: OptionsFor<DeleteParams<P>>
): Promise<DeleteResponse<P>> {
  const { params, query, ...session }: SentOptions = options ?? {};
  return withSession(session, (accessToken) =>
    sendRequest<DeleteResponse<P>>("DELETE", path, {
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
  if (options.generation !== undefined) ensureCurrent(options.generation);
  if (!options.auth) return send();
  const startedIn = options.generation ?? sessionGeneration();
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
    try {
      result = await send(freshToken);
    } catch (retryError) {
      // A failed retry is held to the same session as the first answer.
      ensureCurrent(startedIn);
      throw retryError;
    }
  }
  ensureCurrent(startedIn);
  return result;
}
