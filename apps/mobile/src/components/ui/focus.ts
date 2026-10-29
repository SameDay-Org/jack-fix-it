import { AccessibilityInfo, findNodeHandle } from "react-native";

/**
 * Moves screen-reader focus to a mounted host component: a screen's title once a transition has
 * settled, so the reader starts where the eye does and announces nothing twice.
 */
export function moveAccessibilityFocus(instance: Parameters<typeof findNodeHandle>[0]): void {
  const tag = findNodeHandle(instance);
  if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
}

/**
 * Speaks a message without moving focus: a notice that appeared away from it, a counter reaching
 * its limit. Queued on iOS so it follows what VoiceOver is saying instead of cutting it off;
 * Android has no queue option and speaks it through TalkBack's announcement.
 */
export function announce(message: string): void {
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
}
