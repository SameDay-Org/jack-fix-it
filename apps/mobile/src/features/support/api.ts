import type { ApiSchema } from "@jack/shared";
import { useQuery, type QueryClient } from "@tanstack/react-query";
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
type MyTickets = { items: MyTicket[] };

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
 * The signed-in person's own messages to the team, newest first (the newest page: there is no
 * thread to scroll back through, and a person can send only a few an hour). Only the fields of
 * `MyTicket` are kept from the answer, whatever else it carries.
 */
export function useMyTickets() {
  const generation = useSessionGeneration();
  const { status } = useSession();
  return useQuery({
    queryKey: myTicketsKey(generation),
    queryFn: async ({ signal }): Promise<MyTickets> => {
      const page = await apiGet("/v1/support/tickets/mine", { auth: true, signal, generation });
      return {
        items: page.items.map(({ id, topic, status, created_at }) => ({
          id,
          topic,
          status,
          created_at,
        })),
      };
    },
    enabled: status === "signedIn",
    retry: false,
  });
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
    if (error instanceof NetworkError) void client.invalidateQueries({ queryKey: mine });
    throw error;
  }
  // The new message heads the list at once; the server's page follows.
  client.setQueryData<MyTickets>(
    mine,
    (page) =>
      page && {
        items: [
          {
            id: created.id,
            topic: ticket.topic,
            status: created.status,
            created_at: created.created_at,
          },
          ...page.items.filter((item) => item.id !== created.id),
        ],
      },
  );
  void client.invalidateQueries({ queryKey: mine });
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
