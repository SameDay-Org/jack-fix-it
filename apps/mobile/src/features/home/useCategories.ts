import { useQuery } from "@tanstack/react-query";

import { apiGet, type GetResponse } from "@/api";
import { deviceLocale } from "@/features/auth/locale";

export type Category = GetResponse<"/v1/categories">[number];

export const CATEGORIES_QUERY_KEY = ["categories"] as const;

/**
 * The active categories, in the API's order. The catalog only changes by a staff edit, so one
 * load serves the whole session: going back to home, or a later screen reading the same list,
 * shows it at once with no refetch (sign-out clears the cache). A failure is shown with a retry
 * instead of retried behind a skeleton: the endpoint is rate limited per IP.
 */
export const useCategories = () =>
  useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }) => apiGet("/v1/categories", { signal }),
    staleTime: Infinity,
    retry: false,
  });

/** The name in the app's language, falling back to English (and to the slug if a name is missing). */
export function categoryName(category: Category): string {
  return category.names[deviceLocale()] ?? category.names.en ?? category.slug;
}
