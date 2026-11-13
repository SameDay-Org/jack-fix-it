import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  isCurrentGeneration,
  sessionGeneration,
  type PostBody,
} from "@/api";
import { showToast } from "@/components/ui";

import {
  addressFailure,
  withAdded,
  withDefault,
  withFields,
  withoutAddress,
  type AddressEdit,
} from "./book";
import {
  answerWrite,
  dropWrite,
  openWrite,
  SAVED_ADDRESSES_QUERY_KEY,
  type OpenWrite,
  type SavedAddress,
  type SavedBook,
} from "./bookCache";

export { SAVED_ADDRESSES_QUERY_KEY };
export type { SavedAddress, SavedBook };

/**
 * The customer's saved addresses (D8.2, #214): at most four, one of them the default, each saying
 * whether its ZIP is served. A failure is shown with a retry, not retried behind a skeleton.
 * `enabled: false` asks nothing (a pro keeps no addresses).
 */
export const useSavedAddresses = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: SAVED_ADDRESSES_QUERY_KEY,
    queryFn: ({ signal }): Promise<SavedBook> => apiGet("/v1/addresses", { auth: true, signal }),
    retry: false,
    enabled,
  });

/*
 * The address book's own writes (Account > Addresses). Each belongs to the session it was asked in
 * (`generation`): its request is never sent for another one, and its answer touches nothing once
 * that session is gone (the cache key has no session in it, and a sign-out clears the cache).
 * Delete and Make default show on the book at once and leave it if the server refuses; Add and
 * Edit wait for the server, whose refusals (a label taken, a contact detail in a label) belong in
 * the form the customer is still looking at. Two of them can be in flight at once, so none
 * patches the cached book itself: each is asked, then answered or dropped, in `bookCache`, which
 * draws the book from what the server listed and the writes asked since, and fetches it again
 * once the last one is answered.
 */

/** A write's place among the ones in flight; none when the book was not cached to draw on. */
type WriteContext = { write: OpenWrite | undefined };

/** A new address for the book, for the session the form was sent in. */
export type CreateAddressVariables = { body: PostBody<"/v1/addresses">; generation: number };

/**
 * Adds an address to the book (POST /v1/addresses). A label the book already has is refused
 * (`address_label_taken`), never written over: that is the sign-up's `useSaveAddress`.
 */
export function useCreateAddress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ body, generation }: CreateAddressVariables) =>
      apiPost("/v1/addresses", body, { auth: true, generation }),
    onMutate: ({ generation }): WriteContext => ({ write: openWrite(client, generation) }),
    onSuccess: (address, { generation }, context) =>
      answerWrite(client, generation, context.write, (book) => withAdded(book, address)),
    onError: (_error, { generation }, context) => dropWrite(client, generation, context?.write),
  });
}

/**
 * The fields of one address to change, for the session the form was sent in. Never who is the
 * default: that is `useMakeDefaultAddress`.
 */
export type UpdateAddressVariables = { id: string; body: AddressEdit; generation: number };

/**
 * Changes an address of the book (PATCH); requests already sent from it keep their own copy. Of
 * the answer, the book takes what the fields of `body` set, nothing else (`withFields`).
 */
export function useUpdateAddress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, generation }: UpdateAddressVariables) =>
      apiPatch("/v1/addresses/{address_id}", body, {
        auth: true,
        generation,
        params: { address_id: id },
      }),
    onMutate: ({ generation }): WriteContext => ({ write: openWrite(client, generation) }),
    onSuccess: (address, { body, generation }, context) =>
      answerWrite(client, generation, context.write, (book) => withFields(book, address, body)),
    onError: (_error, { generation }, context) => dropWrite(client, generation, context?.write),
  });
}

/** One address of the book to act on, for the session the action was asked in. */
type AddressActionVariables = { address: SavedAddress; generation: number };
type BookAction = "delete" | "makeDefault";

/**
 * Says why an optimistic action did not stick. A toast, since the sheet that asked has closed;
 * for the session that asked only.
 */
function toastFailure(
  t: TFunction,
  error: unknown,
  action: BookAction,
  { address, generation }: AddressActionVariables,
): void {
  if (!isCurrentGeneration(generation)) return;
  const failure = addressFailure(error);
  const message =
    failure === "offline" || failure === "rateLimited" || failure === "gone"
      ? t(`addresses.failed.${failure}`)
      : t(`addresses.failed.${action}`, { label: address.label });
  showToast({ message, tone: "danger" });
}

