import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Image, PixelRatio, View } from "react-native";
import ViewShot, { type CaptureOptions, type ViewShotRef } from "react-native-view-shot";

import { IdCard, type IdCardProps } from "./IdCard";

export type IdCardShareCapture = {
  /** A PNG in a temporary file, for the share sheet. */
  uri: string;
  /** Its pixel size: at least 3x the design width. */
  width: number;
  height: number;
};

export type IdCardShareHandle = {
  /** Renders the card to a PNG, once its photo (if any) has loaded. */
  capture: () => Promise<IdCardShareCapture>;
};

export type IdCardShareRenderProps = Pick<
  IdCardProps,
  "variant" | "name" | "city" | "state" | "photoUri" | "publicCode"
> & {
  ref?: Ref<IdCardShareHandle>;
  testID?: string;
};

/** The shared image's design width in dp; the PNG is this times the ratio below, or more. */
export const ID_CARD_SHARE_BASE_WIDTH = 320;
/** The least pixel ratio of the PNG: crisp when another app shows it full width. */
export const ID_CARD_SHARE_MIN_RATIO = 3;
/** Clears the card from the screen's left edge whatever its parent's inset. */
const OFFSCREEN_GAP = 64;

const CAPTURE: CaptureOptions = { format: "png", quality: 1, result: "tmpfile" };
const NOT_MOUNTED = "IdCardShareRender is not mounted";

type Waiter = { resolve: () => void; reject: (error: Error) => void };

/**
 * The width to lay the card out at, in dp, so that the native capture comes out at
 * `ID_CARD_SHARE_MIN_RATIO` pixels per design dp on a 1x or 2x screen, and at the screen's own
 * density above that. `react-native-view-shot` renders at the device density and only resizes
 * (#251), so the extra pixels must come from the layout, never from scaling the bitmap up.
 */
export function idCardShareLayoutWidth(pixelRatio: number): number {
  return (ID_CARD_SHARE_BASE_WIDTH * Math.max(ID_CARD_SHARE_MIN_RATIO, pixelRatio)) / pixelRatio;
}

/**
 * The `shareable` card laid out off screen (left of the window, inert and hidden from assistive
 * technology) at the width the pixel density needs, with `capture()` on its ref. Mount it next to
 * the on-screen card and call `capture()` when the person taps Share.
 */
export function IdCardShareRender({
  ref,
  variant,
  name,
  city,
  state,
  photoUri,
  publicCode,
  testID,
}: IdCardShareRenderProps) {
  const width = idCardShareLayoutWidth(PixelRatio.get());
  const shot = useRef<ViewShotRef>(null);
  // The URI whose load finished (or failed), and the captures waiting for the current one.
  const loadedUri = useRef<string | undefined>(undefined);
  const waiting = useRef<Waiter[]>([]);

  const onPhotoLoadEnd = useCallback(() => {
    loadedUri.current = photoUri;
    for (const waiter of waiting.current.splice(0)) waiter.resolve();
  }, [photoUri]);

  // A capture waits for the photo it was asked with. Without a photo there is nothing to wait for,
  // so a photo taken away mid-wait lets the capture go on; an unmount fails it instead of leaving
  // the caller hanging.
  useEffect(() => {
    if (photoUri) return;
    for (const waiter of waiting.current.splice(0)) waiter.resolve();
  }, [photoUri]);
  useEffect(() => {
    const pending = waiting.current;
    return () => {
      for (const waiter of pending.splice(0)) waiter.reject(new Error(NOT_MOUNTED));
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      capture: async () => {
        if (photoUri && loadedUri.current !== photoUri) {
          await new Promise<void>((resolve, reject) => waiting.current.push({ resolve, reject }));
        }
        const target = shot.current;
        if (!target) throw new Error(NOT_MOUNTED);
        const uri = await target.capture();
        const size = await Image.getSize(uri);
        return { uri, width: size.width, height: size.height };
      },
    }),
    [photoUri],
  );

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
      style={{ position: "absolute", top: 0, left: -(width + OFFSCREEN_GAP), width }}
    >
      <ViewShot ref={shot} options={CAPTURE}>
        <IdCard
          shareable
          variant={variant}
          width={width}
          name={name}
          city={city}
          state={state}
          photoUri={photoUri}
          publicCode={publicCode}
          onPhotoLoadEnd={onPhotoLoadEnd}
          testID={testID ? `${testID}-card` : undefined}
        />
      </ViewShot>
    </View>
  );
}
