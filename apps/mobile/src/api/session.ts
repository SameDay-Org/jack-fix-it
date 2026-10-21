import type { ApiSchema } from "@jack/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

import { ApiError, LocalCleanupError, SessionExpiredError } from "./errors";
import { sendRequest, type PostBody } from "./http";
import { refreshTokenStorage, type TakenToken } from "./tokenStorage";

export type SessionStatus = "restoring" | "signedOut" | "signedIn";
export type SessionUser = ApiSchema<"UserOut">;
type AuthResponse = ApiSchema<"AuthResponse">;
type SignInPath = "/v1/auth/login" | "/v1/auth/register";

type SessionState = {
  status: SessionStatus;
  user: SessionUser | null;
  /** In memory only, never on disk. */
  accessToken: string | null;
  /** Epoch milliseconds. The token counts as expired ACCESS_TOKEN_SKEW_MS earlier. */
  accessTokenExpiresAt: number | null;
  /**
   * A sign-out could not delete the stored refresh token. The session is over in memory; restore
   * retries the delete before anything else and never signs in from that entry.
   */
  cleanupPending: boolean;
};

const SIGNED_OUT: SessionState = {
  status: "signedOut",
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
};
const RESTORING: SessionState = { ...SIGNED_OUT, status: "restoring" };

// Refresh this long before the server would reject the access token, so a request started near
// the expiry does not pay for a 401 round trip first.
const ACCESS_TOKEN_SKEW_MS = 30_000;
const MS_PER_SECOND = 1000;

export const sessionStore = createStore<SessionState>()(() => RESTORING);

/** The session as screens read it. Tokens never leave this module. */
export function useSession(): Pick<SessionState, "status" | "user" | "cleanupPending"> {
  return useStore(
    sessionStore,
    useShallow((state) => ({
      status: state.status,
      user: state.user,
      cleanupPending: state.cleanupPending,
    })),
  );
}

let queryClient: QueryClient | null = null;

/** Lets a sign-out drop every cached server response. Called once by the root layout. */
export function attachQueryClient(client: QueryClient): void {
  queryClient = client;
}

// Session generation. Every sign-in and sign-out starts a new one. Async work notes the generation
// it started in and applies its result (storage write or delete, memory update) only while that
// generation is still current; a result from an older generation is discarded, so a refresh
// released after a logout cannot bring the session back, and an old refresh's 401 cannot clear a
// newer login. Storage writes check the generation again as they run, inside the store's queue.
let generation = 0;
const nextGeneration = (): number => ++generation;
const isCurrent = (startedIn: number): boolean => startedIn === generation;

/** The generation an authenticated operation starts in; it binds every later step to that session. */
export const sessionGeneration = (): number => generation;

/** Whether the session an operation started in is still the one on the device. */
export const isCurrentGeneration = (startedIn: number): boolean => isCurrent(startedIn);

// Sign-out barrier. A sign-out begins synchronously: the generation moves on, memory and the Query
// cache are cleared and the barrier goes up, all before the stored token is deleted or the server
// is told. Auth work started behind the barrier (a token lookup, a refresh, a restore) is refused
// as superseded, so nothing started during a sign-out can acquire, refresh or restore the
// departing session, and nothing it carries can be applied once the sign-out completes. A newer
// sign-in moves the generation again, which lowers the barrier for it: the old sign-out finishing
// later does not touch the new session.
let signingOut: number | null = null;
const isSigningOut = (): boolean => signingOut === generation;

/** Refuses auth work started while the current session is signing out. */
function ensureNotSigningOut(): void {
  if (isSigningOut()) throw new SessionExpiredError("superseded");
}

/** Starts a sign-out: new generation, barrier up, memory and cache cleared. Synchronous on purpose. */
function beginSignOut(): number {
  const startedIn = nextGeneration();
  signingOut = startedIn;
  sessionStore.setState((state) => ({ ...SIGNED_OUT, cleanupPending: state.cleanupPending }));
  queryClient?.clear();
  return startedIn;
}

/**
 * Takes the stored token off the device, queued ahead of any storage work started later, and
 * records a failed delete as `cleanupPending` while the sign-out of `startedIn` is current.
 */
async function forgetStoredToken(startedIn: number): Promise<TakenToken> {
  const taken = await refreshTokenStorage.take();
  if (isCurrent(startedIn)) sessionStore.setState({ cleanupPending: !taken.deleted });
  return taken;
}

/** Lowers the barrier of the sign-out of `startedIn`; a newer sign-out keeps its own. */
function endSignOut(startedIn: number): void {
  if (signingOut === startedIn) signingOut = null;
}

/** Stores the pair for the session of `startedIn`; resolves to false when that session is gone. */
async function applyAuth(auth: AuthResponse, startedIn: number): Promise<boolean> {
  const written = await refreshTokenStorage.write(auth.refresh_token, () => isCurrent(startedIn));
  if (!written || !isCurrent(startedIn)) return false;
  sessionStore.setState({
    status: "signedIn",
    user: auth.user,
    accessToken: auth.access_token,
    accessTokenExpiresAt: Date.now() + auth.expires_in * MS_PER_SECOND,
    cleanupPending: false,
  });
  return true;
}

/** Asks the server to revoke a token family. Best effort: the device forgets it either way. */
async function revokeRemote(refreshToken: string): Promise<void> {
  try {
    await sendRequest<undefined>("POST", "/v1/auth/logout", {
      body: { refresh_token: refreshToken },
    });
  } catch {
    // Unreachable or already revoked: nothing more the client can do.
  }
}

