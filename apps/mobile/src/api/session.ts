import type { ApiSchema } from "@jack/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

import { ApiError, SessionExpiredError } from "./errors";
import { sendRequest, type PostBody, type PostResponse } from "./http";
import { refreshTokenStorage } from "./tokenStorage";

export type SessionStatus = "restoring" | "signedOut" | "signedIn";
export type SessionUser = ApiSchema<"UserOut">;
type AuthResponse = ApiSchema<"AuthResponse">;

type SessionState = {
  status: SessionStatus;
  user: SessionUser | null;
  /** In memory only, never on disk. */
  accessToken: string | null;
  /** Epoch milliseconds. The token counts as expired ACCESS_TOKEN_SKEW_MS earlier. */
  accessTokenExpiresAt: number | null;
};

const SIGNED_OUT: SessionState = {
  status: "signedOut",
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
};
const RESTORING: SessionState = { ...SIGNED_OUT, status: "restoring" };

// Refresh this long before the server would reject the access token, so a request started near
// the expiry does not pay for a 401 round trip first.
const ACCESS_TOKEN_SKEW_MS = 30_000;
const MS_PER_SECOND = 1000;

export const sessionStore = createStore<SessionState>()(() => RESTORING);

/** The session as screens read it: status and user. Tokens never leave this module. */
export function useSession(): Pick<SessionState, "status" | "user"> {
  return useStore(
    sessionStore,
    useShallow((state) => ({ status: state.status, user: state.user })),
  );
}

let queryClient: QueryClient | null = null;

/** Lets a sign-out drop every cached server response. Called once by the root layout. */
export function attachQueryClient(client: QueryClient): void {
  queryClient = client;
}

async function applyAuth(auth: AuthResponse): Promise<void> {
  await refreshTokenStorage.write(auth.refresh_token);
  sessionStore.setState({
    status: "signedIn",
    user: auth.user,
    accessToken: auth.access_token,
    accessTokenExpiresAt: Date.now() + auth.expires_in * MS_PER_SECOND,
  });
}

async function clearSession(): Promise<void> {
  try {
    await refreshTokenStorage.clear();
  } catch {
    // The entry could not be deleted right now; the memory and the cache are cleared regardless,
    // and the next sign-in overwrites it.
  }
  sessionStore.setState(SIGNED_OUT);
  queryClient?.clear();
}

export async function register(body: PostBody<"/v1/auth/register">): Promise<void> {
  const auth = await sendRequest<PostResponse<"/v1/auth/register">>("POST", "/v1/auth/register", {
    body,
  });
  await applyAuth(auth);
}

export async function login(body: PostBody<"/v1/auth/login">): Promise<void> {
  const auth = await sendRequest<PostResponse<"/v1/auth/login">>("POST", "/v1/auth/login", {
    body,
  });
  await applyAuth(auth);
}

/** Tells the server, best effort, then forgets the session on the device whatever the answer. */
export async function logout(): Promise<void> {
  const refreshToken = await refreshTokenStorage.read().catch(() => null);
  if (refreshToken) {
    try {
      await sendRequest<PostResponse<"/v1/auth/logout">>("POST", "/v1/auth/logout", {
        body: { refresh_token: refreshToken },
      });
    } catch {
      // The server revokes the family when it can; the device forgets either way.
    }
  }
  await clearSession();
}

let refreshInFlight: Promise<string> | null = null;

/**
 * Rotates the refresh token and resolves to the new access token. One refresh at a time: every
 * caller that needs one while it runs awaits the same promise, because two refreshes with the same
 * token make the server revoke the whole session.
 */
export function refreshSession(): Promise<string> {
  refreshInFlight ??= rotateRefreshToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function rotateRefreshToken(): Promise<string> {
  const refreshToken = await refreshTokenStorage.read();
  if (!refreshToken) {
    await clearSession();
    throw new SessionExpiredError();
  }
  try {
    const auth = await sendRequest<PostResponse<"/v1/auth/refresh">>("POST", "/v1/auth/refresh", {
      body: { refresh_token: refreshToken },
    });
    await applyAuth(auth);
    return auth.access_token;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await clearSession();
      throw new SessionExpiredError();
    }
    // A network failure, a timeout or a 5xx: the session and the stored token stay.
    throw error;
  }
}

/** A usable access token: the one in memory while it is fresh, otherwise a refreshed one. */
export async function getAccessToken(): Promise<string> {
  const { accessToken, accessTokenExpiresAt } = sessionStore.getState();
  const fresh =
    accessToken !== null &&
    accessTokenExpiresAt !== null &&
    Date.now() < accessTokenExpiresAt - ACCESS_TOKEN_SKEW_MS;
  return fresh ? accessToken : refreshSession();
}

/**
 * Rebuilds the session from the stored refresh token on app start. With no token the user is
 * signed out. When the server cannot be reached, the token stays on disk for the next attempt and
 * the app routes as signed out meanwhile.
 */
export async function restoreSession(): Promise<void> {
  const refreshToken = await refreshTokenStorage.read().catch(() => null);
  if (!refreshToken) {
    sessionStore.setState(SIGNED_OUT);
    return;
  }
  try {
    await refreshSession();
  } catch (error) {
    if (error instanceof SessionExpiredError) return; // already signed out and cleared
    sessionStore.setState(SIGNED_OUT);
  }
}
