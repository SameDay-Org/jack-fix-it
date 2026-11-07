import i18n from "@/i18n";
import { formatInstantDay } from "@/features/opportunities/format";

import { dayLabel } from "../MessageRow";
import {
  RUN_GAP_MS,
  addSent,
  appendOlder,
  mergeNewest,
  receiptOf,
  textLength,
  threadRows,
  type ChatMessage,
  type ChatPage,
  type Pending,
  type Row,
  type Thread,
} from "../thread";

type Sender = ChatMessage["sender"];

const msg = (id: string, at: string | number, sender: Sender = "pro", body = "x"): ChatMessage => ({
  id,
  sender,
  body,
  redacted: false,
  created_at: typeof at === "number" ? new Date(at).toISOString() : at,
});

const page = (
  items: ChatMessage[],
  next_cursor: string | null = null,
  unread_count = 0,
): ChatPage => ({ items, next_cursor, unread_count });

const thread = (
  messages: ChatMessage[],
  olderCursor: string | null = "held-cursor",
  unreadCount = 0,
): Thread => ({ messages, olderCursor, unreadCount });

const ids = (messages: readonly ChatMessage[]): string[] => messages.map((m) => m.id);

const pend = (localId: string, at: number, state: Pending["state"] = "sending"): Pending => ({
  localId,
  body: "x",
  at,
  state,
});

/** A local wall-clock instant on 2026-11-<day>, so day boundaries follow the runner's zone. */
const local = (day: number, hour: number, minute = 0, second = 0): number =>
  new Date(2026, 10, day, hour, minute, second).getTime();

const MIN = 60_000;

describe("mergeNewest", () => {
  it("takes the page as the thread when nothing is held", () => {
    const result = mergeNewest(
      undefined,
      page([msg("b", "2026-11-07T10:01:00Z"), msg("a", "2026-11-07T10:00:00Z")], "c1", 3),
    );

    expect(result).toStrictEqual({
      messages: [msg("b", "2026-11-07T10:01:00Z"), msg("a", "2026-11-07T10:00:00Z")],
      olderCursor: "c1",
      unreadCount: 3,
    });
  });

  it("sorts a page that arrives out of order, newest first", () => {
    const result = mergeNewest(
      undefined,
      page([msg("a", "2026-11-07T10:00:00Z"), msg("b", "2026-11-07T10:01:00Z")]),
    );

    expect(ids(result.messages)).toStrictEqual(["b", "a"]);
  });

  it("joins a page that overlaps the held messages and keeps the held cursor", () => {
    const held = thread(
      [msg("b", "2026-11-07T10:01:00Z"), msg("a", "2026-11-07T10:00:00Z")],
      "older-than-a",
      5,
    );
    const newest = page(
      [
        msg("d", "2026-11-07T10:03:00Z"),
        msg("c", "2026-11-07T10:02:00Z"),
        msg("b", "2026-11-07T10:01:00Z"),
      ],
      "older-than-b",
      2,
    );

    const result = mergeNewest(held, newest);

    expect(ids(result.messages)).toStrictEqual(["d", "c", "b", "a"]);
    expect(result.olderCursor).toBe("older-than-a");
    expect(result.unreadCount).toBe(2);
  });

  it("joins a page with no next cursor and ends the older messages", () => {
    const held = thread([msg("a", "2026-11-07T10:00:00Z")], "older-than-a");
    const whole = page(
      [msg("c", "2026-11-07T10:02:00Z"), msg("b", "2026-11-07T10:01:00Z")],
      null,
      1,
    );

    const result = mergeNewest(held, whole);

    expect(ids(result.messages)).toStrictEqual(["c", "b", "a"]);
    expect(result.olderCursor).toBeNull();
    expect(result.unreadCount).toBe(1);
  });

  it("starts over from a page that leaves a gap behind it", () => {
    const held = thread(
      [msg("b", "2026-11-07T10:01:00Z"), msg("a", "2026-11-07T10:00:00Z")],
      "old",
    );
    const gap = page(
      [msg("z", "2026-11-07T11:00:00Z"), msg("y", "2026-11-07T10:59:00Z")],
      "older-than-y",
      7,
    );

    const result = mergeNewest(held, gap);

    expect(result).toStrictEqual({
      messages: [msg("z", "2026-11-07T11:00:00Z"), msg("y", "2026-11-07T10:59:00Z")],
      olderCursor: "older-than-y",
      unreadCount: 7,
    });
  });

  it("keeps each id once and lets the page's copy win", () => {
    const held = thread([msg("a", "2026-11-07T10:00:00Z", "me", "held text")]);
    const newest = page([msg("a", "2026-11-07T10:00:00Z", "me", "page text")]);

    const result = mergeNewest(held, newest);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.body).toBe("page text");
  });

  it("orders by instant, not by the text of the timestamp", () => {
    // 09:00 at UTC-5 is 14:00 UTC: newer than 13:00 UTC though its string sorts lower.
    const result = mergeNewest(
      undefined,
      page([msg("utc", "2026-11-07T13:00:00Z"), msg("offset", "2026-11-07T09:00:00-05:00")]),
    );

    expect(ids(result.messages)).toStrictEqual(["offset", "utc"]);
  });

  it("orders messages of the same instant by id, highest first", () => {
    const at = "2026-11-07T10:00:00Z";
    const held = thread([msg("m2", at)]);
    const newest = page([msg("m1", at), msg("m3", at), msg("m2", at)]);

    expect(ids(mergeNewest(held, newest).messages)).toStrictEqual(["m3", "m2", "m1"]);
  });

  it("always takes the unread count from the page", () => {
    const held = thread([msg("a", "2026-11-07T10:00:00Z")], "old", 9);

    expect(mergeNewest(held, page([msg("a", "2026-11-07T10:00:00Z")], "x", 0)).unreadCount).toBe(0);
    expect(mergeNewest(held, page([], null, 4)).unreadCount).toBe(4);
    expect(mergeNewest(held, page([msg("q", "2026-11-07T12:00:00Z")], "x", 6)).unreadCount).toBe(6);
  });
});