async function signIn<P extends SignInPath>(path: P, body: PostBody<P>): Promise<void> {
  const startedIn = generation;
  const auth = await sendRequest<AuthResponse>("POST", path, { body });
  // A sign-out or another sign-in won while the request was in flight: the new server session is
  // not ours to keep.
  if (!isCurrent(startedIn)) {
    await revokeRemote(auth.refresh_token);
    throw new SessionExpiredError("superseded");
  }
  if (!(await applyAuth(auth, nextGeneration()))) {
    await revokeRemote(auth.refresh_token);
    throw new SessionExpiredError("superseded");
  }
}

export function register(body: PostBody<"/v1/auth/register">): Promise<void> {
  return signIn("/v1/auth/register", body);
}

export function login(body: PostBody<"/v1/auth/login">): Promise<void> {
  return signIn("/v1/auth/login", body);
}

/**
 * Ends the session. Memory and the Query cache are cleared before the first await; the stored
 * token is then deleted and revoked on the server (best effort), with the barrier up until the
 * revoke settles. Rejects with `LocalCleanupError` when the stored token could not be deleted;
 * `cleanupPending` is set in that case. A sign-in that completes meanwhile owns the session and
 * is left alone.
 */
export async function logout(): Promise<void> {
  const startedIn = beginSignOut();
  try {
    const { token, deleted } = await forgetStoredToken(startedIn);
    if (token) await revokeRemote(token);
    if (!deleted && isCurrent(startedIn)) throw new LocalCleanupError();
  } finally {
    endSignOut(startedIn);
  }
}

/** The server rejected the session of `startedIn`: forget it, unless a newer one replaced it. */
async function signOutIfCurrent(startedIn: number): Promise<void> {
  if (!isCurrent(startedIn)) return;
  const signingOutIn = beginSignOut();
  try {
    await forgetStoredToken(signingOutIn);
  } finally {
    endSignOut(signingOutIn);
  }
}

type RefreshInFlight = { generation: number; promise: Promise<string> };
let refreshInFlight: RefreshInFlight | null = null;

/**
 * Rotates the refresh token and resolves to the new access token. One refresh at a time per
 * session: every caller that needs one while it runs awaits the same promise, because two
 * refreshes with the same token make the server revoke the whole family. Refused during a
 * sign-out, since it would read the departing token.
 */
export async function refreshSession(): Promise<string> {
  ensureNotSigningOut();
  const inFlight =
    refreshInFlight?.generation === generation ? refreshInFlight : startRefresh(generation);
  return inFlight.promise;
}

function startRefresh(startedIn: number): RefreshInFlight {
  const promise = rotateRefreshToken(startedIn).finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { generation: startedIn, promise };
  return refreshInFlight;
}

async function rotateRefreshToken(startedIn: number): Promise<string> {
  if (sessionStore.getState().cleanupPending) throw new SessionExpiredError();
  const refreshToken = await refreshTokenStorage.read();
  if (!isCurrent(startedIn)) throw new SessionExpiredError("superseded");
  if (!refreshToken) {
    await signOutIfCurrent(startedIn);
    throw new SessionExpiredError();
  }

  let auth: AuthResponse;
  try {
    auth = await sendRequest<AuthResponse>("POST", "/v1/auth/refresh", {
      body: { refresh_token: refreshToken },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await signOutIfCurrent(startedIn);
      throw new SessionExpiredError();
    }
    // A network failure, a timeout or a 5xx: the session and the stored token stay.
    throw error;
  }

  if (!(await applyAuth(auth, startedIn))) {
    await revokeRemote(auth.refresh_token);
    throw new SessionExpiredError("superseded");
  }
  return auth.access_token;
}

/**
 * A usable access token: the one in memory while it is fresh, otherwise a refreshed one. Refused
 * during a sign-out, so a request started then never carries the departing credentials.
 */
export async function getAccessToken(): Promise<string> {
  ensureNotSigningOut();
  const { accessToken, accessTokenExpiresAt } = sessionStore.getState();
  const fresh =
    accessToken !== null &&
    accessTokenExpiresAt !== null &&
    Date.now() < accessTokenExpiresAt - ACCESS_TOKEN_SKEW_MS;
  return fresh ? accessToken : refreshSession();
}

/** Finishes a sign-out whose delete failed earlier. The entry is deleted, never signed in from. */
async function retryCleanup(startedIn: number): Promise<void> {
  const deleted = await refreshTokenStorage.clear().then(
    () => true,
    () => false,
  );
  if (isCurrent(startedIn)) sessionStore.setState({ ...SIGNED_OUT, cleanupPending: !deleted });
}

/**
 * Rebuilds the session from the stored refresh token on app start. With no token the user is
 * signed out. When the server cannot be reached, the token stays on disk for the next attempt and
 * the app routes as signed out meanwhile. A pending cleanup is finished first, never signed in from.
 * During a sign-out there is nothing to restore: memory already says signed out and the stored
 * token is on its way out, so it is not read.
 */
export async function restoreSession(): Promise<void> {
  if (isSigningOut()) return;
  const startedIn = generation;
  if (sessionStore.getState().cleanupPending) {
    await retryCleanup(startedIn);
    return;
  }
  const refreshToken = await refreshTokenStorage.read().catch(() => null);
  if (!isCurrent(startedIn)) return;
  if (!refreshToken) {
    sessionStore.setState(SIGNED_OUT);
    return;
  }
  try {
    await refreshSession();
  } catch (error) {
    if (!isCurrent(startedIn) || error instanceof SessionExpiredError) return;
    sessionStore.setState(SIGNED_OUT);
  }
}
