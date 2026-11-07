import { act, renderHook } from "@testing-library/react-native";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import type { ChatMessage, Row } from "../thread";
import { useNewestVisible } from "../useNewestVisible";

const NOW = Date.UTC(2026, 10, 7, 15, 0, 0);
const INSET = 16;
const MINUTE_MS = 60_000;

const message = (n: number): ChatMessage => ({
  id: `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  sender: "pro",
  body: `Message ${n}`,
  redacted: false,
  created_at: new Date(NOW + n * MINUTE_MS).toISOString(),
});

const row = (stored: ChatMessage): Row => ({
  kind: "message",
  key: stored.id,
  side: "theirs",
  at: Date.parse(stored.created_at),
  endsRun: true,
  startsRun: true,
  message: stored,
});

/** The thread's rows: `below` (local bubbles, a heading) first, as the list draws them, then the newest stored message. */
type Props = { generation: number; newestStored: string | undefined; below?: Row[] };

const rowsOf = ({ newestStored, below = [] }: Props): Row[] => {
  const newest = newestStored
    ? [message(0)].map((stored) => row({ ...stored, id: newestStored }))
    : [];
  return [...below, ...newest];
};

async function renderVisible(initial: Props) {
  return renderHook((props: Props) => useNewestVisible(props.generation, rowsOf(props), INSET), {
    initialProps: initial,
  });
}

type Rendered = Awaited<ReturnType<typeof renderVisible>>;

/** What the list reports on screen, through `rule` only, or through every rule. */
const report = (rendered: Rendered, shown: ChatMessage[], rule?: number) =>
  act(async () => {
    const tokens = shown.map((stored, index) => ({
      item: row(stored),
      key: stored.id,
      index,
      isViewable: true,
    }));
    rendered.result.current.pairs.forEach((pair, index) => {
      if (rule === undefined || rule === index) {
        pair.onViewableItemsChanged({ viewableItems: tokens, changed: tokens });
      }
    });
  });

const scrollTo = (rendered: Rendered, y: number) =>
  act(async () =>
    rendered.result.current.onScroll({
      nativeEvent: { contentOffset: { x: 0, y } },
    } as NativeSyntheticEvent<NativeScrollEvent>),
  );

/** The list's viewport lays out at `height` dp (its rows have not yet). */
const measure = (rendered: Rendered, height: number) =>
  act(async () =>
    rendered.result.current.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 320, height } },
    } as LayoutChangeEvent),
  );

describe("useNewestVisible (#74 round 1)", () => {
  it("at the bottom, the newest stored message is the one on screen", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: message(5).id });
    // The viewport not measured yet: unknown, so not seen (#74 Vault round 1).
    expect(rendered.result.current.newest).toBeUndefined();

    await measure(rendered, 400);
    expect(rendered.result.current.newest).toBe(message(5).id);
  });

  it("up in the history, only what the list reports counts", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: message(5).id });
    await scrollTo(rendered, 300);
    expect(rendered.result.current.newest).toBeUndefined();

    await report(rendered, [message(2), message(3)]);
    expect(rendered.result.current.newest).toBe(message(3).id);
  });

  it("the newest of what either rule reports, local bubbles and day headings left out", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: message(9).id });
    await scrollTo(rendered, 300);
    await report(rendered, [message(2)], 0);
    await report(rendered, [message(4)], 1);
    await act(async () => {
      const tokens = [
        { item: { kind: "day", key: "day-x", at: NOW }, key: "day-x", index: 0, isViewable: true },
        {
          item: {
            kind: "message",
            key: "local-1-1",
            side: "mine",
            at: NOW,
            endsRun: true,
            startsRun: true,
            pending: { localId: "1-1", body: "Local", at: NOW, state: "failed" },
          },
          key: "local-1-1",
          index: 1,
          isViewable: true,
        },
      ];
      rendered.result.current.pairs[0]?.onViewableItemsChanged({
        viewableItems: tokens,
        changed: tokens,
      });
    });

    expect(rendered.result.current.newest).toBe(message(4).id);
  });

  it("back at the bottom, the newest stored message again", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: message(5).id });
    await measure(rendered, 400);
    await scrollTo(rendered, 300);
    await report(rendered, [message(2)]);
    await scrollTo(rendered, 0);

    expect(rendered.result.current.newest).toBe(message(5).id);
  });

  it("what the list reported for one session counts for nothing in the next", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: message(5).id });
    await scrollTo(rendered, 300);
    await report(rendered, [message(5)]);
    expect(rendered.result.current.newest).toBe(message(5).id);

    // The next session, its thread not held yet: nothing is on screen for it.
    await rendered.rerender({ generation: 2, newestStored: undefined });
    expect(rendered.result.current.newest).toBeUndefined();

    // Its own list scrolled up, reporting nothing yet: still nothing, never the old report.
    await rendered.rerender({ generation: 2, newestStored: message(5).id });
    await scrollTo(rendered, 300);
    expect(rendered.result.current.newest).toBeUndefined();
  });

  it("keeps the same pairs for the list across renders", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: undefined });
    const first = rendered.result.current.pairs;
    await rendered.rerender({ generation: 2, newestStored: message(1).id });

    expect(rendered.result.current.pairs).toBe(first);
  });
});

/** A local bubble (pending or failed) as the list draws it, below every stored message. */
const local = (n: number): Row => ({
  kind: "message",
  key: `local-1-${n}`,
  side: "mine",
  at: NOW,
  endsRun: true,
  startsRun: true,
  pending: { localId: `1-${n}`, body: `Local ${n}`, at: NOW, state: "failed" },
});

/** The list and its rows lay out: the viewport's height, then each row's, by key. */
const layOut = (rendered: Rendered, viewport: number, heights: Record<string, number>) =>
  act(async () => {
    rendered.result.current.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 320, height: viewport } },
    } as LayoutChangeEvent);
    for (const [key, height] of Object.entries(heights)) {
      rendered.result.current.onRowLayout(key)({
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height } },
      } as LayoutChangeEvent);
    }
  });

describe("useNewestVisible (#74 round 2): local bubbles below the newest message", () => {
  const newest = message(5);

  it("a failed bubble taller than the list covers it: unseen at the bottom until the list reports it", async () => {
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    await layOut(rendered, 400, { [local(1).key]: 600, [newest.id]: 60 });
    expect(rendered.result.current.newest).toBeUndefined();

    await report(rendered, [newest]);
    expect(rendered.result.current.newest).toBe(newest.id);
  });

  it("several short failed bubbles leave it room: seen from the layouts, without a scroll", async () => {
    const below = [local(1), local(2), local(3)];
    const rendered = await renderVisible({ generation: 1, newestStored: newest.id, below });
    // Before the rows lay out the answer is unknown, so not seen.
    expect(rendered.result.current.newest).toBeUndefined();

    await layOut(rendered, 400, {
      [local(1).key]: 60,
      [local(2).key]: 60,
      [local(3).key]: 60,
      [newest.id]: 60,
    });
    expect(rendered.result.current.newest).toBe(newest.id);
  });

  it("follows the layouts: a bubble that grows to cover it takes the shortcut away", async () => {
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    await layOut(rendered, 400, { [local(1).key]: 80, [newest.id]: 60 });
    expect(rendered.result.current.newest).toBe(newest.id);

    await layOut(rendered, 400, { [local(1).key]: 390 });
    expect(rendered.result.current.newest).toBeUndefined();
  });

  it("counts the list's padding under the first row", async () => {
    // 400 - 16 - 304 leaves 80 of a 160 dp message: exactly half, seen. 4 dp more covered: not.
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    await layOut(rendered, 400, { [local(1).key]: 304, [newest.id]: 160 });
    expect(rendered.result.current.newest).toBe(newest.id);

    await layOut(rendered, 400, { [local(1).key]: 308 });
    expect(rendered.result.current.newest).toBeUndefined();
  });

  it("a message taller than the list is seen once it fills half of it", async () => {
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    // 400 - 16 - 100 = 284 of a 900 dp message on screen: over half the list.
    await layOut(rendered, 400, { [local(1).key]: 100, [newest.id]: 900 });

    expect(rendered.result.current.newest).toBe(newest.id);
  });

  it("with no local bubble the newest message is seen once the list measures, before its row", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: newest.id });
    expect(rendered.result.current.newest).toBeUndefined();

    // The whole room is free: the message fits it or fills it, whatever its height.
    await measure(rendered, 400);
    expect(rendered.result.current.newest).toBe(newest.id);
  });

  it("up in the history the layouts never certify it: only the reports count", async () => {
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    await layOut(rendered, 400, { [local(1).key]: 60, [newest.id]: 60 });
    await scrollTo(rendered, 300);

    expect(rendered.result.current.newest).toBeUndefined();
  });

  it("one of my messages on screen certifies nothing: the hidden reply above it stays unseen", async () => {
    const mine = row({ ...message(6), sender: "me" });
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1), mine],
    });
    // 400 - 16 - 300 leaves my 60 dp message 84 dp: on screen; the reply above it is not.
    await layOut(rendered, 400, { [local(1).key]: 300, [mine.key]: 60, [newest.id]: 60 });
    expect(rendered.result.current.newest).toBeUndefined();

    // Reported on screen through the list, mine still counts for nothing.
    await report(rendered, [{ ...message(6), sender: "me" }]);
    expect(rendered.result.current.newest).toBeUndefined();
  });

  it("with no local bubble, my own tall message below the reply is measured too", async () => {
    const mine = row({ ...message(6), sender: "me" });
    const rendered = await renderVisible({ generation: 1, newestStored: newest.id, below: [mine] });
    expect(rendered.result.current.newest).toBeUndefined();

    await layOut(rendered, 400, { [mine.key]: 700, [newest.id]: 60 });
    expect(rendered.result.current.newest).toBeUndefined();

    await layOut(rendered, 400, { [mine.key]: 120 });
    expect(rendered.result.current.newest).toBe(newest.id);
  });

  it("a day heading between the bubbles and the reply is measured with them", async () => {
    const heading: Row = { kind: "day", key: "day-local-1-1", at: NOW };
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1), heading],
    });
    await layOut(rendered, 400, { [local(1).key]: 300, [newest.id]: 60 });
    // The heading has not laid out yet: unknown, not seen.
    expect(rendered.result.current.newest).toBeUndefined();

    await layOut(rendered, 400, { [heading.key]: 60 });
    // 400 - 16 - 300 - 60 = 24 of 60 dp: under half.
    expect(rendered.result.current.newest).toBeUndefined();

    await layOut(rendered, 400, { [heading.key]: 20 });
    expect(rendered.result.current.newest).toBe(newest.id);
  });
});

describe("useNewestVisible (#74 Vault round 1): seen needs pixels on screen", () => {
  const newest = message(5);

  it.each([0, 8, 16])(
    "a %i dp viewport, no more than the list's padding, shows nothing until it grows",
    async (viewport) => {
      const rendered = await renderVisible({ generation: 1, newestStored: newest.id });
      await measure(rendered, viewport);
      expect(rendered.result.current.newest).toBeUndefined();
      await layOut(rendered, viewport, { [newest.id]: 60 });
      expect(rendered.result.current.newest).toBeUndefined();

      // The keyboard goes down: the list grows and the reply shows.
      await measure(rendered, 400);
      expect(rendered.result.current.newest).toBe(newest.id);

      // The keyboard and a tall composer again: hidden, nothing new is seen.
      await measure(rendered, viewport);
      expect(rendered.result.current.newest).toBeUndefined();
    },
  );

  it("a zero viewport shows nothing, even with the rows below it measured", async () => {
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    await layOut(rendered, 0, { [local(1).key]: 80, [newest.id]: 60 });
    expect(rendered.result.current.newest).toBeUndefined();

    await measure(rendered, 400);
    expect(rendered.result.current.newest).toBe(newest.id);
  });

  it("a small room waits for the message's height, then applies the seen rules", async () => {
    const rendered = await renderVisible({
      generation: 1,
      newestStored: newest.id,
      below: [local(1)],
    });
    // 100 - 16 - 60 leaves 24 dp: under half the list, so it depends on the message.
    await layOut(rendered, 100, { [local(1).key]: 60 });
    expect(rendered.result.current.newest).toBeUndefined();

    await layOut(rendered, 100, { [newest.id]: 20 });
    expect(rendered.result.current.newest).toBe(newest.id);

    // 24 of 60 dp, and under half the list: not seen.
    await layOut(rendered, 100, { [newest.id]: 60 });
    expect(rendered.result.current.newest).toBeUndefined();
  });

  it("a message that lays out with no height is never seen at the bottom", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: newest.id });
    await layOut(rendered, 400, { [newest.id]: 0 });

    expect(rendered.result.current.newest).toBeUndefined();
  });
});