describe("appendOlder", () => {
  it("keeps my sent messages unconfirmed, so a later page still cannot join through them", () => {
    const sent = msg("mine", "2026-11-07T10:05:00Z", "me");
    const held = addSent(thread([msg("h1", "2026-11-07T10:00:00Z")], "c0", 0), sent);
    const afterOlder = appendOlder(held, page([msg("h0", "2026-11-07T09:59:00Z")], "c1", 0));

    expect(afterOlder.local).toEqual(["mine"]);
    // A newest page reaching only my sent message (more than a page arrived meanwhile) starts over.
    const newest = page([sent, msg("p30", "2026-11-07T10:04:00Z")], "next", 0);
    expect(mergeNewest(afterOlder, newest).messages.map((m) => m.id)).toEqual(["mine", "p30"]);
  });

  it("adds the older page behind, moves the cursor on and keeps the unread count", () => {
    const held = thread(
      [msg("d", "2026-11-07T10:03:00Z"), msg("c", "2026-11-07T10:02:00Z")],
      "c0",
      4,
    );
    const older = page(
      [msg("b", "2026-11-07T10:01:00Z"), msg("a", "2026-11-07T10:00:00Z")],
      "c1",
      0,
    );

    expect(appendOlder(held, older)).toStrictEqual({
      messages: [
        msg("d", "2026-11-07T10:03:00Z"),
        msg("c", "2026-11-07T10:02:00Z"),
        msg("b", "2026-11-07T10:01:00Z"),
        msg("a", "2026-11-07T10:00:00Z"),
      ],
      olderCursor: "c1",
      unreadCount: 4,
    });
  });

  it("ends the older messages with the last page and keeps each id once", () => {
    const held = thread([msg("b", "2026-11-07T10:01:00Z"), msg("a", "2026-11-07T10:00:00Z")], "c0");
    const last = page(
      [msg("a", "2026-11-07T10:00:00Z"), msg("first", "2026-11-07T09:00:00Z")],
      null,
    );

    const result = appendOlder(held, last);

    expect(ids(result.messages)).toStrictEqual(["b", "a", "first"]);
    expect(result.olderCursor).toBeNull();
  });
});

