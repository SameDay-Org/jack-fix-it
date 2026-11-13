import type { ApiSchema } from "@jack/shared";
import { replaceEqualDeep, useQuery, type QueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { Platform } from "react-native";

import {
  ApiError,
  apiGet,
  apiPost,
  NetworkError,
  SessionExpiredError,
  useSession,
  useSessionGeneration,
} from "@/api";

export type TicketTopic = ApiSchema<"TicketTopic">;
export type TicketStatus = ApiSchema<"TicketStatus">;
/**
 * One of the person's messages as the app keeps it: what it is about, when it was sent and where
 * it stands. Never its text: nothing the person wrote stays in the app once it is sent.
 */
export type MyTicket = Pick<
  ApiSchema<"MySupportTicketOut">,
  "id" | "topic" | "status" | "created_at"
>;

/** The topics of a message to the team, in the order the form lists them. */
export const TICKET_TOPICS = [
  "account",
  "payment",
  "job",
  "safety",
  "app_problem",
  "other",
] as const satisfies readonly TicketTopic[];

/** The API's limit for a message (`SupportTicketIn.message`). */
export const MESSAGE_MAX = 2000;

/** What the person wrote, ready to send. */
export type Ticket = { topic: TicketTopic; message: string; jobId: string | null };

// The key names the list and the session, never anything a person typed.
const myTicketsKey = (generation: number) => ["support-tickets", "mine", generation] as const;

/**
 * The list as the app keeps it: the server's newest page as it last answered (null while none
 * has), and what was sent from this phone since that the page does not hold yet, newest first.
 * A page read before the server took a message cannot hold it, and must not take it off the
 * screen either: a sent message stays until a page lists it.
 */
type MineCache = { page: MyTicket[] | null; sent: MyTicket[] };

/** What "Your messages" shows: the messages, newest first, and whether the server's list came. */
export type MyTickets = { items: MyTicket[]; listed: boolean };

/** The sent messages a page does not hold, each once, in their order. */
function notOn(page: readonly MyTicket[] | null, sent: readonly MyTicket[]): MyTicket[] {
  const known = new Set(page?.map((item) => item.id));
  const kept: MyTicket[] = [];
  for (const item of sent) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    kept.push(item);
  }
  return kept;
}

/**
 * Every write to the cache, a page that arrives or a message that went, keeps what the cache
 * holds as sent at that moment. Done here, where TanStack stores the data, and not in the query
 * function: an answer read before a message went is stored only after, and would otherwise
 * draw over it.
 */
function keepSent(old: unknown, next: unknown): unknown {
  // Only `MineCache` values are ever stored under this key.
  const before = old as MineCache | undefined;
  const after = next as MineCache;
  const kept = {
    page: after.page,
    sent: notOn(after.page, [...after.sent, ...(before?.sent ?? [])]),
  };
  return replaceEqualDeep(before, kept);
}

const shown = ({ page, sent }: MineCache): MyTickets => ({
  items: [...sent, ...(page ?? [])],
  listed: page !== null,
});

/**
 * Reads the list again, from now: a read already on its way may have left before the server took
 * the last message, so it is dropped instead of joined (TanStack joins a first read in flight).
 */
function readAgain(client: QueryClient, key: ReturnType<typeof myTicketsKey>): void {
  void client.cancelQueries({ queryKey: key });
  void client.invalidateQueries({ queryKey: key });
}

/**
 * The signed-in person's own messages to the team, newest first (the newest page: there is no
 * thread to scroll back through, and a person can send only a few an hour), headed by those sent
 * from this phone that the server has not listed yet. Only the fields of `MyTicket` are kept from
 * the answer, whatever else it carries.
 */
export function useMyTickets() {
  const generation = useSessionGeneration();
  const { status } = useSession();
  const { data, isError, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: myTicketsKey(generation),
    queryFn: async ({ signal }): Promise<MineCache> => {
      const answer = await apiGet("/v1/support/tickets/mine", { auth: true, signal, generation });
      return {
        page: answer.items.map(({ id, topic, status, created_at }) => ({
          id,
          topic,
          status,
          created_at,
        })),
        sent: [],
      };
    },
    // Not with `select`: TanStack passes what `select` returns through this too.
    structuralSharing: keepSent,
    enabled: status === "signedIn",
    retry: false,
  });
  return { data: data && shown(data), isError, isFetching, dataUpdatedAt, refetch };
}

/**
 * Sends one message to the team, with the phone's platform and the app's version for whoever
 * reads it. The text is kept as typed, and goes in the request body and nowhere else: not in the
 * list, a key, a log or anything written to disk. A plain call and not a mutation (as in
 * `features/phone/api.ts`): a mutation keeps its variables, here the text, in the app-wide
 * MutationCache. Pinned to the session it was written in.
 */
export async function sendTicket(
  client: QueryClient,
  ticket: Ticket,
  generation: number,
): Promise<void> {
  const mine = myTicketsKey(generation);
  let created;
  try {
    created = await apiPost(
      "/v1/support/tickets",
      {
        topic: ticket.topic,
        message: ticket.message,
        job_id: ticket.jobId,
        platform: Platform.OS === "ios" ? "ios" : "android",
        app_version: Constants.expoConfig?.version ?? null,
      },
      { auth: true, generation },
    );
  } catch (error) {
    // No answer is not a refusal: the message may have arrived all the same. The list is read
    // again, so a message that did arrive shows there before the person sends it a second time.
    if (error instanceof NetworkError) readAgain(client, mine);
    throw error;
  }
  // The new message heads the list at once, with or without a page yet; the server's page follows
  // and keeps it until it lists it. Only what the list shows is kept, never the text.
  const sent: MyTicket = {
    id: created.id,
    topic: ticket.topic,
    status: created.status,
    created_at: created.created_at,
  };
  client.setQueryData<MineCache>(mine, (cache) => ({
    page: cache?.page ?? null,
    sent: notOn(cache?.page ?? null, [sent, ...(cache?.sent ?? [])]),
  }));
  readAgain(client, mine);
}

/**
 * Why a message did not go, as the form explains it. `null`: the session ended, and the
 * signed-out handling takes over (nothing to say on a screen that is leaving). A 401 that did not
 * end the session is a refusal like any other: the person is told, never left with a dead tap.
 */
export type SendFailure = "offline" | "rateLimited" | "invalidJob" | "failed";

export function sendFailureOf(error: unknown): SendFailure | null {
  if (error instanceof SessionExpiredError) return null;
  if (error instanceof NetworkError) return "offline";
  if (error instanceof ApiError) {
    if (error.status === 429) return "rateLimited";
    if (error.status === 422 && error.code === "invalid_job") return "invalidJob";
  }
  return "failed";
}
