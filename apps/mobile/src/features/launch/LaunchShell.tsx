import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { ToastHost } from "@/components/ui";
import { SessionGate } from "@/features/auth";
import { tokens } from "@/theme";

import { LaunchIntro } from "./LaunchIntro";
import { liftSplash } from "./splash";

/**
 * What the root layout shows: the session gate, with the toasts over it, under the launch intro.
 * While the intro owns the screen the covered content is hidden from assistive technology, so a
 * screen reader finds one headline and the Skip control. The native splash is released on every
 * path: the intro's first final frame, its exit (any reason), and a guard here at `launchMaxMs`
 * at the latest, independent of the intro's lifecycle.
 */
export function LaunchShell() {
  const [introShown, setIntroShown] = useState(true);
  const endIntro = useCallback(() => {
    liftSplash();
    setIntroShown(false);
  }, []);

  useEffect(() => {
    const guard = setTimeout(liftSplash, tokens.motion.launchMaxMs);
    return () => clearTimeout(guard);
  }, []);

  return (
    <>
      <View
        className="flex-1"
        importantForAccessibility={introShown ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={introShown}
        testID="launch-shell-content"
      >
        <SessionGate />
        <ToastHost />
      </View>
      {introShown ? <LaunchIntro onReady={liftSplash} onDone={endIntro} /> : null}
    </>
  );
}
