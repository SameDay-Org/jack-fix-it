import { hashKey, type QueryClient } from "@tanstack/react-query";

import { isCurrentGeneration, type GetResponse } from "@/api";

import { withAdded, type Book, type BookEdit } from "./book";

export type SavedAddressList = GetResponse<"/v1/addresses">;
export type SavedAddress = SavedAddressList["items"][number];

/**
 * The book as cached. `guessed` marks one whose other addresses (the ones that are not the
 * default) the device cannot vouch for: a change of its own is still unanswered, or it no longer
 * knows their order, or an address was added while another Add was unanswered (see `Book`). Who
 * the server would make the default next is then unknown. `unplaced` is the last of the three,
 * kept apart for the log that starts on this book: the server may have an address this book does
 * not draw (`Book.unplaced`).
 */
export type SavedBook = SavedAddressList & { guessed?: true; unplaced?: true };

export const SAVED_ADDRESSES_QUERY_KEY = ["addresses"] as const;
const BOOK_HASH = hashKey(SAVED_ADDRESSES_QUERY_KEY);

/**
 * One write to the book, from asked to answered. `edit` is how the book reads with it: what the
 * device expects while it is in flight (nothing, for a write that waits for the server), then
 * what the server answered.
 */
export type OpenWrite = { edit?: BookEdit; answered: boolean };

/*
 * Two writes can be in flight at once (a sheet closes at once and the customer acts again), and
 * their answers, like the book's own GETs, come in any order. So the book on screen is never
 * patched answer by answer. From the first write asked it is always derived: `confirmed`, the
 * book as the server last listed it, with every write of the log replayed in the order asked.
 *
 * - A refused write leaves the log: the book reads as if it had never been asked, whatever the
 *   others drew meanwhile.
 * - An answered write stays in its place, with the server's answer as its edit: the answer never
 *   draws over a write asked after it. Of that answer the edit takes only what the write's own
 *   request changed (the fields an edit sent, who is the default for a default change): the rest
 *   is the address as it was when the server answered, and the server takes two writes in either
 *   order, so those fields may be older than another write's own answer.
 * - A GET that lands is the new `confirmed`, and every write is replayed over it, the answered
 *   ones too: that list may have been read before the server took them (it was in flight when
 *   they were asked, or passed them on the way).
 *
 * Once the last write is answered the book is fetched again. That GET was asked after every
 * answer so far, so its list has them: when it lands those writes leave the log, and the log
 * closes unless a write was asked meanwhile. When no list comes it closes on the book as drawn,
 * which is cached with what its addresses alone do not say (`SavedBook`): the next log starts
 * from there. The log also goes with the cached book when the cache drops it (a sign-out clears
 * it); what its writes answer later is drawn nowhere.
 */
type WriteLog = {
  confirmed: Book;
  /** Every write asked since the log opened and not refused, oldest first. */
  writes: OpenWrite[];
  /** The GET asked when the last write was answered; a later one replaces it. */
  refetch?: Promise<unknown>;
  /** Whether a GET landed since `refetch` was asked. */
  landed: boolean;
  /** Stops watching the cached book. */
  stop: () => void;
};

const logs = new WeakMap<QueryClient, WriteLog>();

const inFlight = (log: WriteLog) => log.writes.some((write) => !write.answered);

function closeLog(client: QueryClient, log: WriteLog): void {
  log.stop();
  logs.delete(client);
}

/**
 * Draws the book as the log has it: `confirmed`, then each write in the order asked. Its marks
 * are cached with it: this log may close before the server lists the book.
 */
function draw(client: QueryClient, log: WriteLog): void {
  const book = log.writes.reduce((drawn, write) => write.edit?.(drawn) ?? drawn, log.confirmed);
  const guessed =
    !book.ordered || book.unplaced || log.writes.some((write) => write.edit && !write.answered);
  client.setQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY, (cached) => {
    if (!cached) return cached;
    const { guessed: _guessed, unplaced: _unplaced, ...list } = cached;
    const drawn: SavedBook = { ...list, items: [...book.items] };
    if (guessed) drawn.guessed = true;
    if (book.unplaced) drawn.unplaced = true;
    return drawn;
  });
}

/**
 * Starts a log over the book as cached, if it is: with no book there is nothing to draw on. A
 * book cached `unplaced` stays that: the log that drew it closed with no list from the server,
 * and an Add may be unanswered still (one asked before the book was cached had no place in that
 * log to keep it open).
 */
function startLog(client: QueryClient): WriteLog | undefined {
  const cached = client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY);
  if (!cached) return undefined;
  const book: Book = { items: cached.items, ordered: !cached.guessed };
  const log: WriteLog = {
    confirmed: cached.unplaced ? { ...book, unplaced: true } : book,
    writes: [],
    landed: false,
    stop: client.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== BOOK_HASH) return;
      if (event.type === "removed") {
        closeLog(client, log);
        return;
      }
      // A GET's own answer, not a drawing of this log (`manual`).
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual)
        return;
      const list = event.query.state.data as SavedAddressList | undefined;
      if (!list) return;
      log.confirmed = { items: list.items, ordered: true };
      log.landed = true;
      draw(client, log);
    }),
  };
  logs.set(client, log);
  return log;
}

