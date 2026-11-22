import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { PixelRatio, View, type LayoutChangeEvent } from "react-native";
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
  /** The image's design width in dp: the content is laid out at it, then drawn 3x or more. */
  baseWidth: number;
  /** The folder of the app's private cache the PNGs go to, and their names' start. */
  dirName: string;
  prefix: string;
  /** What to draw, laid out at `baseWidth`. Nothing in it may load late (no remote image). */
  children: ReactNode;
  testID?: string;
};

/**
 * A view off screen (left of the window, inert and hidden from assistive technology) with
 * `capture()` on its ref: a PNG in the app's private cache (`shareCapture.ts`). Its content is laid
 * out at `baseWidth`, like on a phone, and drawn scaled up to the width the pixel density needs,
 * so the text in the PNG is as sharp as the rest at 3x on any screen. For content that is ready
 * when drawn; the ID card, which waits for its photo, has `IdCardShareRender`.
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
  const scale = width / baseWidth;
  // The content's own height at `baseWidth`; the capture is that times the scale. The content is
  // placed absolutely so the capture's height (0 before the first layout) never squeezes it.
  const [height, setHeight] = useState(0);
  const onContentLayout = (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height);
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
      <ViewShot ref={shot} options={PNG_CAPTURE} style={{ width, height: height * scale }}>
        <View
          onLayout={onContentLayout}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: baseWidth,
            transformOrigin: "top left",
            transform: [{ scale }],
          }}
          testID={testID ? `${testID}-content` : undefined}
        >
          {children}
        </View>
      </ViewShot>
    </View>
  );
}
