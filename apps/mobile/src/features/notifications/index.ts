// `listenForPushTaps` is imported by its path (`@/features/notifications/listen`) from the root
// layout alone: the barrel keeps the native module out of every screen that opens pushes.
export { ALLOWED_PUSH_PATHS, parsePushLink, pushRoute } from "./deepLinks";
export type { PushLink, PushPath } from "./deepLinks";
export { receivePushTap } from "./pushTaps";
export { openPushTap, useOpenPushTaps } from "./useOpenPushTaps";
