import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";

import { ApiError, apiGet, apiPatch, apiPost, type GetResponse, type PostBody } from "@/api";

export type SavedAddress = GetResponse<"/v1/addresses">["items"][number];

export const SAVED_ADDRESSES_QUERY_KEY = ["addresses"] as const;

/**
 * The customer's saved addresses (D8.2, #214): at most four, one of them the default, each saying
 * whether its ZIP is served. A failure is shown with a retry, not retried behind a skeleton.
 */
export const useSavedAddresses = () =>
  useQuery({
    queryKey: SAVED_ADDRESSES_QUERY_KEY,
    queryFn: ({ signal }) => apiGet("/v1/addresses", { auth: true, signal }),
    retry: false,
  });

/**
 * Saves an address to the customer's book under its label (POST /v1/addresses). An address that
 * already has the label (an earlier try that saved it, then failed further on) is updated with
 * these fields instead, so the book holds what was typed last. The book is fetched again after
 * any answer, so a screen that lists it never shows a stale one.
 */
async function saveLabeledAddress(body: PostBody<"/v1/addresses">): Promise<void> {
  try {
    await apiPost("/v1/addresses", body, { auth: true });
    return;
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "address_label_taken")) throw error;
  }
  const { items } = await apiGet("/v1/addresses", { auth: true });
  const label = body.label.trim().toLowerCase();
  const existing = items.find((address) => address.label.trim().toLowerCase() === label);
  if (!existing) throw new ApiError(409, "address_label_taken");
  const { label: _label, line2, is_default: isDefault, ...fields } = body;
  await apiPatch(
    "/v1/addresses/{address_id}",
    { ...fields, line2: line2 ?? null, ...(isDefault ? { is_default: true as const } : {}) },
    { auth: true, params: { address_id: existing.id } },
  );
}

export function useSaveAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveLabeledAddress,
    onSettled: () => queryClient.invalidateQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY }),
  });
}
