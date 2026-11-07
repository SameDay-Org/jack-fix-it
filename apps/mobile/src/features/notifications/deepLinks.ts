import type { QueryClient } from "@tanstack/react-query";
import type { Href } from "expo-router";

import type { SessionUser } from "@/api";
import { customerJobQueryOptions, isNoJobYet, jobHref } from "@/features/jobs/api";
import { opportunityQueryOptions } from "@/features/opportunities/useOpportunity";
import { proJobHref, proJobQueryOptions } from "@/features/pro-jobs/api";
import { quotesQueryOptions } from "@/features/quotes/useRequestQuotes";

/** An id as the API writes it into a push: a lowercase UUID (`_UUID` in `deep_links.py`). */
export const PUSH_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The paths a push may carry in `data.url`, `{id}` standing for an id: the app's copy of the API's
 * `ALLOWED_DEEP_LINKS` (`apps/api/app/modules/notifications/deep_links.py`), in its order. A test
 * reads that file and fails when the two differ, so a path the API adds is a decision here too.
 */
export const ALLOWED_PUSH_PATHS = [
  "/requests/{id}",
  "/requests/{id}/job",
  "/jobs/{id}",
  "/quotes/{id}",
  "/opportunities/{id}",
] as const;

export type PushPath = (typeof ALLOWED_PUSH_PATHS)[number];

/** One allowed path and the id it names. */
export type PushLink = { path: PushPath; id: string };

const MATCHERS = ALLOWED_PUSH_PATHS.map((path) => ({
  path,
  pattern: new RegExp(`^${path.replace("{id}", `(${PUSH_ID_PATTERN})`)}$`),
}));

/**
 * The allowed path a push's `data.url` names, matched whole like the API's `fullmatch`: no
 * scheme, host, query, fragment, trailing slash or escape. Null for anything else, a value that is
 * not a string included.
 */
export function parsePushLink(url: unknown): PushLink | null {
  if (typeof url !== "string") return null;
  for (const { path, pattern } of MATCHERS) {
    const id = pattern.exec(url)?.[1];
    if (id !== undefined) return { path, id };
  }
  return null;
}

type Role = SessionUser["role"];

/**
 * Where an allowed path opens, for which role, and how the app learns whether the signed-in
 * account may see it before opening it. A push carries no account, so asking the API with the
 * session on the device is the check: it answers 403 or 404 for anyone else's request, job or
 * dispatch. The answer also fills the cache the screen reads, so the screen opens with its data.
 */
type PushRoute = {
  role: Role;
  href: (id: string) => Href;
  probe: (client: QueryClient, id: string, generation: number) => Promise<unknown>;
};

const requestHref = (id: string): Href => ({ pathname: "/requests/[id]", params: { id } });
const opportunityHref = (id: string): Href => ({ pathname: "/opportunities/[id]", params: { id } });

/** Null where no screen opens that path yet: the push opens nothing. */
const ROUTES: Record<PushPath, PushRoute | null> = {
  // A new quote, a canceled booking: the request's comparison (#52).
  "/requests/{id}": {
    role: "customer",
    href: requestHref,
    probe: (client, id) => client.fetchQuery(quotesQueryOptions(id)),
  },
  // A job step: the customer's ongoing job (#64). A 404 there also means "no job yet", so the
  // request itself settles whose it is; the screen shows a job that is still being created.
  "/requests/{id}/job": {
    role: "customer",
    href: jobHref,
    probe: async (client, id, generation) => {
      try {
        return await client.fetchQuery(customerJobQueryOptions(id, generation));
      } catch (error) {
        if (!isNoJobYet(error)) throw error;
        return client.fetchQuery(quotesQueryOptions(id));
      }
    },
  },
  // A scheduled or confirmed job: the pro's job screen (#63).
  "/jobs/{id}": {
    role: "pro",
    href: proJobHref,
    probe: (client, id, generation) => client.fetchQuery(proJobQueryOptions(id, generation)),
  },
  // No screen opens one quote on its own yet.
  "/quotes/{id}": null,
  // A new request near the pro: the opportunity (#49). The quote-accepted push names it too, but
  // the API answers 404 for a dispatch already quoted, so that tap opens nothing (a follow-up).
  "/opportunities/{id}": {
    role: "pro",
    href: opportunityHref,
    probe: (client, id) => client.fetchQuery(opportunityQueryOptions(id)),
  },
};

/** The screen a push opens for an account of `role`; null when it opens none. */
export function pushRoute(link: PushLink | null, role: Role): PushRoute | null {
  const route = link ? ROUTES[link.path] : null;
  return route !== null && route.role === role ? route : null;
}
