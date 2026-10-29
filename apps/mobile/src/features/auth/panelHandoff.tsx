import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { cancelAnimation, makeMutable, type SharedValue } from "react-native-reanimated";
import { useStore, type StoreApi } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

import type { SystemBar } from "@/components/ui";

/**
 * Where Welcome's panel is: `idle` at rest (or reached any other way), `rising` while it moves,
 * `risen` once it covers the screen (immediately under Reduce Motion, which has no rise).
 */
export type RisePhase = "idle" | "rising" | "risen";

export type PanelHandoffState = {
  phase: RisePhase;
  /** The system bar the panel calls for: the destination mirrors it until its content is in. */
  bar: SystemBar;
};

/**
 * What Welcome tells the screen its panel becomes (Role or Login): the phase and the bar, and the
 * panel's motion on the UI thread (0 at rest, 1 covering the screen; how far its top edge travels,
 * in dp from the top of the window). On Android the destination rides that motion, so its page
 * and content arrive in the very frames the panel does.
 */
export type PanelHandoff = {
  store: StoreApi<PanelHandoffState>;
  progress: SharedValue<number>;
  travel: SharedValue<number>;
  /**
   * Writes the progress: a value, or an animation built by the caller. The caller builds it
   * (`withTiming(to, config, (finished) => …)`) so its completion callback stays inline and is
   * made a worklet; this only assigns it.
   */
  setProgress: (next: number) => void;
  setTravel: (next: number) => void;
};

/** A hand-off at rest. One per auth flow (see `PanelHandoffProvider`); tests make their own. */
export function createPanelHandoff(): PanelHandoff {
  const progress = makeMutable(0);
  const travel = makeMutable(0);
  return {
    store: createStore<PanelHandoffState>()(() => ({ phase: "idle", bar: "hero" })),
    progress,
    travel,
    // An animation object is assigned like a value; Reanimated runs it.
    setProgress: (next) => {
      progress.value = next;
    },
    setTravel: (next) => {
      travel.value = next;
    },
  };
}

const PanelHandoffContext = createContext<PanelHandoff | null>(null);

/**
 * Scopes the hand-off to a route group: the `(auth)` layout mounts one for Welcome's panel and the
 * `(app)` layout one for Home's, so a sign-in or a sign-out, which removes the whole group without
 * going back, takes the state with it, and the next Welcome or Home starts from a new hand-off at
 * rest. Module-level values had outlived the group and brought Welcome back fully raised, with no
 * way in.
 */
export function PanelHandoffProvider({
  children,
  value,
}: PropsWithChildren<{
  /** Tests pass their own to drive and read it; the app lets the provider make one. */
  value?: PanelHandoff;
}>) {
  const [handoff] = useState(() => value ?? createPanelHandoff());
  // Nothing of a flow that is gone may keep moving.
  useEffect(() => () => cancelAnimation(handoff.progress), [handoff]);
  return <PanelHandoffContext.Provider value={handoff}>{children}</PanelHandoffContext.Provider>;
}

/** The group's hand-off: `PanelHandoffProvider` in the `(auth)` or the `(app)` layout. */
export function usePanelHandoffContext(): PanelHandoff {
  const handoff = useContext(PanelHandoffContext);
  if (!handoff)
    throw new Error("usePanelHandoffContext needs PanelHandoffProvider ((auth) or (app) layout)");
  return handoff;
}

/** The phase and bar, as render state. */
export function usePanelHandoff(): PanelHandoffState {
  const { store } = usePanelHandoffContext();
  return useStore(
    store,
    useShallow((state) => ({ phase: state.phase, bar: state.bar })),
  );
}

/**
 * Where the destination's content starts to show on the rising panel: Welcome's own actions have
 * faded out over the first half of the rise by then.
 */
export const CONTENT_FROM = 0.5;
