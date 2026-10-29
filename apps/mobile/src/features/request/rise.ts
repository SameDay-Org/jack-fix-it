import { Platform } from "react-native";

import { panelRiseOptions, type PanelRouteOptions } from "@/features/auth";

// Whether the open request flow came in on Home's panel rise. Set by `startRequest`, forgotten with
// the draft. Kept apart from the draft store: the `(app)` layout reads it for its options, and
// the draft registers itself with the session when it loads.
let risen = false;

/** The flow was opened by the rise of Home's categories panel. */
export const flowRisen = (): boolean => risen;

export function setFlowRisen(next: boolean): void {
  risen = next;
}

/**
 * The `(app)` stack's options for the request flow: the panel rise when a category card on Home
 * opened it (see `panelRiseOptions`), the platform's push otherwise (a deep link). Read when the
 * stack renders the flow, which `startRequest` has marked by then; the mark stays until the flow is
 * gone, so its way back is the same. (The route's own params cannot say it: the flow is a group,
 * and its first screen's params never reach the group's route.)
 */
export function requestFlowOptions(): PanelRouteOptions {
  return risen ? panelRiseOptions(Platform.OS) : { animation: "default" };
}
