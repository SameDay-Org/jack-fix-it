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

export const setRisePhase = (phase: RisePhase): void => panelHandoffStore.setState({ phase });
export const setPanelBar = (bar: SystemBar): void => panelHandoffStore.setState({ bar });

export const usePanelHandoff = (): PanelHandoffState =>
  useStore(
    panelHandoffStore,
    useShallow((state) => ({ phase: state.phase, bar: state.bar })),
  );
