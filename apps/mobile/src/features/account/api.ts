import { useIsMutating, useMutation, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Image } from "react-native";

import {
  apiGet,
  apiPatch,
  isCurrentGeneration,
  sessionGeneration,
  setSessionUser,
  type PatchBody,
  type SessionUser,
} from "@/api";
import type { Language } from "@/i18n";

/** PATCH /v1/auth/me: the fields to change, the rest left as they are. */
export type MeUpdate = PatchBody<"/v1/auth/me">;

/**
 * The fields, and the session generation of the operation the update belongs to (`generation`,
 * see `RequestOptions`): an update a step of a longer save is never sent for the next session.
 */
export type MeUpdateVariables = { body: MeUpdate; generation?: number };

/**
 * Updates the signed-in account's own names and ID card fields (#165, #250). On success the
 * session's user becomes the server's copy, so every screen reading it shows the change at once.
 */
export function useUpdateMe() {
  return useMutation({
    mutationFn: ({ body, generation }: MeUpdateVariables) =>
      apiPatch("/v1/auth/me", body, { auth: true, generation }),
    onSuccess: (user) => setSessionUser(user),
  });
}

const LOCALE_SAVE_KEY = ["account", "locale"] as const;

/** The language to save, and the session generation it was chosen in. */
export type LocaleSave = { locale: Language; generation: number };

/**
 * Saves the app's language to the account (#218), where the server reads it for what it sends.
 * Saves run one at a time, in the order they were chosen (`scope`): the account ends on the last
 * choice and the session on the last answer, whatever the network did to the ones before. Each is
 * pinned to the session it was chosen in, so one still waiting its turn is never sent for the
 * next account.
 */
export function useSaveLocale() {
  return useMutation({
    mutationKey: LOCALE_SAVE_KEY,
    scope: { id: LOCALE_SAVE_KEY.join(".") },
    mutationFn: ({ locale, generation }: LocaleSave) =>
      apiPatch("/v1/auth/me", { locale }, { auth: true, generation }),
    onSuccess: (user) => setSessionUser(user),
  });
}

/** Whether a language save is on its way or waiting its turn, whichever screen started it. */
export const useLocaleSaving = (): boolean => useIsMutating({ mutationKey: LOCALE_SAVE_KEY }) > 0;

/** The same, read at once (in an effect), not on the next render. */
export const isSavingLocale = (client: QueryClient): boolean =>
  client.isMutating({ mutationKey: LOCALE_SAVE_KEY }) > 0;

/*
 * The signed-in user lives in the session store, not in the Query cache: a cached copy of
 * `/auth/me` would be a second source of truth for the same person. So this is a plain call whose
 * answer goes back to the session (`setSessionUser`), as the phone flow's does.
 */

/** The signed-in user again, from the server: the ID photo comes with a fresh presigned URL. */
export const fetchMe = (signal: AbortSignal) => apiGet("/v1/auth/me", { auth: true, signal });

/**
 * A URL this close to its expiry counts as expired: an image not loaded yet (the share render's)
 * would start loading just as the signature runs out.
 */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * The ID photo's URL is presigned for a few minutes only (the API's `DOWNLOAD_URL_TTL_SECONDS`),
 * and the session's copy comes from sign-in or the launch. Each time the screen gains focus with
 * an expired one, this asks for the user again and puts the answer in the session once the new
 * photo is already in the image cache, so the card swaps one picture for the same picture
 * instead of blinking. Failing quietly: the card keeps what it shows (the photo it already
 * loaded, or the silhouette), and the next focus tries again. At most one refresh per focus: a
 * device clock ahead of the server would read every fresh URL as expired and ask forever.
 */
export function useFreshPhoto(user: SessionUser, focused: boolean): void {
  const expiresAt = user.photo?.expires_at;
  const refreshed = useRef(false);

  useEffect(() => {
    if (!focused) {
      refreshed.current = false;
      return;
    }
    if (refreshed.current || expiresAt === undefined) return;
    if (Date.parse(expiresAt) - EXPIRY_MARGIN_MS > Date.now()) return;
    refreshed.current = true;
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
