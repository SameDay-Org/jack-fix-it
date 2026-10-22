import { makeMutable } from "react-native-reanimated";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

import type { SystemBar } from "@/components/ui";

/**
 * Where Welcome's panel is: `idle` at rest (or reached any other way), `rising` while it moves,
 * `risen` once it covers the screen (immediately under Reduce Motion, which has no rise).
 */
export type RisePhase = "idle" | "rising" | "risen";

type PanelHandoffState = {
  phase: RisePhase;
  /** The system bar the panel calls for: the destination mirrors it until its content is in. */
  bar: SystemBar;
};

/**
 * What Welcome tells the screen its panel becomes (Role or Login). The destination can be mounted
 * while the panel still rises; it shows its content only once the panel has settled, and until
 * then its status bar follows the panel's.
 */
export const panelHandoffStore = createStore<PanelHandoffState>()(() => ({
  phase: "idle",
  bar: "hero",
}));

/**
 * The panel's motion, shared on the UI thread: 0 at rest, 1 covering the screen, and how far its
 * top edge travels (dp from the top of the window). Welcome drives them; on Android the destination
 * rides them, so its page and content arrive in the very frames the panel does.
 */
export const panelProgress = makeMutable(0);
export const panelTravel = makeMutable(0);

/**
 * Where the destination's content starts to show on the rising panel: Welcome's own actions have
 * faded out over the first half of the rise by then.
 */
export const CONTENT_FROM = 0.5;

export const setRisePhase = (phase: RisePhase): void => panelHandoffStore.setState({ phase });
export const setPanelBar = (bar: SystemBar): void => panelHandoffStore.setState({ bar });

export const usePanelHandoff = (): PanelHandoffState =>
  useStore(
    panelHandoffStore,
    useShallow((state) => ({ phase: state.phase, bar: state.bar })),
  );
