import { hashKey, type QueryClient } from "@tanstack/react-query";

import { isCurrentGeneration, type GetResponse } from "@/api";

import type { BookEdit } from "./book";

export type SavedAddressList = GetResponse<"/v1/addresses">;
export type SavedAddress = SavedAddressList["items"][number];

/**
 * The book as cached. `redrawn` marks one this device changed since the server last listed it: its
 * addresses and its default are the best the device knows, but the order of the others is no
 * longer the server's (oldest first), which the device cannot rebuild: addresses carry no date.
 */
export type SavedBook = SavedAddressList & { redrawn?: true };

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
 * their answers come in any order. So the book on screen is never patched answer by answer. While
 * a write is in flight it is always `confirmed`, the book as the server last listed or confirmed
 * it, with every write of the log replayed in the order it was asked:
 *
 * - a refused write leaves the log, and the book reads as if it had never been asked, whatever
 *   the others drew meanwhile;
 * - an answered write keeps its place until the ones asked before it are answered too, then joins
 *   `confirmed`: its answer never draws over a write asked after it;
 * - a GET that lands meanwhile is the new `confirmed`, under the same writes.
 *
 * The log lasts as long as its writes and the cached book they are drawn on. When the cache drops
 * the book (a sign-out clears it) the log goes with it, and what its writes answer later is drawn
 * nowhere.
 */
type WriteLog = {
  confirmed: SavedAddress[];
  /** Whether `confirmed` is still a list as the server sent it. */
  listed: boolean;
  /** The writes not yet part of `confirmed`, oldest first. */
  writes: OpenWrite[];
  /** Stops watching the cached book. */
  stop: () => void;
};

const logs = new WeakMap<QueryClient, WriteLog>();

function closeLog(client: QueryClient, log: WriteLog): void {
  log.stop();
  logs.delete(client);
}

/** Draws the book as the log has it: `confirmed`, then each write in the order asked. */
function draw(client: QueryClient, log: WriteLog): void {
  const items = log.writes.reduce<SavedAddress[]>(
    (book, write) => write.edit?.(book) ?? book,
    log.confirmed,
  );
  const listed = log.listed && log.writes.every((write) => !write.edit);
  client.setQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY, (cached) => {
    if (!cached) return cached;
    const { redrawn: _redrawn, ...list } = cached;
    return listed ? { ...list, items } : { ...list, items, redrawn: true };
  });
}

/** Starts a log over the book as cached, if it is: with no book there is nothing to draw on. */
function startLog(client: QueryClient): WriteLog | undefined {
  const cached = client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY);
  if (!cached) return undefined;
  const log: WriteLog = {
    confirmed: cached.items,
    listed: !cached.redrawn,
    writes: [],
    stop: client.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== BOOK_HASH) return;
      if (event.type === "removed") {
        closeLog(client, log);
        return;
      }
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual)
        return;
      // A GET landed while writes are in flight (another screen opened, the app came back). It
      // was answered without some of them: its list is the server's word, and they go on top.
      const list = event.query.state.data as SavedAddressList | undefined;
      if (!list) return;
      log.confirmed = list.items;
      log.listed = true;
      draw(client, log);
    }),
  };
  logs.set(client, log);
  return log;
}

/** Moves the answered writes no unanswered one precedes into `confirmed`, and draws the book. */
function settle(client: QueryClient, log: WriteLog): void {
  while (log.writes[0]?.answered) {
    const edit = log.writes.shift()?.edit;
    if (edit) {
      log.confirmed = edit(log.confirmed);
      log.listed = false;
    }
  }
  draw(client, log);
  if (log.writes.length === 0) closeLog(client, log);
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
 * asked. A write that had no place yet (the book was cached since) takes the last one. One whose
 * log is gone draws nothing.
 */
export function answerWrite(
  client: QueryClient,
  generation: number,
  write: OpenWrite | undefined,
  edit: BookEdit,
): void {
  const answered = write ?? openWrite(client, generation);
  const log = logs.get(client);
  if (!answered || !log?.writes.includes(answered)) return;
  answered.edit = edit;
  answered.answered = true;
  settle(client, log);
}

/** The server refused `write`: the book reads without it. */
export function dropWrite(client: QueryClient, write: OpenWrite | undefined): void {
  const log = logs.get(client);
  const index = write && log ? log.writes.indexOf(write) : -1;
  if (!log || index < 0) return;
  log.writes.splice(index, 1);
  settle(client, log);
}
