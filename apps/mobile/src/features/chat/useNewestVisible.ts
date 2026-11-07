import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlatListProps,
  LayoutChangeEvent,
  ListViewToken,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";

import type { ChatMessage, Row } from "./thread";

export type VisibilityPairs = NonNullable<FlatListProps<Row>["viewabilityConfigCallbackPairs"]>;
export type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
export type LayoutHandler = (event: LayoutChangeEvent) => void;

// A message counts as seen once half of it is on screen, or, when it is taller than the list
// leaves room for, once it fills half the list: either rule, whichever it meets.
const SEEN_PERCENT = 50;
const SEEN_RULES = [
  { itemVisiblePercentThreshold: SEEN_PERCENT },
  { viewAreaCoveragePercentThreshold: SEEN_PERCENT },
];
const PERCENT = 100;

// The list sits at the newest message while it is scrolled no further than this from its start
// (the bottom, the list being upside down).
const AT_NEWEST_WITHIN = 1;

type Seen = { generation: number; byRule: readonly ChatMessage[][] };
type AtNewest = { generation: number; at: boolean };
/** Heights in dp: the list's viewport, and each row by key, as they last laid out. */
type Geometry = { viewport: number | undefined; rows: Readonly<Record<string, number>> };

const storedMessages = (tokens: ListViewToken[]): ChatMessage[] =>
  tokens.flatMap(({ item, isViewable }) => {
    // The list's items are its rows (the token types them loosely).
    const row: Row = item;
    // Only the other side's messages count unread: one of mine on screen certifies nothing above
    // it (#74 round 2).
    return isViewable && row.kind === "message" && row.message && row.message.sender !== "me"
      ? [row.message]
      : [];
  });

/** The newer of two stored messages, in the API's order: time, then id. */
const newer = (a: ChatMessage, b: ChatMessage): ChatMessage => {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (at !== 0) return at > 0 ? a : b;
  return a.id > b.id ? a : b;
};

/**
 * Whether the newest message from the other side is on screen with the list at its bottom, behind
 * the rows drawn below it (`below`: pending or failed bubbles, my own messages, a day heading;
 * often none) and the list's own padding under its first row (`inset`), by the seen rules.
 * Unknown until the viewport and every row below have laid out: then false, never a guess. It
 * always needs real pixels of the message on screen: a viewport collapsed to its padding or less
 * (the keyboard and a tall composer on a small screen) shows nothing, whatever is below it (#74
 * Vault round 1).
 */
function shownAtBottom(
  geometry: Geometry,
  below: readonly Row[],
  newestKey: string,
  inset: number,
): boolean {
  const { viewport } = geometry;
  if (viewport === undefined || viewport <= 0) return false;
  let covered = inset;
  for (const row of below) {
    const rowHeight = geometry.rows[row.key];
    if (rowHeight === undefined) return false;
    covered += rowHeight;
  }
  // What the viewport leaves the message, right above what is drawn below it.
  const room = viewport - covered;
  if (room <= 0) return false;
  const fillsView = (shown: number) => shown * PERCENT >= viewport * SEEN_PERCENT;
  const height = geometry.rows[newestKey];
  // Not laid out yet: it either fits the room (all of it shows) or fills it, so a room that is
  // half the viewport answers both ways; a smaller one waits for the message's height.
  if (height === undefined) return fillsView(room);
  if (height <= 0) return false;
  const shown = Math.min(height, room);
  return shown * PERCENT >= height * SEEN_PERCENT || fillsView(shown);
}

