import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import { createElement, type ReactElement, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { SessionUser } from "@/api";
import type { Category } from "@/features/home/useCategories";

import { user } from "../../../api/__tests__/helpers";
import { METRICS, SIGNED_OUT } from "../../auth/__tests__/helpers";

/**
 * A fresh cache per test, as the app's root builds one per start. Kept entries never expire here:
 * the garbage-collection timer would outlive the test.
 */
export const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

/**
 * Renders a screen under the safe area (the test file mocks the module) and a Query cache, as a
 * wrapper so `rerender` keeps both.
 */
export const renderWithQuery = (ui: ReactElement, client: QueryClient = newQueryClient()) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(QueryClientProvider, { client }, children),
      ),
  });

const { accessToken: _a, accessTokenExpiresAt: _b, ...SESSION_FIELDS } = SIGNED_OUT;

/** What `useSession()` returns for a signed-in user (the access token is not part of it). */
export const signedIn = (overrides: Partial<SessionUser> = {}) => ({
  ...SESSION_FIELDS,
  status: "signedIn" as const,
  user: { ...user, ...overrides },
});

const category = (slug: string, names: Record<string, string>, index: number): Category => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  slug,
  names,
  icon: null,
  requires_license: false,
  intake_questions: [],
});

/** The launch catalog as the API orders it; moving-assembly has no Spanish name. */
export const CATEGORIES: Category[] = [
  category("house-cleaning", { en: "House Cleaning", es: "Limpieza del hogar" }, 1),
  category("handyman", { en: "Handyman", es: "Reparaciones generales" }, 2),
  category("painting", { en: "Painting", es: "Pintura" }, 3),
  category("lawn-landscaping", { en: "Lawn & Landscaping", es: "Jardinería y paisajismo" }, 4),
  category("moving-assembly", { en: "Moving & Assembly" }, 5),
];
