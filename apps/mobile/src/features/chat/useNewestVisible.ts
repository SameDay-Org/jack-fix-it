import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlatListProps,
  ListViewToken,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";

import type { ChatMessage, Row } from "./thread";

export type VisibilityPairs = NonNullable<FlatListProps<Row>["viewabilityConfigCallbackPairs"]>;
export type ScrollHandler = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

// A message counts as seen once half of it is on screen, or, when it is taller than the list
// leaves room for, once it fills half the list: either rule, whichever it meets.
const SEEN_RULES = [{ itemVisiblePercentThreshold: 50 }, { viewAreaCoveragePercentThreshold: 50 }];

// The list sits at the newest message while it is scrolled no further than this from its start
// (the bottom, the list being upside down).
const AT_NEWEST_WITHIN = 1;

type Seen = { generation: number; byRule: readonly ChatMessage[][] };
type AtNewest = { generation: number; at: boolean };

const storedMessages = (tokens: ListViewToken[]): ChatMessage[] =>
  tokens.flatMap(({ item, isViewable }) => {
    // The list's items are its rows (the token types them loosely).
    const row: Row = item;
    return isViewable && row.kind === "message" && row.message ? [row.message] : [];
  });

/** The newer of two stored messages, in the API's order: time, then id. */
const newer = (a: ChatMessage, b: ChatMessage): ChatMessage => {
  const at = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (at !== 0) return at > 0 ? a : b;
  return a.id > b.id ? a : b;
};

/**
 * The newest stored message on screen in the chat's list (#74 round 1): what the read marker may
 * mark up to. Two sources, as the list can tell:
 *
 * - At the bottom (`onScroll` reports the list at its start), the newest message of the thread
 *   (`newestStored`) is on screen: the list opens there and follows a new message down while it
 *   sits there. The list's viewability cannot say so on its own: after a message lands at the
 *   bottom it reports nothing until the next scroll, and a chat that fits on screen never scrolls.
 * - Up in the history, what the list's viewability reports (`pairs`, given to the FlatList once:
 *   it refuses pairs that change). A local bubble or a day heading never counts.
 *
 * What the list reported under another session generation counts for nothing: a new session
 * starts at the bottom of its own list and sees only what that list reports.
 */
export function useNewestVisible(
  generation: number,
  newestStored: string | undefined,
): { newest: string | undefined; pairs: VisibilityPairs; onScroll: ScrollHandler } {
  const [seen, setSeen] = useState<Seen>({ generation, byRule: SEEN_RULES.map(() => []) });
  const [atNewest, setAtNewest] = useState<AtNewest>({ generation, at: true });
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
  return { newest: bottom ? (newestStored ?? reported) : reported, pairs, onScroll };
}
