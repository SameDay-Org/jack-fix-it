import type { QueryClient } from "@tanstack/react-query";
import type { Href } from "expo-router";

import type { SessionUser } from "@/api";
import { chatHref } from "@/features/chat/api";
import { customerJobQueryOptions, isNoJobYet, jobHref } from "@/features/jobs/api";
import type { CustomerJob } from "@/features/jobs/phase";
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
  "/",
  // A new chat message (#73): the pro's chat of a job, and the customer's, named by their request
  // (the chat route takes the job's id, which the customer's job read gives).
  "/jobs/{id}/chat",
  "/requests/{id}/job/chat",
] as const;

export type PushPath = (typeof ALLOWED_PUSH_PATHS)[number];

/** The signed-in account's Home (#338): the one allowed path that names no id. */
export const HOME_PUSH_PATH = "/";

type IdPushPath = Exclude<PushPath, typeof HOME_PUSH_PATH>;

/** One allowed path and the id it names; Home names none. */
export type PushLink = { path: IdPushPath; id: string } | { path: typeof HOME_PUSH_PATH; id: null };

const MATCHERS = ALLOWED_PUSH_PATHS.filter(
  (path): path is IdPushPath => path !== HOME_PUSH_PATH,
).map((path) => ({
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
  if (url === HOME_PUSH_PATH) return { path: HOME_PUSH_PATH, id: null };
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
  probe: (client: QueryClient, id: string, generation: number) => Promise<unknown>;
  /** The screen to open, from the link's id and the probe's answer (none when it failed). */
  href: (id: string, answer?: unknown) => Href;
  /**
   * The pathname that screen shows, to leave it as it is when it is already on top. The link
   * itself when omitted: an allowed path is its screen's own pathname (`/jobs/<id>`).
   */
  path?: (id: string, answer?: unknown) => string;
};

/** The customer's job a probe answered with, if it did (a failed probe answers nothing). */
const answeredJob = (answer: unknown): CustomerJob | null =>
  typeof answer === "object" && answer !== null && "id" in answer && typeof answer.id === "string"
    ? (answer as CustomerJob)
    : null;

const requestHref = (id: string): Href => ({ pathname: "/requests/[id]", params: { id } });
const opportunityHref = (id: string): Href => ({ pathname: "/opportunities/[id]", params: { id } });

/** Null where no screen opens that path yet: the push opens nothing. */
const ROUTES: Record<IdPushPath, PushRoute | null> = {
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
  // A message from the customer (#73): the pro's chat of the job. The job read the chat's header
  // reads (the customer's name, whether the chat is closed) is the check.
  "/jobs/{id}/chat": {
    role: "pro",
    href: (id) => chatHref(id),
    probe: (client, id, generation) => client.fetchQuery(proJobQueryOptions(id, generation)),
  },
  // A message from the pro (#73): the chat over the job of the customer's request. The job read by
  // the request is the check, and gives the job's id the chat route takes (and the pro's name in
  // its header). Without an answer (offline, a server error), the job screen opens: it shows its
  // own error and retry, and its way into the chat.
  "/requests/{id}/job/chat": {
    role: "customer",
    href: (id, answer) => {
      const job = answeredJob(answer);
      return job ? chatHref(job.id, id) : jobHref(id);
    },
    path: (id, answer) => {
      const job = answeredJob(answer);
      return job ? `/jobs/${job.id}/chat` : `/requests/${id}/job`;
    },
    probe: (client, id, generation) => client.fetchQuery(customerJobQueryOptions(id, generation)),
  },
};

/**
 * The screen a push opens over the current one for an account of `role`; null when it opens none.
 * Home is not opened over anything: `openPushTap` goes back to it.
 */
export function pushRoute(link: PushLink | null, role: Role): PushRoute | null {
  const route = link && link.path !== HOME_PUSH_PATH ? ROUTES[link.path] : null;
  return route !== null && route.role === role ? route : null;
}