describe("addSent", () => {
  it("adds the sent message in order and keeps the cursor and unread count", () => {
    const held = thread([msg("a", "2026-11-07T10:00:00Z")], "c0", 2);

    expect(addSent(held, msg("mine", "2026-11-07T10:05:00Z", "me"))).toStrictEqual({
      messages: [msg("mine", "2026-11-07T10:05:00Z", "me"), msg("a", "2026-11-07T10:00:00Z")],
      olderCursor: "c0",
      unreadCount: 2,
      local: ["mine"],
    });
  });

  it("adds each sent id to the local ones, after those already held", () => {
    const first = addSent(
      thread([msg("a", "2026-11-07T10:00:00Z")]),
      msg("m1", local(7, 11), "me"),
    );

    expect(addSent(first, msg("m2", local(7, 12), "me")).local).toStrictEqual(["m1", "m2"]);
    expect(first.local).toStrictEqual(["m1"]);
  });

  it("keeps a message the poll already brought once, as the sent copy", () => {
    const held = thread([msg("mine", "2026-11-07T10:05:00Z", "me", "polled")], null, 0);

    const result = addSent(held, msg("mine", "2026-11-07T10:05:00Z", "me", "sent"));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.body).toBe("sent");
    expect(result.olderCursor).toBeNull();
  });

  it("leaves the held thread untouched", () => {
    const held = thread([msg("a", "2026-11-07T10:00:00Z")]);

    addSent(held, msg("b", "2026-11-07T10:01:00Z", "me"));

    expect(ids(held.messages)).toStrictEqual(["a"]);
  });
});

describe("the local ids of sent messages", () => {
  // H1 is the last message the screen saw from a page; M is mine, sent after 30 more arrived unseen.
  const h1 = msg("h1", "2026-11-07T10:00:00Z", "pro");
  const mine = msg("mine", "2026-11-07T11:00:00Z", "me");
  /** P<n> arrived n minutes after H1: P1..P30 all sit between H1 and M. */
  const p = (n: number): ChatMessage =>
    msg(`p${String(n).padStart(2, "0")}`, Date.parse(h1.created_at) + n * MIN);
  const range = (from: number, to: number): ChatMessage[] =>
    Array.from({ length: to - from + 1 }, (_, index) => p(to - index));

  const sentAfterHeld = (): Thread => addSent(thread([h1], "older-than-h1", 0), mine);

  it("starts over from a page that reaches only my sent message, not joining through it", () => {
    const held = sentAfterHeld();
    const newest = page([mine, ...range(12, 30)], "older-than-p12", 19);

    const result = mergeNewest(held, newest);

    // Joined, the list would read H1 then P12 with P1..P11 silently missing between them.
    expect(result).toStrictEqual({
      messages: [mine, ...range(12, 30)],
      olderCursor: "older-than-p12",
      unreadCount: 19,
    });
    expect(ids(result.messages)).not.toContain("h1");
  });

  it("joins a page that shows my sent message and a server message held, and forgets it as local", () => {
    const held = sentAfterHeld();
    const newest = page([mine, ...range(1, 5), h1], "older-than-h1-page", 5);

    const result = mergeNewest(held, newest);

    expect(ids(result.messages)).toStrictEqual(ids([mine, ...range(1, 5), h1]));
    expect(result.olderCursor).toBe("older-than-h1");
    expect(result.unreadCount).toBe(5);
    expect(result).not.toHaveProperty("local");
  });

  it("joins on a server message and keeps the local ids the page did not show", () => {
    const later = msg("mine-2", "2026-11-07T11:01:00Z", "me");
    const held = addSent(sentAfterHeld(), later);
    // The page was cut before my second message was stored: it shows the first one only.
    const newest = page([mine, p(1), h1], "older-than-h1-page", 1);

    const result = mergeNewest(held, newest);

    expect(ids(result.messages)).toStrictEqual(["mine-2", "mine", "p01", "h1"]);
    expect(result.local).toStrictEqual(["mine-2"]);
    expect(held.local).toStrictEqual(["mine", "mine-2"]);
  });

  it("joins a page that holds the whole chat even through local ids alone, and forgets them", () => {
    const held = addSent(thread([], null, 0), mine);

    const result = mergeNewest(held, page([mine, p(1)], null, 1));

    expect(ids(result.messages)).toStrictEqual(["mine", "p01"]);
    expect(result.olderCursor).toBeNull();
    expect(result).not.toHaveProperty("local");
  });

  it("starts over, without local ids, when a page shows neither a held nor a local message", () => {
    const result = mergeNewest(sentAfterHeld(), page(range(20, 30), "older-than-p20", 11));

    expect(result).toStrictEqual({
      messages: range(20, 30),
      olderCursor: "older-than-p20",
      unreadCount: 11,
    });
  });
});

