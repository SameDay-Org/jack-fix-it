import { useEffect } from "react";
import { Image } from "react-native";

import {
  apiGet,
  isCurrentGeneration,
  sessionGeneration,
  setSessionUser,
  type SessionUser,
} from "@/api";

/*
 * The signed-in user lives in the session store, not in the Query cache: a cached copy of
 * `/auth/me` would be a second source of truth for the same person. So this is a plain call whose
 * answer goes back to the session (`setSessionUser`), as the phone flow's does.
 */

/** The signed-in user again, from the server: the ID photo comes with a fresh presigned URL. */
export const fetchMe = (signal: AbortSignal) => apiGet("/v1/auth/me", { auth: true, signal });

/**
 * The ID photo's URL is presigned for a few minutes only (the API's `DOWNLOAD_URL_TTL_SECONDS`),
 * and the session's copy comes from sign-in or the launch. Each time the screen gains focus with
 * an expired one, this asks for the user again and puts the answer in the session once the new
 * photo is already in the image cache, so the card swaps one picture for the same picture
 * instead of blinking. Failing quietly: the card keeps what it shows (the photo it already
 * loaded, or the silhouette), and the next focus tries again.
 */
export function useFreshPhoto(user: SessionUser, focused: boolean): void {
  const expiresAt = user.photo?.expires_at;

  useEffect(() => {
    if (!focused || expiresAt === undefined || Date.parse(expiresAt) > Date.now()) return;
    const controller = new AbortController();
    const startedIn = sessionGeneration();
    void (async () => {
      try {
        const fresh = await fetchMe(controller.signal);
        if (fresh.photo) await Image.prefetch(fresh.photo.url).catch(() => false);
        if (controller.signal.aborted || !isCurrentGeneration(startedIn)) return;
        setSessionUser(fresh);
      } catch {
        // Offline or signed out meanwhile: nothing to show, the next focus tries again.
      }
    })();
    return () => controller.abort();
  }, [focused, expiresAt]);
}