/**
 * Draws the book after an answer. With the last write answered, fetches the book again: the list
 * that comes back replaces the writes answered by now, and the log closes if none was asked since.
 * If no list comes (offline, or no screen is reading the book) it closes on the book as drawn,
 * though an Add with no place in it may be unanswered still: the cached book says so (`draw`).
 */
function settle(client: QueryClient, log: WriteLog): void {
  draw(client, log);
  if (inFlight(log)) return;
  const answered = [...log.writes];
  log.landed = false;
  // Not awaited by the write: it would hold its answer (and a busy button) until the GET lands.
  // A GET already in flight is replaced: it was asked before this answer.
  const refetch = client.invalidateQueries(
    { queryKey: SAVED_ADDRESSES_QUERY_KEY, exact: true },
    { throwOnError: true },
  );
  log.refetch = refetch;
  const settled = (listed: boolean) => {
    // Not this log's last word: it is gone, or a later answer asked for a newer list.
    if (logs.get(client) !== log || log.refetch !== refetch) return;
    if (listed && log.landed) {
      log.writes = log.writes.filter((write) => !answered.includes(write));
      draw(client, log);
    }
    if (!inFlight(log)) closeLog(client, log);
  };
  refetch.then(
    () => settled(true),
    () => settled(false),
  );
}

/** A write with no place in a book on screen was answered: fetch the book, for its session. */
function fetchBook(client: QueryClient, generation: number): void {
  if (!isCurrentGeneration(generation)) return;
  void client.invalidateQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY, exact: true });
}

/**
 * Records a write as asked, for the session that asked it, and draws the book with its `edit` if
 * it has one. Undefined when the write has no place in the book on screen: its session is gone,
 * or the book is not cached.
 */
export function openWrite(
  client: QueryClient,
  generation: number,
  edit?: BookEdit,
): OpenWrite | undefined {
  if (!isCurrentGeneration(generation)) return undefined;
  const log = logs.get(client) ?? startLog(client);
  if (!log) return undefined;
  const write: OpenWrite = { edit, answered: false };
  log.writes.push(write);
  if (edit) draw(client, log);
  return write;
}

/**
 * The server answered `write`: the book reads with `edit`, the answer, in the place the write was
 * asked. A write that had no place yet takes the last one, if the book was cached since. One
 * whose log is gone (its session ended) draws nothing.
 */
export function answerWrite(
  client: QueryClient,
  generation: number,
  write: OpenWrite | undefined,
  edit: BookEdit,
): void {
  const answered = write ?? openWrite(client, generation);
  const log = logs.get(client);
  if (!answered) fetchBook(client, generation);
  if (!answered || !log?.writes.includes(answered)) return;
  answered.edit = edit;
  answered.answered = true;
  settle(client, log);
}

/** The server refused `write`: the book reads without it. */
export function dropWrite(
  client: QueryClient,
  generation: number,
  write: OpenWrite | undefined,
): void {
  const log = logs.get(client);
  if (!write) fetchBook(client, generation);
  const index = write && log ? log.writes.indexOf(write) : -1;
  if (!log || index < 0) return;
  log.writes.splice(index, 1);
  settle(client, log);
}

/**
 * An Add, from asked to answered: its place in the log (none when no book was cached to draw
 * on), and whether another Add of its session was unanswered at any moment while it was.
 */
export type OpenAdd = { generation: number; write: OpenWrite | undefined; contested: boolean };

/*
 * The Adds the server has not answered, per cache. They are counted here and not in the log: an
 * Add asked before the book was cached has no place in it, and is as much in flight as the others.
 */
const adding = new WeakMap<QueryClient, Set<OpenAdd>>();

/**
 * Records an Add as asked (`openWrite`: it draws nothing until the server answers). Two Adds of
 * a session unanswered together are both `contested`, for good: the server takes them in either
 * order and neither answer says which, so the device cannot know which of the two addresses is
 * the older one, nor, while one is unanswered, whether the server already has it.
 */
export function openAdd(client: QueryClient, generation: number): OpenAdd {
  const add: OpenAdd = { generation, write: openWrite(client, generation), contested: false };
  // An Add of a session that is gone is never sent: it is in flight with no one.
  if (!isCurrentGeneration(generation)) return add;
  const unanswered = adding.get(client) ?? new Set<OpenAdd>();
  adding.set(client, unanswered.add(add));
  const together = [...unanswered].filter((asked) => asked.generation === generation);
  if (together.length > 1) for (const asked of together) asked.contested = true;
  return add;
}

/** The server answered an Add with the new `address`: the book reads with it (`answerWrite`). */
export function answerAdd(client: QueryClient, add: OpenAdd, address: SavedAddress): void {
  adding.get(client)?.delete(add);
  answerWrite(client, add.generation, add.write, (book) => withAdded(book, address, add.contested));
}

/** The server refused an Add: the book reads without it (`dropWrite`). */
export function dropAdd(client: QueryClient, generation: number, add: OpenAdd | undefined): void {
  if (add) adding.get(client)?.delete(add);
  dropWrite(client, generation, add?.write);
}
