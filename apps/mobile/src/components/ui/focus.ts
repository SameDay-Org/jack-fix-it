import { AccessibilityInfo, findNodeHandle } from "react-native";

/**
 * Moves screen-reader focus to a mounted host component: a screen's title once a transition has
 * settled, so the reader starts where the eye does and announces nothing twice.
 */
export function moveAccessibilityFocus(instance: Parameters<typeof findNodeHandle>[0]): void {
  const tag = findNodeHandle(instance);
  if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
}
