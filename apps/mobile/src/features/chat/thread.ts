import type { GetResponse, PostResponse } from "@/api";

export type ChatPage = GetResponse<"/v1/jobs/{job_id}/messages">;
export type ChatMessage = PostResponse<"/v1/jobs/{job_id}/messages">;

/**
 * One job's conversation as the screen holds it: every message seen so far, newest first and each
 * once; where the older ones continue (`olderCursor`, null once the first message is loaded); and
 * the caller's unread count from the newest answer.
 */
export type Thread = {
  messages: ChatMessage[];
  olderCursor: string | null;
  unreadCount: number;
  /**
   * Messages of mine added from a send's answer that no page has shown yet: they never prove a
   * page reaches what is held (the held list may stop short of them).
   */
  local?: readonly string[];
};

/** Newest first, as the API pages them: by time, then by id for messages of the same instant. */
const newestFirst = (a: ChatMessage, b: ChatMessage): number => {
  const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

/** The messages of both lists, each id once (a later copy of an id wins), newest first. */
function union(first: readonly ChatMessage[], second: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...first, ...second]) byId.set(message.id, message);
  return [...byId.values()].sort(newestFirst);
}

/**
 * The newest page folded into what the screen holds. When the page reaches back to a message
 * already held (or holds the whole chat), nothing is missing between them and the two join. When
 * more arrived since the last look than one page holds, the held messages and the newest page
 * would leave a hole between them: the thread starts over from the newest page, and its older
 * messages load again through the cursor, so the list never skips a message silently.
 */
export function mergeNewest(held: Thread | undefined, page: ChatPage): Thread {
  const fresh: Thread = {
    messages: union([], page.items),
    olderCursor: page.next_cursor,
    unreadCount: page.unread_count,
  };
  if (!held) return fresh;
  const local = new Set(held.local ?? []);
  const known = new Set(
    held.messages.filter((message) => !local.has(message.id)).map((message) => message.id),
  );
  const joins = page.next_cursor === null || page.items.some((message) => known.has(message.id));
  if (!joins) return fresh;
  const shown = new Set(page.items.map((message) => message.id));
  const stillLocal = [...local].filter((id) => !shown.has(id));
  return {
    messages: union(held.messages, page.items),
    // A page that holds the whole chat ends the older ones too.
    olderCursor: page.next_cursor === null ? null : held.olderCursor,
    unreadCount: page.unread_count,
    ...(stillLocal.length > 0 ? { local: stillLocal } : {}),
  };
}

/** An older page added behind what the screen holds; the cursor moves on to the page after it. */
export function appendOlder(held: Thread, page: ChatPage): Thread {
  return {
    messages: union(held.messages, page.items),
    olderCursor: page.next_cursor,
    unreadCount: held.unreadCount,
  };
}

/** A message the API just stored for the caller, shown at once without waiting for the next poll. */
export function addSent(held: Thread, message: ChatMessage): Thread {
  return {
    ...held,
    messages: union(held.messages, [message]),
    local: [...(held.local ?? []), message.id],
  };
}

/**
 * The length the API measures (Python counts code points): an emoji is one character, not the two
 * UTF-16 units `String.length` counts. Measured on the trimmed text, as the API stores it.
 */
export const textLength = (text: string): number => Array.from(text.trim()).length;

/** How far one of my stored messages got: stored, fetched by the other side, read by them. */
export type Receipt = "sent" | "delivered" | "seen";

/**
 * A stored message's receipt (#331 adds `ChatMessageOut.receipt` on the caller's own messages).
 * Until the field is in the contract every stored message reads as sent; an unknown value does
 * too, so a later state the app does not know never shows as more than the server confirmed.
 */
export function receiptOf(message: ChatMessage): Receipt {
  const { receipt } = message as ChatMessage & { receipt?: unknown };
  return receipt === "delivered" || receipt === "seen" ? receipt : "sent";
}

/** The local calendar day of an instant, to start a new day's section. */
const dayOf = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export type Side = "mine" | "theirs";

/** What the list draws for one message: its side and where it sits in a run of the same sender. */
export type BubbleRow = {
  kind: "message";
  key: string;
  side: Side;
  at: number;
  /** The newest of a run from one sender: it carries the tail. */
  endsRun: boolean;
  /** The oldest of a run: the run's top gets the wider gap from the bubble above. */
  startsRun: boolean;
};

export type DayRow = { kind: "day"; key: string; at: number };

/**
 * One item of a message the screen sends: what it was, and how the send went. `failed` can be
 * tried again; `refused` cannot (the chat closed, or the API refused the text).
 */
export type Pending = {
  localId: string;
  body: string;
  at: number;
  state: "sending" | "failed" | "refused";
};

export type Row =
  | (BubbleRow & { message: ChatMessage; pending?: undefined })
  | (BubbleRow & { message?: undefined; pending: Pending })
  | DayRow;

/** Bubbles from one sender closer together than this read as one run (one tail). */
export const RUN_GAP_MS = 5 * 60_000;

type Entry = { key: string; side: Side; at: number } & (
  { message: ChatMessage; pending?: undefined } | { message?: undefined; pending: Pending }
);

/**
 * The rows of the inverted list, newest first: the messages the screen sends still on their way
 * (they are the newest), then the stored ones; a day's heading after the oldest message of each
 * day (drawn above it, the list being upside down). Runs of one sender within `RUN_GAP_MS` and
 * the same day share one tail.
 */
export function threadRows(messages: readonly ChatMessage[], pending: readonly Pending[]): Row[] {
  const entries: Entry[] = [
    ...[...pending].reverse().map((item): Entry => ({
      key: `local-${item.localId}`,
      side: "mine",
      at: item.at,
      pending: item,
    })),
    ...messages.map((message): Entry => ({
      key: message.id,
      side: message.sender === "me" ? "mine" : "theirs",
      at: Date.parse(message.created_at),
      message,
    })),
  ];
  const sameRun = (a: Entry | undefined, b: Entry | undefined): boolean =>
    a !== undefined &&
    b !== undefined &&
    a.side === b.side &&
    dayOf(a.at) === dayOf(b.at) &&
    Math.abs(a.at - b.at) < RUN_GAP_MS;

  const rows: Row[] = [];
  entries.forEach((entry, index) => {
    const newer = entries[index - 1];
    const older = entries[index + 1];
    const bubble = {
      kind: "message" as const,
      key: entry.key,
      side: entry.side,
      at: entry.at,
      endsRun: !sameRun(entry, newer),
      startsRun: !sameRun(entry, older),
    };
    rows.push(
      entry.message ? { ...bubble, message: entry.message } : { ...bubble, pending: entry.pending },
    );
    if (older === undefined || dayOf(older.at) !== dayOf(entry.at)) {
      rows.push({ kind: "day", key: `day-${entry.key}`, at: entry.at });
    }
  });
  return rows;
}