/**
 * The newest stored message on screen in the chat's list (#74 rounds 1 and 2): what the read
 * marker may mark up to. Two sources, as the list can tell:
 *
 * Only the other side's messages count, as only they count unread: marking up to one of mine
 * would mark every message of theirs above it, seen or not.
 *
 * - At the bottom (`onScroll` reports the list at its start), the newest message from the other
 *   side (its first such row in `rows`) is on screen when the list's padding and the rows below
 *   it, if any (local bubbles, which the list puts first, and my own messages), leave it room in
 *   the measured viewport by the seen rules, as
 *   the rows' and the list's layouts measure (`onRowLayout`, `onLayout`). The list's viewability
 *   cannot say so on its own: after a message lands at the bottom it reports nothing until the
 *   next scroll, and a chat that fits on screen never scrolls; a layout comes with every new or
 *   resized row, so the answer follows without a scroll. A tall failed bubble that covers the
 *   message keeps it unseen until the list reports it.
 * - Otherwise, what the list's viewability reports (`pairs`, given to the FlatList once: it
 *   refuses pairs that change). A local bubble or a day heading never counts.
 *
 * What the list reported under another session generation counts for nothing: a new session
 * starts at the bottom of its own list and sees only what that list reports.
 */
export function useNewestVisible(
  generation: number,
  rows: readonly Row[],
  /** The list's padding under its first row, in dp. */
  inset = 0,
): {
  newest: string | undefined;
  pairs: VisibilityPairs;
  onScroll: ScrollHandler;
  onLayout: LayoutHandler;
  onRowLayout: (key: string) => LayoutHandler;
} {
  const [seen, setSeen] = useState<Seen>({ generation, byRule: SEEN_RULES.map(() => []) });
  const [atNewest, setAtNewest] = useState<AtNewest>({ generation, at: true });
  const [geometry, setGeometry] = useState<Geometry>({ viewport: undefined, rows: {} });
  const current = useRef(generation);
  useEffect(() => {
    current.current = generation;
  }, [generation]);

  const [pairs] = useState<VisibilityPairs>(() =>
    SEEN_RULES.map((viewabilityConfig, rule) => ({
      viewabilityConfig,
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ListViewToken[] }) => {
        const shown = storedMessages(viewableItems);
        setSeen((previous) => {
          const base =
            previous.generation === current.current
              ? previous.byRule
              : SEEN_RULES.map((): ChatMessage[] => []);
          return {
            generation: current.current,
            byRule: base.map((messages, index) => (index === rule ? shown : messages)),
          };
        });
      },
    })),
  );

  const onScroll = useCallback<ScrollHandler>(({ nativeEvent }) => {
    const at = nativeEvent.contentOffset.y <= AT_NEWEST_WITHIN;
    // A new state only when the answer changes: no render for every frame of a scroll.
    setAtNewest((previous) =>
      previous.generation === current.current && previous.at === at
        ? previous
        : { generation: current.current, at },
    );
  }, []);

  // A new state only when a height changes: a row lays out again on every list render.
  const onLayout = useCallback<LayoutHandler>(({ nativeEvent }) => {
    const viewport = nativeEvent.layout.height;
    setGeometry((previous) =>
      previous.viewport === viewport ? previous : { ...previous, viewport },
    );
  }, []);
  const onRowLayout = useCallback(
    (key: string): LayoutHandler =>
      ({ nativeEvent }) => {
        const height = nativeEvent.layout.height;
        setGeometry((previous) =>
          previous.rows[key] === height
            ? previous
            : { ...previous, rows: { ...previous.rows, [key]: height } },
        );
      },
    [],
  );

  const reported =
    seen.generation === generation
      ? seen.byRule
          .flat()
          .reduce<ChatMessage | undefined>(
            (found, message) => (found ? newer(found, message) : message),
            undefined,
          )?.id
      : undefined;
  const bottom = atNewest.generation === generation ? atNewest.at : true;
  const newestIndex = rows.findIndex(
    (row) => row.kind === "message" && row.message && row.message.sender !== "me",
  );
  const newestRow = rows[newestIndex];
  const newestStored = newestRow?.kind === "message" ? newestRow.message?.id : undefined;
  const below = newestIndex > 0 ? rows.slice(0, newestIndex) : [];
  const shown =
    bottom &&
    newestStored !== undefined &&
    newestRow !== undefined &&
    shownAtBottom(geometry, below, newestRow.key, inset);
  return { newest: shown ? newestStored : reported, pairs, onScroll, onLayout, onRowLayout };
}