describe("receiptOf", () => {
  const mine = msg("m", 0, "me");

  it("reads sent while the contract has no receipt yet (#331)", () => {
    expect(receiptOf(mine)).toBe("sent");
  });

  it.each(["sent", "delivered", "seen"] as const)("passes %s through", (receipt) => {
    expect(receiptOf({ ...mine, receipt } as ChatMessage)).toBe(receipt);
  });

  it.each([null, "read", 3])("never shows more than sent for %p", (receipt) => {
    expect(receiptOf({ ...mine, receipt } as unknown as ChatMessage)).toBe("sent");
  });
});

describe("textLength", () => {
  const grinning = String.fromCodePoint(0x1f600);
  const thumbsMedium = String.fromCodePoint(0x1f44d, 0x1f3fd);

  it("measures the trimmed text", () => {
    expect(textLength("  hi there \n")).toBe(8);
    expect(textLength("")).toBe(0);
    expect(textLength(" \n\t ")).toBe(0);
  });

  it("counts code points like the API (Python), not UTF-16 units", () => {
    expect(grinning).toHaveLength(2);
    expect(textLength(grinning)).toBe(1);
    // A thumbs-up with a skin tone is two code points in Python too.
    expect(textLength(thumbsMedium)).toBe(2);
    expect(textLength(` ${grinning}ok${grinning} `)).toBe(4);
  });

  it("measures 2,000 emoji as 2,000 characters", () => {
    expect(textLength(grinning.repeat(2000))).toBe(2000);
  });
});

/** The rows as compact tuples, to read a whole list at a glance. */
const shape = (rows: readonly Row[]): string[] =>
  rows.map((row) =>
    row.kind === "day"
      ? `day:${row.key}`
      : `${row.key}:${row.side}${row.startsRun ? ":start" : ""}${row.endsRun ? ":end" : ""}`,
  );

