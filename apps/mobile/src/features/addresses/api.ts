import { useMutation, useQueryClient, useQuery, type QueryClient } from "@tanstack/react-query";
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
  type GetResponse,
  type PatchBody,
  type PostBody,
} from "@/api";
import { showToast } from "@/components/ui";

import { addressFailure, withAdded, withDefault, withoutAddress, withUpdated } from "./book";

type SavedAddressList = GetResponse<"/v1/addresses">;
export type SavedAddress = SavedAddressList["items"][number];

export const SAVED_ADDRESSES_QUERY_KEY = ["addresses"] as const;

/**
 * The customer's saved addresses (D8.2, #214): at most four, one of them the default, each saying
 * whether its ZIP is served. A failure is shown with a retry, not retried behind a skeleton.
 * `enabled: false` asks nothing (a pro keeps no addresses).
 */
export const useSavedAddresses = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: SAVED_ADDRESSES_QUERY_KEY,
    queryFn: ({ signal }) => apiGet("/v1/addresses", { auth: true, signal }),
    retry: false,
    enabled,
  });

/*
 * The address book's own writes (Account > Addresses). Each belongs to the session it was asked in
 * (`generation`): its request is never sent for another one, and neither its answer nor its
 * rollback touches the cache once that session is gone (the cache key has no session in it, and a
 * sign-out clears the cache). Delete and Make default draw on the cached book at once and put it
 * back if the server refuses; Add and Edit wait for the server, whose refusals (a label taken, a
 * contact detail in a label) belong in the form the customer is still looking at.
 */

/** Every write to the book, so the last one in flight is the one that settles it. */
const ADDRESS_WRITE_KEY = ["addresses", "write"] as const;

/** Applies `edit` to the cached book for the session that asked, if the book is cached. */
function drawBook(
  client: QueryClient,
  generation: number,
  edit: (book: SavedAddress[]) => SavedAddress[],
): void {
  if (!isCurrentGeneration(generation)) return;
  client.setQueryData<SavedAddressList>(SAVED_ADDRESSES_QUERY_KEY, (list) =>
    list ? { ...list, items: edit(list.items) } : list,
  );
}

/** Draws `edit` at once and returns the book before it, to put back if the write fails. */
async function drawOptimistic(
  client: QueryClient,
  generation: number,
  edit: (book: SavedAddress[]) => SavedAddress[],
): Promise<SavedAddressList | undefined> {
  if (!isCurrentGeneration(generation)) return undefined;
  // A GET in flight answers with the book from before this write: it would draw over it.
  await client.cancelQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY, exact: true });
  const previous = client.getQueryData<SavedAddressList>(SAVED_ADDRESSES_QUERY_KEY);
  drawBook(client, generation, edit);
  return previous;
}

/** Only this write is in flight: another one has drawn over the book since this one started. */
const lastWrite = (client: QueryClient) =>
  client.isMutating({ mutationKey: ADDRESS_WRITE_KEY }) <= 1;

/**
 * Puts the book back as it was before a failed write. With another write still in flight, the
 * refetch after that one settles the book instead: this snapshot would undo it too.
 */
function rollBack(
  client: QueryClient,
  generation: number,
  previous: SavedAddressList | undefined,
): void {
  if (!previous || !isCurrentGeneration(generation) || !lastWrite(client)) return;
  client.setQueryData<SavedAddressList>(SAVED_ADDRESSES_QUERY_KEY, previous);
}

/** Fetches the book again once the last write in flight is answered, for the session that asked. */
function refetchAfterLastWrite(client: QueryClient, generation: number): void {
  if (!isCurrentGeneration(generation) || !lastWrite(client)) return;
  // Not awaited: the mutation would hold its answer (and the busy button) until the refetch lands.
  void client.invalidateQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY, exact: true });
}

/** A new address for the book, for the session the form was sent in. */
export type CreateAddressVariables = { body: PostBody<"/v1/addresses">; generation: number };

/**
 * Adds an address to the book (POST /v1/addresses). A label the book already has is refused
 * (`address_label_taken`), never written over: that is the sign-up's `useSaveAddress`.
 */
export function useCreateAddress() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ADDRESS_WRITE_KEY,
    mutationFn: ({ body, generation }: CreateAddressVariables) =>
      apiPost("/v1/addresses", body, { auth: true, generation }),
    onSuccess: (address, { generation }) =>
      drawBook(client, generation, (book) => withAdded(book, address)),
    onSettled: (_address, _error, { generation }) => refetchAfterLastWrite(client, generation),
  });
}

/** The fields of one address to change, for the session the form was sent in. */
export type UpdateAddressVariables = {
  id: string;
  body: PatchBody<"/v1/addresses/{address_id}">;
  generation: number;
};

/** Changes an address of the book (PATCH); requests already sent from it keep their own copy. */
export function useUpdateAddress() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ADDRESS_WRITE_KEY,
    mutationFn: ({ id, body, generation }: UpdateAddressVariables) =>
      apiPatch("/v1/addresses/{address_id}", body, {
        auth: true,
        generation,
        params: { address_id: id },
      }),
    onSuccess: (address, { generation }) =>
      drawBook(client, generation, (book) => withUpdated(book, address)),
    onSettled: (_address, _error, { generation }) => refetchAfterLastWrite(client, generation),
  });
}

/** One address of the book to act on, for the session the action was asked in. */
type AddressActionVariables = { address: SavedAddress; generation: number };
type ActionContext = { previous: SavedAddressList | undefined };
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
  const { mutate } = useMutation<undefined, unknown, AddressActionVariables, ActionContext>({
    mutationKey: ADDRESS_WRITE_KEY,
    mutationFn: async ({ address, generation }) => {
      try {
        await apiDelete("/v1/addresses/{address_id}", {
          auth: true,
          generation,
          params: { address_id: address.id },
        });
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "address_not_found")) throw error;
      }
      return undefined;
    },
    onMutate: async ({ address, generation }) => ({
      previous: await drawOptimistic(client, generation, (book) =>
        withoutAddress(book, address.id),
      ),
    }),
    onSuccess: (_answer, { address, generation }) => {
      if (!isCurrentGeneration(generation)) return;
      AccessibilityInfo.announceForAccessibility(t("addresses.deleted", { label: address.label }));
    },
    onError: (error, variables, context) => {
      rollBack(client, variables.generation, context?.previous);
      toastFailure(t, error, "delete", variables);
    },
    onSettled: (_answer, _error, { generation }) => refetchAfterLastWrite(client, generation),
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
  const { mutate } = useMutation<SavedAddress, unknown, AddressActionVariables, ActionContext>({
    mutationKey: ADDRESS_WRITE_KEY,
    mutationFn: ({ address, generation }) =>
      apiPatch(
        "/v1/addresses/{address_id}",
        { is_default: true },
        { auth: true, generation, params: { address_id: address.id } },
      ),
    onMutate: async ({ address, generation }) => ({
      previous: await drawOptimistic(client, generation, (book) => withDefault(book, address.id)),
    }),
    onSuccess: (saved, { generation }) => {
      drawBook(client, generation, (book) => withUpdated(book, saved));
      if (!isCurrentGeneration(generation)) return;
      AccessibilityInfo.announceForAccessibility(
        t("addresses.madeDefault", { label: saved.label }),
      );
    },
    onError: (error, variables, context) => {
      rollBack(client, variables.generation, context?.previous);
      toastFailure(t, error, "makeDefault", variables);
    },
    onSettled: (_saved, _error, { generation }) => refetchAfterLastWrite(client, generation),
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
