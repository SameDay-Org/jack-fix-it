import { useMutation } from "@tanstack/react-query";

import { apiPatch, setSessionUser, type PatchBody } from "@/api";

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
