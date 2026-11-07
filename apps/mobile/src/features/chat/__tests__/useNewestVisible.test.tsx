import { act, renderHook } from "@testing-library/react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import type { ChatMessage, Row } from "../thread";
import { useNewestVisible } from "../useNewestVisible";

const NOW = Date.UTC(2026, 10, 7, 15, 0, 0);
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

type Props = { generation: number; newestStored: string | undefined };

async function renderVisible(initial: Props) {
  return renderHook(
    ({ generation, newestStored }: Props) => useNewestVisible(generation, newestStored),
    { initialProps: initial },
  );
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

describe("useNewestVisible (#74 round 1)", () => {
  it("at the bottom, the newest stored message is the one on screen", async () => {
    const rendered = await renderVisible({ generation: 1, newestStored: message(5).id });

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