/**
 * Deletes an address of the book (DELETE): it leaves the list at once and comes back if the server
 * refuses. One already gone (`address_not_found`, deleted on another device) counts as deleted.
 * Returns the action: `deleteAddress(address)`.
 */
export function useDeleteAddress() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { mutate } = useMutation<undefined, unknown, AddressActionVariables, WriteContext>({
    mutationFn: async ({ address, generation }) => {
      try {
        await apiDelete("/v1/addresses/{address_id}", undefined, {
          auth: true,
          generation,
          params: { address_id: address.id },
        });
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "address_not_found")) throw error;
      }
      return undefined;
    },
    onMutate: ({ address, generation }) => ({
      write: openWrite(client, generation, (book) => withoutAddress(book, address.id)),
    }),
    onSuccess: (_answer, { address, generation }, context) => {
      answerWrite(client, generation, context.write, (book) => withoutAddress(book, address.id));
      if (!isCurrentGeneration(generation)) return;
      AccessibilityInfo.announceForAccessibility(t("addresses.deleted", { label: address.label }));
    },
    onError: (error, variables, context) => {
      dropWrite(client, variables.generation, context?.write);
      toastFailure(t, error, "delete", variables);
    },
  });
  return (address: SavedAddress) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    mutate({ address, generation: sessionGeneration() });
  };
}

/**
 * Makes an address the default (PATCH `is_default: true`): it moves to the top with the Default
 * chip at once, and back if the server refuses. Returns the action: `makeDefault(address)`.
 */
export function useMakeDefaultAddress() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { mutate } = useMutation<SavedAddress, unknown, AddressActionVariables, WriteContext>({
    mutationFn: ({ address, generation }) =>
      apiPatch(
        "/v1/addresses/{address_id}",
        { is_default: true },
        { auth: true, generation, params: { address_id: address.id } },
      ),
    onMutate: ({ address, generation }) => ({
      write: openWrite(client, generation, (book) => withDefault(book, address.id)),
    }),
    onSuccess: (saved, { generation }, context) => {
      // Of its answer, the chip alone: the request sent nothing else, and the other fields are
      // the address as it was then, which an edit in flight may have changed by now.
      answerWrite(client, generation, context.write, (book) => withDefault(book, saved.id));
      if (!isCurrentGeneration(generation)) return;
      AccessibilityInfo.announceForAccessibility(
        t("addresses.madeDefault", { label: saved.label }),
      );
    },
    onError: (error, variables, context) => {
      dropWrite(client, variables.generation, context?.write);
      toastFailure(t, error, "makeDefault", variables);
    },
  });
  return (address: SavedAddress) => {
    void Haptics.selectionAsync();
    mutate({ address, generation: sessionGeneration() });
  };
}

/**
 * An address to save under its label, and the session generation of the operation it belongs to
 * (`generation`, see `RequestOptions`): every request of the save is that session's.
 */
export type SaveAddressVariables = { body: PostBody<"/v1/addresses">; generation?: number };

/**
 * Saves an address to the customer's book under its label (POST /v1/addresses). An address that
 * already has the label (an earlier try that saved it, then failed further on) is updated with
 * these fields instead, so the book holds what was typed last. The book is fetched again after
 * any answer, so a screen that lists it never shows a stale one. The POST, the GET and the PATCH
 * all belong to the session the save started in: after a sign-out or another sign-in none of the
 * later ones is sent.
 */
async function saveLabeledAddress({
  body,
  generation = sessionGeneration(),
}: SaveAddressVariables): Promise<void> {
  try {
    await apiPost("/v1/addresses", body, { auth: true, generation });
    return;
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "address_label_taken")) throw error;
  }
  const { items } = await apiGet("/v1/addresses", { auth: true, generation });
  const label = body.label.trim().toLowerCase();
  const existing = items.find((address) => address.label.trim().toLowerCase() === label);
  if (!existing) throw new ApiError(409, "address_label_taken");
  const { label: _label, line2, is_default: isDefault, ...fields } = body;
  await apiPatch(
    "/v1/addresses/{address_id}",
    { ...fields, line2: line2 ?? null, ...(isDefault ? { is_default: true as const } : {}) },
    { auth: true, generation, params: { address_id: existing.id } },
  );
}

export function useSaveAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveLabeledAddress,
    onSettled: () => queryClient.invalidateQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY }),
  });
}
