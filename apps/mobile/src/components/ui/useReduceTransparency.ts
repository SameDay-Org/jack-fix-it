import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** `null` until the system has answered; callers show the solid fallback meanwhile. */
export type ReduceTransparency = boolean | null;

/**
 * The live value of the system Reduce Transparency setting. Unknown at first, so nothing renders
 * glass before the preference is known. A `reduceTransparencyChanged` event always wins over the
 * initial read, which can arrive late; a failed read counts as on (the safe value).
 */
export function useReduceTransparency(): ReduceTransparency {
  // Unknown until the system answers; off where the iOS-only query does not exist (Android).
  const [enabled, setEnabled] = useState<ReduceTransparency>(() =>
    typeof AccessibilityInfo.isReduceTransparencyEnabled === "function" ? null : false,
  );

  useEffect(() => {
    let active = true;
    let settledByEvent = false;
    // Subscribe first, so a change between the read and its answer is not missed.
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (value) => {
        settledByEvent = true;
        if (active) setEnabled(value);
      },
    );
    const query = AccessibilityInfo.isReduceTransparencyEnabled;
    if (typeof query === "function") {
      query().then(
        (value) => active && !settledByEvent && setEnabled(value),
        () => active && !settledByEvent && setEnabled(true),
      );
    }
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
