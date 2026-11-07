import type { ApiSchema } from "@jack/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

import { ApiError, LocalCleanupError, NetworkError, SessionExpiredError } from "./errors";
import { sendRequest, type PostBody } from "./http";
import { onboardingMarkerStorage, refreshTokenStorage, type TakenToken } from "./tokenStorage";

export type SessionStatus = "restoring" | "signedOut" | "signedIn";
export type SessionUser = ApiSchema<"UserOut">;
/** Why the last restore left a stored token unused: the server could not be reached. */
export type RestoreFailure = "offline";
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
  /**
   * The last restore found a stored token but the server was unreachable (network, timeout or
   * 5xx), so the token stays for the next attempt. Set only there; cleared by a sign-in or a
   * sign-out.
   */
  restoreFailure: RestoreFailure | null;
  /**
   * The id of the account whose sign-up flow this device has not finished (#292), while that is
   * the signed-in account (or the one being restored): the gate keeps it on the flow. Set by a
   * sign-up, kept across relaunches, ended by `endOnboarding`, a sign-out or another account.
   */
  onboardingUserId: string | null;
};

const SIGNED_OUT: SessionState = {
  status: "signedOut",
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
const RESTORING: SessionState = { ...SIGNED_OUT, status: "restoring" };

// Refresh this long before the server would reject the access token, so a request started near
// the expiry does not pay for a 401 round trip first.
const ACCESS_TOKEN_SKEW_MS = 30_000;
const MS_PER_SECOND = 1000;

export const sessionStore = createStore<SessionState>()(() => RESTORING);

/** The session as screens read it. Tokens never leave this module. */
export function useSession(): Pick<
  SessionState,
  "status" | "user" | "cleanupPending" | "restoreFailure" | "onboardingUserId"
> {
  return useStore(
    sessionStore,
    useShallow((state) => ({
      status: state.status,
      user: state.user,
      cleanupPending: state.cleanupPending,
      restoreFailure: state.restoreFailure,
      onboardingUserId: state.onboardingUserId,
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

/**
 * The current generation for a screen that must leave once the session its data belongs to is gone
 * (every sign-in and sign-out moves it, and each updates the session store).
 */
export const useSessionGeneration = (): number => useStore(sessionStore, () => generation);

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

// What features keep of a session outside the Query cache (a sent request's confirmation, a
// request draft), forgotten with the cache.
const sessionDataForgetters = new Set<() => void>();

/**
 * Registers `forget` for data a feature keeps of the signed-in account outside the Query cache. It
 * runs with the cache clear at the start of every sign-out, and when a sign-in brings another
 * account. Returns the unregister.
 */
export function onSignOut(forget: () => void): () => void {
  sessionDataForgetters.add(forget);
  return () => {
    sessionDataForgetters.delete(forget);
  };
}

function forgetSessionData(): void {
  queryClient?.clear();
  for (const forget of sessionDataForgetters) forget();
}

/** Starts a sign-out: new generation, barrier up, memory and cache cleared. Synchronous on purpose. */
function beginSignOut(): number {
  const startedIn = nextGeneration();
  signingOut = startedIn;
  sessionStore.setState((state) => ({ ...SIGNED_OUT, cleanupPending: state.cleanupPending }));
  forgetSessionData();
  return startedIn;
}

/**
 * Takes the stored token off the device, queued ahead of any storage work started later, and
 * records a failed delete as `cleanupPending` while the sign-out of `startedIn` is current. The
 * onboarding marker goes with it: a later sign-in is never forced back into the flow.
 */
async function forgetStoredToken(startedIn: number): Promise<TakenToken> {
  const taken = await refreshTokenStorage.take();
  await onboardingMarkerStorage.clear();
  if (isCurrent(startedIn)) sessionStore.setState({ cleanupPending: !taken.deleted });
  return taken;
}

/** Lowers the barrier of the sign-out of `startedIn`; a newer sign-out keeps its own. */
function endSignOut(startedIn: number): void {
  if (signingOut === startedIn) signingOut = null;
}

/**
 * Stores the pair for the session of `startedIn`; resolves to false when that session is gone.
 * With `onboarding`, the account enters its sign-up flow in the same update that signs it in, so
 * no render sees it signed in and off the flow. Otherwise the marker follows the account: the one
 * being restored (or signing in again) keeps its own, and another account ends it.
 */
async function applyAuth(
  auth: AuthResponse,
  startedIn: number,
  onboarding = false,
): Promise<boolean> {
  const written = await refreshTokenStorage.write(auth.refresh_token, () => isCurrent(startedIn));
  if (!written || !isCurrent(startedIn)) return false;
  const previous = sessionStore.getState();
  if (previous.user && previous.user.id !== auth.user.id) forgetSessionData();
  const onboardingUserId =
    onboarding || previous.onboardingUserId === auth.user.id ? auth.user.id : null;
  sessionStore.setState({
    status: "signedIn",
    user: auth.user,
    accessToken: auth.access_token,
    accessTokenExpiresAt: Date.now() + auth.expires_in * MS_PER_SECOND,
    cleanupPending: false,
    restoreFailure: null,
    onboardingUserId,
  });
  if (onboarding) {
    // Best effort, behind the token in the store's queue: without it the flow does not resume
    // after a relaunch, and nothing else is lost.
    void onboardingMarkerStorage
      .write(auth.user.id, () => isCurrent(startedIn))
      .catch(() => undefined);
  } else if (previous.onboardingUserId !== null && onboardingUserId === null) {
    void onboardingMarkerStorage.clear();
  }
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

async function signIn<P extends SignInPath>(
  path: P,
  body: PostBody<P>,
  onboarding = false,
): Promise<void> {
  const startedIn = generation;
  const auth = await sendRequest<AuthResponse>("POST", path, { body });
  // A sign-out or another sign-in won while the request was in flight: the new server session is
  // not ours to keep.
  if (!isCurrent(startedIn)) {
    await revokeRemote(auth.refresh_token);
    throw new SessionExpiredError("superseded");
  }
  if (!(await applyAuth(auth, nextGeneration(), onboarding))) {
    await revokeRemote(auth.refresh_token);
    throw new SessionExpiredError("superseded");
  }
  // A login never resumes a sign-up flow: a marker that a failed delete left on the device goes
  // now, before a relaunch could read it.
  if (!onboarding) void onboardingMarkerStorage.clear();
}

/**
 * Replaces the signed-in user with a fresher copy from the server (after a phone verification).
 * Applied only to the same account while it is still signed in: a response that lands after a
 * sign-out or another sign-in is dropped.
 */
export function setSessionUser(user: SessionUser): void {
  const state = sessionStore.getState();
  if (state.status !== "signedIn" || state.user?.id !== user.id) return;
  sessionStore.setState({ user });
}

export type RegisterOptions = {
  /**
   * The new account enters the sign-up flow (#292): the gate keeps it on the flow, on this device
   * and across relaunches, until `endOnboarding`.
   */
  onboarding?: boolean;
};

export function register(
  body: PostBody<"/v1/auth/register">,
  options: RegisterOptions = {},
): Promise<void> {
  return signIn("/v1/auth/register", body, options.onboarding ?? false);
}

/**
 * The signed-in account finished its sign-up flow: the gate shows the app from the next update,
 * and the device forgets the marker. Memory first, so the screen moves on even if the delete
 * fails; a marker left on disk is cleared again when the finished flow is next restored.
 */
export async function endOnboarding(): Promise<void> {
  sessionStore.setState({ onboardingUserId: null });
  await onboardingMarkerStorage.clear();
}

export function login(body: PostBody<"/v1/auth/login">): Promise<void> {
  return signIn("/v1/auth/login", body);
}

// Work a feature must finish with the departing session's credentials, before a person's logout
// clears them (the push token's removal, #334).
type SignOutTask = { run: () => Promise<void>; timeoutMs: number };
const signOutTasks = new Set<SignOutTask>();
let tasksInFlight: { generation: number; promise: Promise<void> } | null = null;

/**
 * Registers `run` for every logout of a signed-in session: it runs before anything is cleared,
 * while the session can still call the API (each call pinned to it), and the logout waits for it
 * at most `timeoutMs`. Best effort: a failure or a timeout never stops the sign-out, and a session
 * the server ended (an expired refresh) has no credentials left to run it with. Returns the
 * unregister.
 */
export function beforeSignOut(
  run: () => Promise<void>,
  options: { timeoutMs: number },
): () => void {
  const task: SignOutTask = { run, timeoutMs: options.timeoutMs };
  signOutTasks.add(task);
  return () => {
    signOutTasks.delete(task);
  };
}

/** Settles when `task` does or after its `timeoutMs`, whichever comes first; never rejects. */
function runBounded(task: SignOutTask): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, task.timeoutMs);
    Promise.resolve()
      .then(task.run)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * The tasks of a logout, or null when there is nothing to wait for (no task, or no signed-in
 * session to run them with). A second logout while they run waits for the same ones.
 */
function runSignOutTasks(): Promise<void> | null {
  if (signOutTasks.size === 0 || sessionStore.getState().status !== "signedIn") return null;
  if (tasksInFlight?.generation === generation) return tasksInFlight.promise;
  const promise = Promise.all([...signOutTasks].map(runBounded)).then(() => {
    if (tasksInFlight?.promise === promise) tasksInFlight = null;
  });
  tasksInFlight = { generation, promise };
  return promise;
}

/**
 * Ends the session. What `beforeSignOut` registered runs first, while the session is still signed
 * in (each task bounded; with none, nothing is awaited). Then memory, the Query cache and what
 * `onSignOut` registered are cleared before the next await; the stored token is deleted and
 * revoked on the server (best effort), with the barrier up until the revoke settles. Rejects with
 * `LocalCleanupError` when the stored token could not be deleted; `cleanupPending` is set in that
 * case. A sign-in that completes meanwhile owns the session and is left alone.
 */
export function logout(): Promise<void> {
  const tasks = runSignOutTasks();
  return tasks ? tasks.then(endSession) : endSession();
}

async function endSession(): Promise<void> {
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
  await onboardingMarkerStorage.clear();
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
  // Known before the session can be signed in, so the gate's first signed-in render already
  // holds the account on its flow (no app screen in between).
  const onboardingUserId = await onboardingMarkerStorage.read();
  if (!isCurrent(startedIn)) return;
  sessionStore.setState({ onboardingUserId });
  try {
    await refreshSession();
  } catch (error) {
    if (!isCurrent(startedIn) || error instanceof SessionExpiredError) return;
    sessionStore.setState({
      ...SIGNED_OUT,
      restoreFailure: isServerUnreachable(error) ? "offline" : null,
    });
  }
}

const SERVER_ERROR_MIN_STATUS = 500;

/** No answer, a timeout or a server failure: the session may well be valid, the device just cannot tell. */
function isServerUnreachable(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (error instanceof ApiError && error.status >= SERVER_ERROR_MIN_STATUS)
  );
}
