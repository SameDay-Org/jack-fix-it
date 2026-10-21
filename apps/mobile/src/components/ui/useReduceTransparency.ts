import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * The live value of the system Reduce Transparency setting. The query is iOS-only: where it does
 * not exist (Android) the setting reads as off, and the value follows `reduceTransparencyChanged`.
 */
export function useReduceTransparency(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const query = AccessibilityInfo.isReduceTransparencyEnabled;
    if (typeof query === "function") {
      query()
        .then((value) => active && setEnabled(value))
        .catch(() => active && setEnabled(false));
    }
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setEnabled,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return enabled;
}
