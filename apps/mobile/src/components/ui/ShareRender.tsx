import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { PixelRatio, View } from "react-native";
import ViewShot, { type ViewShotRef } from "react-native-view-shot";

import {
  capturePrivatePng,
  OFFSCREEN_GAP,
  PNG_CAPTURE,
  shareLayoutWidth,
  type ShareHandle,
} from "./shareCapture";

export type ShareRenderProps = {
  ref?: Ref<ShareHandle>;
  /** The image's design width in dp; it is laid out wider so the PNG is 3x or more. */
  baseWidth: number;
  /** The folder of the app's private cache the PNGs go to, and their names' start. */
  dirName: string;
  prefix: string;
  /** What to draw, at the width it is laid out at. Nothing in it may load late (no remote image). */
  children: (width: number) => ReactNode;
  testID?: string;
};

/**
 * A view laid out off screen (left of the window, inert and hidden from assistive technology) at
 * the width the pixel density needs, with `capture()` on its ref: a PNG in the app's private cache
 * (`shareCapture.ts`). For content that is ready when drawn; the ID card, which waits for its
 * photo, has `IdCardShareRender`.
 */
export function ShareRender({
  ref,
  baseWidth,
  dirName,
  prefix,
  children,
  testID,
}: ShareRenderProps) {
  const width = shareLayoutWidth(baseWidth, PixelRatio.get());
  const shot = useRef<ViewShotRef>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => capturePrivatePng(shot.current, dirName, prefix, () => mounted.current),
    }),
    [dirName, prefix],
  );

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
      style={{ position: "absolute", top: 0, left: -(width + OFFSCREEN_GAP), width }}
    >
      <ViewShot ref={shot} options={PNG_CAPTURE}>
        {children(width)}
      </ViewShot>
    </View>
  );
}