describe("threadRows", () => {
  it("gives no rows for an empty thread", () => {
    expect(threadRows([], [])).toStrictEqual([]);
  });

  it("puts a message's side from its sender and a day row after the oldest", () => {
    const rows = threadRows(
      [msg("b", local(7, 10, 1), "customer"), msg("a", local(7, 10, 0), "me")],
      [],
    );

    expect(shape(rows)).toStrictEqual(["b:theirs:start:end", "a:mine:start:end", "day:day-a"]);
    const [first, second] = rows;
    expect(first?.kind === "message" && first.message?.id).toBe("b");
    expect(second?.kind === "message" && second.at).toBe(local(7, 10, 0));
  });

  it("treats a pro's messages as theirs too", () => {
    const [row] = threadRows([msg("a", local(7, 10), "pro")], []);

    expect(row?.kind === "message" && row.side).toBe("theirs");
  });

  it("lists pending sends first, newest first, then the stored messages", () => {
    const pending = [pend("p1", local(7, 10, 2)), pend("p2", local(7, 10, 3), "failed")];

    const rows = threadRows([msg("a", local(7, 10, 0), "me")], pending);

    expect(rows.map((row) => row.key)).toStrictEqual(["local-p2", "local-p1", "a", "day-a"]);
    const [newest] = rows;
    expect(newest?.kind === "message" && newest.pending).toBe(pending[1]);
    expect(newest?.kind === "message" && newest.side).toBe("mine");
  });

  it("joins one sender's close messages of a day into one run", () => {
    const rows = threadRows(
      [
        msg("c", local(7, 10, 8), "me"),
        msg("b", local(7, 10, 4), "me"),
        msg("a", local(7, 10, 0), "me"),
      ],
      [],
    );

    expect(shape(rows)).toStrictEqual(["c:mine:end", "b:mine", "a:mine:start", "day:day-a"]);
  });

  it("breaks a run on a change of side", () => {
    const rows = threadRows(
      [
        msg("d", local(7, 10, 3), "pro"),
        msg("c", local(7, 10, 2), "me"),
        msg("b", local(7, 10, 1), "me"),
        msg("a", local(7, 10, 0), "pro"),
      ],
      [],
    );

    expect(shape(rows)).toStrictEqual([
      "d:theirs:start:end",
      "c:mine:end",
      "b:mine:start",
      "a:theirs:start:end",
      "day:day-a",
    ]);
  });

  it("breaks a run on a gap of exactly RUN_GAP_MS, not one just under it", () => {
    const base = local(7, 10);
    const apart = threadRows([msg("b", base + RUN_GAP_MS), msg("a", base)], []);
    const close = threadRows([msg("b", base + RUN_GAP_MS - 1), msg("a", base)], []);

    expect(shape(apart)).toStrictEqual(["b:theirs:start:end", "a:theirs:start:end", "day:day-a"]);
    expect(shape(close)).toStrictEqual(["b:theirs:end", "a:theirs:start", "day:day-a"]);
  });

  it("breaks a run and adds a day row across local midnight", () => {
    const rows = threadRows([msg("b", local(7, 0, 1), "me"), msg("a", local(6, 23, 58), "me")], []);

    expect(RUN_GAP_MS).toBeGreaterThan(3 * MIN);
    expect(shape(rows)).toStrictEqual([
      "b:mine:start:end",
      "day:day-b",
      "a:mine:start:end",
      "day:day-a",
    ]);
  });

  it("puts one day row after the oldest message of each day", () => {
    const rows = threadRows(
      [
        msg("e", local(7, 9, 30)),
        msg("d", local(7, 8)),
        msg("c", local(5, 20)),
        msg("b", local(5, 12)),
        msg("a", local(4, 7)),
      ],
      [],
    );

    expect(rows.map((row) => row.key)).toStrictEqual([
      "e",
      "d",
      "day-d",
      "c",
      "b",
      "day-b",
      "a",
      "day-a",
    ]);
    const days = rows.filter((row) => row.kind === "day");
    expect(days.map((row) => row.at)).toStrictEqual([local(7, 8), local(5, 12), local(4, 7)]);
  });

  it("runs a pending send on with my newest stored message", () => {
    const rows = threadRows([msg("a", local(7, 10, 0), "me")], [pend("p1", local(7, 10, 1))]);

    expect(shape(rows)).toStrictEqual(["local-p1:mine:end", "a:mine:start", "day:day-a"]);
  });

  it("keeps every key unique with a pending send on another day", () => {
    const rows = threadRows(
      [msg("b", local(6, 18), "pro"), msg("a", local(6, 17, 58), "me")],
      [pend("p1", local(7, 9))],
    );

    const keys = rows.map((row) => row.key);
    expect(keys).toStrictEqual(["local-p1", "day-local-p1", "b", "a", "day-a"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("dayLabel", () => {
  const t = i18n.t.bind(i18n);
  const now = local(7, 9);

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("says Today for any time of the same local day", () => {
    expect(dayLabel(t, local(7, 0, 0), now, "en-US")).toBe("Today");
    expect(dayLabel(t, local(7, 23, 59), now, "en-US")).toBe("Today");
  });

  it("says Yesterday for the day before, up to its last minute", () => {
    expect(dayLabel(t, local(6, 0, 0), now, "en-US")).toBe("Yesterday");
    expect(dayLabel(t, local(6, 23, 59, 59), now, "en-US")).toBe("Yesterday");
  });

  it("names the day itself from two days back", () => {
    const at = local(5, 12);

    expect(dayLabel(t, at, now, "en-US")).toBe(formatInstantDay(at, "en-US"));
    expect(dayLabel(t, at, now, "en-US")).not.toMatch(/Today|Yesterday/);
  });

  it("follows the language for Today and Yesterday", async () => {
    await i18n.changeLanguage("es");
    try {
      expect(dayLabel(t, local(7, 8), now, "es")).toBe(i18n.t("chat.day.today"));
      expect(dayLabel(t, local(6, 8), now, "es")).toBe(i18n.t("chat.day.yesterday"));
      expect(i18n.t("chat.day.today")).not.toBe("Today");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
